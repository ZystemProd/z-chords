# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Z-Chords ("Chord Viewer") is a zero-build, dependency-free static web app for visualizing chords and scales on piano, guitar, and a metronome/drums panel. The root `package.json` is a stub — no scripts, no devDependencies, no bundler. Its `"type": "module"` is there only so Node reads the `.js` files as the ES modules they already are (the test runner imports `layout-model.js` directly); it changes nothing at runtime.

## Running

Serve the folder statically (e.g. `python -m http.server 8000`). A static server is **required** — every script is now `type="module"` and ES module imports fail under `file://`. Opening `index.html` directly no longer works.

Third-party libs are loaded from CDN in `index.html` (html2canvas, jsPDF, SortableJS, VexFlow) and attach globals — there is no npm install step.

## Tests

`tests/` holds browser tests — `cd tests && npm install && npm test`. They drive the real app in a real Chrome via `puppeteer-core` and assert **painted geometry**, which is where this app's bugs live: a keyboard whose black keys do not scale with its white keys is not a logic error, and nothing but a browser will catch it. The runner starts its own static server on a free port, so nothing needs to be running first.

The dependency is confined to `tests/` — its own `package.json` and `node_modules`, nothing loaded by `index.html`. The app stays dependency-free.

Three habits `tests/README.md` explains at length, and that this codebase keeps rewarding: assert **ratios rather than sizes** (the black/white key ratio must hold at every width; no absolute measurement catches the bug); assert **both axes** (a horizontal-only pass once stayed green while every keyboard was clipped at the bottom); and assert **what you did not change** (`makePiano` is shared between the board and the layout sheet, so `board.test.mjs` pins the piano tab's numbers).

## Architecture

Three script worlds share one DOM. The first two never call each other; the third is fed by the first through an explicit hand-off:

- **`script.js`** (~3700 lines, ES module) — everything except the guitar *scale* tab and the Layout tab: chord parsing, piano rendering, sections/chord-cards (piano keyboards and guitar diagrams alike), custom-chord modal, drag & drop, theme, tab routing, PDF export, metronome, piano scales.
- **`main.js` + `guitar.js`** (ES modules) — the guitar scale tab only. `main.js` owns the guitar DOM/controls and its own `localStorage`; `guitar.js` is pure logic + SVG generation (`renderScaleSVG`, `computeCAGEDShapes`, `getParentMajorRoot`, `scaleWindow`).
- **`layout.js` + `layout-model.js`** (ES modules) — the Layout tab. `layout.js` owns its DOM; `layout-model.js` is pure data and mm arithmetic. See *Layout sheet* below.

The guitar *chord* tab is not part of that second world: it lives in `script.js` because it shares the board and section state, and pulls its voicings and SVG from `guitar-chords.js`.

Two shared modules sit under both worlds:

- **`theory.js`** — the single source for `NOTES`, `ENHARMONIC`, `CHORD_PATTERNS`, `CHORD_TYPES`, `CHORD_RE`, `SCALE_FORMULAS`, `normalizeRoot`, `noteIndex`. Add or change theory data there, once — do not reintroduce local copies.
- **`audio.js`** — the app's one `AudioContext` plus `playNotes(midis, opts)`. Browsers cap contexts per page, so anything that makes sound calls `getAudioContext()` instead of constructing its own. Each voice is `osc → lowpass → gain → master gain → compressor`; the metronome shares the context but connects straight to the destination so its level is untouched.

  The per-voice low-pass cutoff tracks pitch at `HARMONICS × freq` (clamped 350–6000 Hz) rather than sitting at a fixed frequency, so timbre stays even across the keyboard. `HARMONICS` is 3 for a reason: a triangle wave's partials fall off as 1/n², so a cutoff up at the 7th only touches content already near 1% of the fundamental — measured on rendered audio, that changed the spectrum by under 1%. At the 3rd it cuts the 5th/7th partials by 53%/78%, which is where the harshness actually lives. If you retune it, measure rendered output rather than trusting the graph; `opts.brightness` scales the cutoff.

Note `script.js` is strict mode now that it is a module. Assigning to an undeclared variable throws instead of silently creating a global.

### Guitar chord diagrams

`guitar-chords.js` is pure logic + SVG, like `guitar.js`: it owns no DOM state. Fret arrays are always length 6 ordered **low to high** (string 6 -> string 1, so "x32010" is C) — the reverse of `guitar.js`'s `GUITAR_TUNING`, which runs high-to-low because it draws a horizontal fretboard. Chord boxes are drawn vertically with the low E on the left, which is the standard chart orientation. `null` is a muted string, `0` is open.

Shapes come from a curated library first — open positions, movable E- and A-shape barre forms, the small four-string D-string forms (`F` as `xx3211`, not only the full `133211`), and the extended chords — then a generated fallback so all 53 qualities in `CHORD_PATTERNS` get something. Four constraints in the generator are load-bearing, and every one of them was found by reading the output rather than by reasoning — a voicing can satisfy every rule you thought to write and still be something no guitarist would play:

- `fingerCount` is not one finger per fretted string. A finger laid flat covers several: the index barre at the lowest fret spans the whole neck, and above it a finger still covers a *contiguous run* of strings at one fret (that is how `x13333` is played). Counting naively rejects chords guitarists actually play.
- `fingerCanSpan` is the rule behind both `detectBarre` and `fingerCount`: a flat finger stops **every** string it crosses, so it can only span strings fretted at that fret or higher. An open string underneath is a contradiction. Before this existed, a tenth of all voicings drew the barre bar straight through an open string and counted it as one finger.
- Open strings are only offered within `OPEN_STRING_WINDOW` of the nut. Without that the generator emits things like `13-0-15-14-13-13` — technically playable, since an open string needs no finger, but not a voicing anyone would use.
- `hasBadSpacing` rejects close intervals in the bass. Tight intervals turn to mud down low: `x30330` puts the root and 9th a whole step apart at C3. The thresholds are tiered (`minIntervalAt`) rather than flat, and the tiers are pinned by real chords — open G is `G2-B2-D3`, a close triad in the bass, so thirds must stay legal below G3; open C7 is `x32310`, whose Bb3-C4 is a whole step, so seconds must stay legal below C4. A flat rule rejects one or the other.
- `essentialTones` decides what may be omitted. Six strings cannot hold seven notes, and cramming produces shapes like `877766` for a 13th. The 5th goes first, the 11th goes against a major 3rd (avoid note) unless the chord is named for it, and the 9th is optional on a 13th. What survives is root, 3rd/sus, 7th and the naming extension.

Note the test states the omission rule independently, in its own terms, rather than importing `essentialTones` — otherwise it would only prove the code agrees with itself.

`script.js` owns the DOM side: `buildGuitarCardBody` renders the diagram and shape stepper, `getGuitarVoicings` resolves a stored chord (custom chords go through the pitch-class search since they have no parseable symbol), and the selected shape persists on the chord as `guitarShape`. The speaker button plays the voicing's real string MIDI values, so a barre chord sounds in its actual register.

### Editing a shape by hand

`createChordEditor` is the exception to "owns no DOM state" — it holds the frets being drawn and the in-progress drag, reports committed changes through `onChange`, and knows nothing about sections. On the guitar tab the custom-chord modal swaps `#customPiano` for `#customGuitar` (`showModalInstrument`), seeded from the shape the card is currently showing.

Gestures: click a cell to place or lift a note, press and drag across strings at one fret to lay a barre, click the band above the nut to cycle a string through *its fret → open → muted → the same fret*. The **Start fret** stepper sets which fret the five-row window begins at, which is the only way to reach shapes up the neck. The cycle restores the fret rather than losing it, which is what `lastFret` is for; a string that has never been fretted has nothing to return to and simply toggles open/muted.

Two things in there are easy to get wrong:

- Hit testing is arithmetic on SVG-local coordinates, not per-element listeners, because during a pointer capture the events arrive on the element the drag *started* on. All drawn elements are `pointer-events: none` and transparent hit rects are appended last, so a dot or barre can never swallow a press.
- Saving stores `guitarFrets` and `guitarBarres` **as well as** `customMIDIs`. The notes alone are not enough: several fingerings sound the same pitches, and re-deriving from pitch classes would hand back a different one. `getGuitarVoicings` returns `guitarFrets` verbatim when present.
- **A barre is intent, not geometry.** It cannot be inferred from fret positions: open E is `022100`, and auto-detecting "two adjacent strings share a fret" would draw a bar across its fret 2, which nobody plays that way. So the editor records the bars you actually drag (`barres`) and stores them; library shapes keep the conservative `detectBarre` guess, which only ever considers the *lowest* fret. `validBarres` re-checks bars against the frets on every draw, so editing a string under a bar dissolves it instead of leaving one floating.

A voicing therefore carries `barres` (a list), not a single `barre` — a shape can have the index bar low down and another finger laid across a run above it. That is exactly the case that was broken: with `x,x,0,11,12,12` the lowest fret is 11 on one string, so the old single-barre lookup never even saw the fret-12 run.

Transposition shifts every fret by the same amount, open strings included — a string's pitch is `open + fret`, so that is correct. A shape that would fall off either end of the neck drops the override and reverts to the library rather than being silently mangled.

The curated shapes are verified against `CHORD_PATTERNS` across all 12 roots — no foreign notes, root present, defining tones present — rather than trusted as transcribed.

### Capo

`#guitarCapoControls` is a stepper (0–`MAX_CAPO_FRET`, persisted as `cv-capo`) shown only on guitar→chord. It is deliberately **label only**: diagrams and playback stay at concert pitch, and nothing in `getGuitarVoicings` knows about it. Its one effect is `capoLabel()`, which `pdfHeadings()` adds to the PDF's first-page headings — and only when `currentInstrument === "guitar"`, since a "Capo 3" line on a piano sheet means nothing.

### Chord playback

Each chord card carries a `.play-chord-section` speaker button. `computeChordData(chord)` resolves a stored chord (parsed symbol or `customMIDIs`) into the same `{ notes, rootMidi }` the renderer draws, and `getChordPlaybackMIDIs(chord)` adds the left hand when `twoHandsMode` is on, dedupes, and sorts low→high. Both `renderSections()` and `updatePreviewChord()` go through `computeChordData`, so audio cannot drift from the diagram — keep it that way. Playback recomputes at press time rather than capturing, so inversion changes are picked up.

The button carries `no-drag`, which the chords-container Sortable uses as its `filter` and the section click handler checks — that is what keeps a press from starting a drag or re-selecting the section. It is visible at all times (edit/remove appear only on hover, which is unreachable on touch), so `.pdf-capture .play-chord-section` hides it from the PDF clone. Its `aria-label` uses the raw `chord.sym`, not `formatChordSymbol()`, which returns `<sup>` markup.

### Tab routing

`updateTabsUI()` in `script.js` is the single switchboard: it hides *every* panel and control group, then re-shows the ones for the current `currentInstrument` × `currentSubtab[instrument]` pair. Any new view must be added to both the hide-all defaults and the correct branch, or it will leak across tabs. `setInstrument`/`setSubtab` persist to `cv-instrument` / `cv-subtabs`.

`#guitarStaff` is the one panel with two owners, and it is why `.tab-hidden` exists. `main.js` sets its inline `display` from the scale settings (it wants the staff only in *custom* view mode); `updateTabsUI` decides whether the guitar-scale tab is on screen at all. Neither world can call the other, so they use separate channels: `main.js` keeps the inline style, `script.js` adds/removes `.tab-hidden`, whose `display: none !important` outranks it. Before that the staff followed you onto every tab — piano, drums, everywhere — once custom mode had been switched on. Don't "simplify" it by having `updateTabsUI` set `display` directly: that would show the staff on the scale tab even in scales mode, where `main.js` wants it gone.

Instrument/subtab pairs today: piano→chord|scales|melody, guitar→chord|scale|melody, drums→beat (UI stub, `console.log` on clear)|metronome, plus layout (no sub-tabs).

`#emptyState` — the "start by adding a chord" hint — is the cautionary example for the hide-all rule. It was toggled **only** by `renderSections`, which no tab but the two chord tabs calls, so once a board was empty the hint followed you onto Scales, Melody and Layout. It is now hidden in the defaults and re-shown by `renderSections` from the board's own state; `board` pins both directions, because fixing this the obvious way can just as easily leave it hidden forever.

Piano→chord and guitar→chord share `#boards` but **not** the song in it: each instrument has its own board, so adding, editing, transposing or clearing chords on one tab never touches the other, and a guitar shape or inversion stays where it was set. Both branches call `renderSections()` to draw the card bodies for the current instrument. Guitar→chord also reuses `pianoChordControls` for Transpose and Clear while leaving the two-hands toggle hidden. `renderSections()` is the only place that sets `#boards.two-hands-mode`, and it does so only when `currentInstrument === "piano"` — the class widens cards and drops the chord grid to one column, which is a piano-layout decision that must not follow you onto the guitar tab (playback already guards separately in `getChordPlaybackMIDIs`).

### Section/chord state model

State lives in `boardsEl.dataset.sections` as a **JSON string** on `#boards`. The pattern throughout is: parse → mutate → `JSON.stringify` back into the dataset → `renderSections()` (which re-renders from scratch and re-persists). There is no reactive layer; forgetting the re-stringify silently drops the change.

The dataset holds **only the board of the instrument on screen**. Each is persisted under its own key — `cv-sections-piano` / `cv-sections-guitar`, plus `cv-active-section-<inst>` — and `setInstrument` flushes the outgoing board with `saveSections()` before swapping the incoming one in with `loadSections()`. Everything that persists goes through those two helpers plus `saveActiveSection()`; a raw `localStorage.setItem("cv-sections", …)` would write to a key nothing reads and, worse, would leak one instrument's edits into the other. `boardInstrument()` maps drums onto the piano board, since drums has no board of its own and must not be able to save over one.

`loadSections()` also restores what belongs to that board and is not inside the JSON: `sectionCounter` (so parts continue at C rather than restarting at A) and the Transpose readout, kept per instrument in `transposeOffsets`. `#songMeta` (the title/subtitle inputs above `#boards`, shown on both chord tabs) is board state too, and rides along on the same helpers: `saveSongMeta`/`loadSongMeta` are called from `saveSections`/`loadSections`, so switching instrument swaps the title with the song. They sit in their own keys rather than inside the sections JSON, which is an array of sections with nowhere to put them — and because typing a title mutates no section, the inputs also persist on their own `input` listeners.

### Song files (save / load)

`#saveSong` downloads the song as JSON and `#loadSong` reads one back. A song file is **both boards at once** — `{ format: "z-chords-song", version, savedAt, capo, boards: { piano, guitar }, layout? }`, each board `{ title, subtitle, sections, melodies, activeSection, transpose }`. Carrying only the tab on screen would silently drop the other instrument's chords, which is the whole failure this avoids.

`writeBoardState` writes `melodies` **only when the key is present**: a v1 file has none, and writing `[]` for it would wipe melodies already on the board. Absence means "leave them alone" — the same rule `applyLayoutFromSongFile` uses for a missing sheet.

`version` is **2**, which added the optional top-level `layout`. Both directions stay compatible: a v1 file simply has no `layout` key, and a v2 file opened by an older build drops the sheet but keeps every chord — which is why the sheet is a sibling of `boards` rather than something buried inside one of them. `applySongFile` restores the layout *after* the boards, so its references resolve against the chords the file just brought in.

The pair is deliberately thin: `buildSongFile()` flushes the on-screen board with `saveSections()` and then reads the same localStorage keys `loadSections()` reads; `applySongFile()` writes those keys and re-enters `loadSections()` + `renderSections()`. Neither knows the shape of a section or a chord, so adding fields to either needs no change here. Capo rides along because it describes the arrangement; theme, two-hands mode and the PDF scale do not, because they describe the view.

A song saved before the split lives under the old `cv-sections`; `migrateSharedSections()` seeds *both* copies from it so neither tab comes back empty, then removes the legacy keys.

Shape: `[{ name, chords: [chordObj, ...], pageBreakBefore }]` (`pageBreakBefore` is the section header's PDF page-break checkbox; absent means no break) where a chord is either a parsed symbol (`{ sym, inversion }`) or a fully custom chord (`{ sym, inversion, octave, customMIDIs, rootMidi, leftHandMIDIs }`). Rendering code must handle both — presence of `customMIDIs` means "use these MIDI numbers verbatim, don't parse `sym`".

`renderSections()` rebuilds all SortableJS instances itself, inline at the end of the function: one on `#boards` (sections, dragged by `.section-header`) and one per `.chords-container` (chords, `handle: ".card"`, `filter: ".no-drag"`).

Note `enableDragAndDrop()` is **dead code** — it is defined but never called from anywhere, and the instances it would create are not the live ones. Do not add drag behaviour there expecting it to run.

### Chord parsing

`CHORD_PATTERNS` maps a quality suffix to semitone offsets; `CHORD_RE` is built at load time from the pattern keys sorted longest-first so `maj7` wins over `maj`. Adding a chord quality = add one entry to `CHORD_PATTERNS`; the regex, the autocomplete suggestions, and transposition all derive from it.

Two-hands mode (`cv-twohands`) splits a chord into a left-hand voicing (`computeLeftHandInfo` — root + a seventh chosen from the pattern, with a heuristic fallback) and changes the rendered piano range via `getPianoRange`.

### PDF export

`#downloadPdf` opens a preview modal rather than saving straight away. Export is split into four steps so the preview and the file cannot disagree:

- `capturePdfSections()` clones `.boards.preview` into an offscreen container and rasterizes each `.section` with html2canvas. This is the expensive step and it runs **once** per modal open.

  **The clone must be forced visible and given an explicit width.** `updateTabsUI` hides `#boards` with an *inline* `display: none` on every sub-tab that is not a chord tab, and `cloneNode` copies inline styles — so pressing Download PDF from Melody, Scales or Metronome rasterized a zero-sized element. That did not degrade to an empty PDF: html2canvas computed the `.card` gradient over a zero-length gradient line and threw `addColorStop ... non-finite`, killing the preview with a console error. The export's subject is *this instrument's chord board*, which exists in state regardless of which tab is on screen, so the fix is to lay the clone out rather than to refuse. The width comes from `parentContentWidth()` — the parent's `clientWidth` **minus its padding**, since `clientWidth` includes it and using it raw made the off-tab capture 40px wider than the chord tab's.

  **And the clone's black keys must be re-placed** via `positionBlackKeys()`. `makePiano` measures white keys in a `requestAnimationFrame` and falls back to `left: 0` when the measurement is zero, on the assumption that a hidden board gets rebuilt when its tab is shown — but the export clones it *without* it ever being shown, so every keyboard printed as a stack of black keys at the left edge. Each black key records its `data-anchor-midi` so the geometry can be recomputed against any layout. The `export` suite compares the two captures **pixel-by-pixel** rather than structurally, because both of these defects produced a page that passed every structural measure.
- `layoutPdfPages(captures, scale, headings)` places those captures onto A4 pages, in mm. It is pure arithmetic over the cached canvases, so moving the scale slider re-runs only this — never html2canvas. That is the whole reason capture and layout are separate.
- `renderPdfPreview()` draws the same placements as DOM, and `savePdfFromLayout()` draws them into jsPDF. Both consume the identical placement list, so what the modal shows is what is saved.

`headings` is the list `pdfHeadings()` builds — song title, subtitle, capo label, each `{ text, sizePt, bold, gapMm }`, each skipped when empty. They are laid onto page one without setting `hasContent`, so a first section with `pageBreakBefore` still starts on page one instead of leaving the headings alone.

A placement is either `type: "text"` (a heading line) or `type: "image"` — one horizontal band of a capture, identified by `sourceY`/`sourceHeight`. The preview renders a band without re-rasterizing: the slice box clips, and the full-section image inside is shifted by `translateY(-sourceY/canvas.height)`, a percentage that resolves against the image's own height.

Layout rules, in order: a section with `pageBreakBefore` starts a fresh page; a section that would be split *only* because of what precedes it moves to the next page whole; a section genuinely taller than a page is split, preferring breaks aligned to `.card.preview` tops so chord cards aren't cut in half. Sections otherwise pack onto the current page — the default is no page break, and the per-section checkbox in the section header is the opt-in.

`scale` (the modal's slider, persisted as `cv-pdf-scale`) is the fraction of the content width the sections are drawn at, and the content is centred at that width. Below 1 the sections get shorter in mm too, which is what lets more of them fit on a page.

The modal itself is **shared with the Layout tab** and knows nothing about either producer. `openPdfPreviewModal({ prepare, layout, scaleKey, fileName })` takes a pair: `prepare()` is awaited once per open and owns the expensive rasterizing, `layout(ctx, scale)` is pure and cheap and re-runs on every slider input. Keeping that split in the controller is what stops either consumer from accidentally re-rasterizing. `openBoardPdfPreview()` is the auto-flow producer; `layout.js` supplies the other.

### Layout sheet

The Layout tab composes A4 pages from content made elsewhere. It is a fourth *instrument* tab with no sub-tabs (`positionSegmentedHighlight` already collapses to `width: 0` when none are visible), because it is cross-instrument by nature and belongs beside Piano/Guitar/Drums rather than under one of them.

- **`layout-model.js`** is pure: the document shape, `packRows` (greedy left-to-right into 12 columns) and `paginateRows`. No DOM, no imports.
- **`layout.js`** owns the tab's DOM. It does **not** import `script.js` — `script.js` calls `initLayout({ readBoardState, buildCardElement, openPdfPreviewModal })`, so the graph stays one-directional and there is no module cycle.

Blocks hold **references** to board content (`{ instrument, sectionId, chordId }`), not snapshots, so fixing a chord on a chord tab updates the sheet. That is why sections and chords now carry a stable `id`, minted lazily by `ensureIds()` from both `loadSections()` and `renderSections()` — the latter is the choke point every mutation passes through. A reference whose target is gone renders a visible "source removed" placeholder and is skipped on export; silently dropping the block would be the worse failure. Fretboard and text blocks hold their settings **by value**, because their only "source" is a singleton view state that every such block would otherwise share.

Geometry is one constant: `--layout-px-per-mm` (4), so the content box is 760px and `heightMm = el.offsetHeight / pxPerMm`. **Measure with `offsetHeight`, never `getBoundingClientRect`** — the sheet sits inside a fit-to-screen `transform: scale()`, and `getBoundingClientRect` would multiply every height by it.

Pages are *computed*, never drop targets: there is one continuous Sortable list, page boundaries are drawn as guides behind it, and the first block of each page gets an inline `margin-top` so the editor shows the gaps the PDF will have. That keeps the flow's children uniform, which is why `onAdd`/`onUpdate` can derive the model index straight from `.layout-block` DOM order. Sortable's `evt.newIndex` would count anything else in there.

Export rasterizes **per block** and emits the *same* placement shape the auto-flow path uses, so `renderPdfPreview` and `savePdfFromLayout` are reused unchanged. Text blocks are emitted as `type: "text"` rather than captured, so comments stay crisp and selectable. An over-tall row **shrinks to fit and centres** rather than being sliced — the opposite of the auto-flow rule, and deliberately so: that path slices a vertical list of cards where a clean break exists, while a halved fretboard or grand staff is unusable.

Blocks carry `.pdf-capture` on `.lb-body`, not on the flow: a block sits on a white page, so its contents need paper ink even in dark mode, but scoping it to the body leaves the editor chrome on theme colours. Everything `.lb-chrome`, `.lb-controls` and `.lb-resize` is stripped from the export clone.

**Layout has no write path to a board.** `boardInstrument()` reports `"piano"` while this tab is up, so a flush from here could write the wrong board's chords over the piano's; `readBoards()` is deliberately read-only, and `setInstrument` has already flushed the outgoing board before the tab is ever shown.

### Melody notation

`melody-model.js` is pure note math; `melody-render.js` is a thin wrapper over **VexFlow 5.0.0**, loaded from CDN in `index.html` as the global `VexFlow`. `melody-render.js` is the only file that touches it, so it stays swappable — the same containment `guitar-chords.js` gives chord shapes.

**Do not "fix" the script tag to a cdnjs URL, and do not trust its version label.** Every cdnjs `vexflow` 4.x entry serves **VexFlow 3.0.9** (2019): the npm package carries a legacy `releases/` directory that was never rebuilt, cdnjs mirrors that directory, and so "4.2.2" and "4.2.5" there are byte-identical (same SHA256) and log *"This page uses version 3.0.9, which is no longer supported."* This renderer was originally written against that build without anyone noticing, and its "verified API facts" were all really 3.0.9 behaviour. Real builds live under `build/`; jsDelivr's `vexflow@5.0.0/build/cjs/vexflow.js` is the one used. For completeness: 4.2.6 exists as a GitHub release but was never published to npm, so it is on no CDN at all. **A CDN's version label is a claim, not evidence — check the version string inside the file.**

This wrapper replaced a hand-rolled Bravura/SMuFL renderer. That worked, but engraving is a deep rulebook — beaming, key signatures, tuplets, multi-voice and beam-break rules all interact — and matching it by hand has no natural end. Three objections had been raised against VexFlow when the hand-rolled path was chosen; all three were later **measured against the real library, and all three were wrong**, which is the real lesson here rather than the library choice:

- **Theming is free.** VexFlow writes colours as SVG *presentation attributes*, which any CSS rule outranks — so `.ms-*` selectors handle dark/light and `.pdf-capture` with no JS styling options, the same contract `.gc-*` and `.gs-*` have. But see the trap below: in 5.x it puts `fill`/`stroke` on the **`<svg>` root** and lets most children inherit, so styling only descendants themes almost nothing.
- **Notes stay addressable.** Each `StaveNote`'s painted group takes our `data-event-index`, so `melody-editor.js` survived the renderer being replaced wholesale, untouched — the payoff of that contract being *data attributes* rather than internals.
- **Fonts are not a risk.** 5.x draws glyphs as `<text>` in Bravura, but ships the faces as base64 `data:font/woff2` URIs registered at load: no network request, no CORS, and no `document.fonts.ready` race.

The 5.x API is the documented one, and differs from the 3.0.9 build this was first written against on every point that matters: `addModifier(modifier, index)` (3.0.9 wanted index first), `Dot.buildAndAttach` exists, `getSVGElement()` exists on notes **and** tab notes (3.0.9 had neither, so tab notes could not be addressed at all), options are camelCase (`numBeats`/`beatValue`, and `StaveTie({firstNote, lastNote})` — the snake_case spellings throw `BadArguments`). `ctx.openGroup("ms-beam")` produces class **`vf-ms-beam`** — it prefixes whatever name it is given — but it returns the `<g>`, so `inGroup` adds the unprefixed class itself rather than matching VexFlow's scheme. Beams and ties expose no element of their own, so `inGroup` is the only hook for them.

**Theming targets the `<svg>` root, not just descendants.** VexFlow 5 sets `fill`/`stroke` on the root and lets most elements inherit; only a minority carry their own colour attribute. A descendant-only rule (`.ms-score [fill]`) therefore recolours almost nothing, and dark mode renders **black notation on a black page**. `.ms-score` itself must set `fill`/`stroke`, with the descendant rules handling the minority that override. This shipped once and the test suite approved it, because the check counted only descendants, found zero, and passed vacuously — see `tests/README.md`.

**The SVG is sized from what was actually painted**, via `getBBox()`, not from arithmetic. Sizing by arithmetic means knowing how far every glyph reaches, which is the library's business rather than ours: the treble clef's descender alone put 25px of ink below the declared height on *every* treble melody, an empty one included. `getBBox()` returns zeros on a node that was never in the document, so the render host is attached offscreen for the measurement and removed afterwards — a detached div silently measures to nothing. The final viewBox is the union of the planned box and the measured ink, so a negative `minY` is absorbed by the viewBox rather than by shifting coordinates; `getScreenCTM()` already accounts for the viewBox, so the editor's click→pitch inverse is unaffected.

Durations stay **ticks** in `melody-model.js`, not seconds or note-name strings: `TICKS_PER_WHOLE = 64`, so every supported value down to a double-dotted 16th is an integer and bar arithmetic (`layoutBars`) is exact integer math with no drift. `layoutBars` also splits a note crossing a barline into tied fragments, which is precisely the shape VexFlow wants — it does not split for you. The split uses `decomposeTicks`, a small DP finding the *shortest* exact decomposition rather than a greedy take-the-largest-first pass. Greedy looks equivalent until you measure it: over a full sweep it failed 147 times out of 256, because committing to the largest duration first can strand a leftover a smaller first choice would have avoided (`10` greedily becomes `8+2`, which has no representation, when `6+4` exists and is exact). The DP fails only on the five tick counts (`1,2,3,5,9`) that are genuinely unrepresentable — a coin-problem consequence of the duration vocabulary's tick values having gcd 1 — and folds that rare leftover into the nearest fragment so the total is still exact.

Accidental spelling (`spellNote`) remains a sharp-keys/flat-keys heuristic rather than full key-signature-aware engraving; that is ours, not VexFlow's, and is the one notation shortcut still standing. Beaming, which the hand-rolled renderer deferred indefinitely, is now one line (`Beam.generateBeams`) and is pinned by a test.

### Melody editing

**Melodies are board content**, authored on **piano→melody** and **guitar→melody**, stored per board under `cv-melodies-<inst>`, and placed on the Layout sheet **by reference** (`{instrument, melodyId}`) exactly as sections and chords are. They were briefly authored in place on the sheet instead; moving them out is what makes a melody have one home — edit it on its instrument tab and every sheet that places it shows the same music, and it rides into song files through `readBoardState`/`writeBoardState` like everything else on a board. A layout melody block is now read-only, which keeps the sheet from being a second, competing editor, the same rule its chord cards already follow (`interactive: false`).

The split is the repo's usual one:

- `melody-editor.js` — `createMelodyEditor(host, melody, { onChange, showControls, clefOptions })` → `{ el, getMelody, setMelody, destroy }`. Mirrors `createChordEditor`'s contract: it owns the DOM inside `host`, holds the caret, reports committed changes through `onChange`, and knows nothing about boards, tabs or storage.
- `melody-panel.js` — owns the `#melodyPanel` DOM (the melody list plus one editor) and takes `readMelodies`/`writeMelodies` as injected deps, so `script.js` keeps the single localStorage vocabulary and no module cycle forms. Same shape as `initLayout(deps)`.

The clef choices differ per instrument (guitar offers staff+tab, piano offers treble/bass/grand) for the same reason the chord tabs draw different cards: a tab stave under a piano melody means nothing.

The staff SVG is the editing surface: clicking a notehead or rest selects it (every one carries `data-event-index`, which is the addressability that justified emitting each element ourselves), and clicking anywhere else on the staff adds a note at the pitch clicked. Both are clicks on the same SVG; the hit test decides which, exactly as `createChordEditor` does for guitar shapes.

Turning a click into a pitch uses `svg.getScreenCTM().inverse()`, not offset or rect arithmetic — the CTM already accounts for every ancestor transform, which is what let the editor move from inside the sheet's fit-to-screen `transform: scale()` to the plain melody tab without changing a line of the conversion. `melody-render.js` publishes the primary stave's geometry on the SVG root (`data-stave-bottom-y`, `data-stave-ref-bottom`, `data-step-px`) so the editor inverts it without duplicating `LINE_GAP`/`CLEF_REF`; `midiFromStaffStep` in the model does the diatonic half. A grand staff has two staves and only the first is published — click-to-enter there is a documented limit, not an oversight.

Two things about how edits are applied:

- **`drawStaff` redraws only the staff, preserving focus.** Rebuilding the whole editor destroys focus on every keystroke, which makes keyboard editing impossible. The duration palette is the exception — it also redraws the controls, since its active-button state lives there.
- **The caret and selected duration are not persisted**, and neither is which melody is open. A cursor is view state, not content, the same way `activeSectionIndex` is.

**The painted size is governed by the SVG's inline `style`, not its `width` attribute.** `renderer.resize()` writes `style.width`/`style.height` in px, and an inline style outranks a presentation attribute — so any code that resizes the score must set the style, and a test that watches the attribute is watching the wrong thing. This mattered twice over: because `resize()` is called with the pre-`getBBox()` *estimate*, leaving that style in place displayed every score squeezed into a box narrower than the viewBox it had grown to, which is why notation looked small even before zoom existed.

**Zoom scales the declared `width`/`height`, never the viewBox.** VexFlow's default engraving is too small to edit comfortably, so the editor renders at `scale` (default 1.6, persisted as `cv-melody-zoom`, clamped 1–3 by `clampScale`). The viewBox stays in VexFlow's own user space, which is what makes this free: `data-step-px` and `data-stave-bottom-y` are user-space coordinates and `getScreenCTM()` already folds in the viewBox→viewport ratio, so the click→pitch inverse needs no knowledge of the zoom at all. The two alternatives both cost more — re-rendering at a larger size would change VexFlow's own spacing decisions, and a CSS `transform` would leave the element's layout box at the old size, so the container would not scroll. `cv-melody-zoom` is view state, so it is **not** per-board and does not ride into song files; it is the same status `cv-layout-scale` has.

Guitar tab positions are **derived, never stored**: `assignTab` runs at render time from the pitches, so a fret can never go stale after an edit, and the saved melody carries no `fret`/`stringIdx` at all. Only a manual override would need persisting (`manualTab`), and arrow-key transposition deletes that flag, because a hand-picked position stops being valid once the pitch moves.

A melody carries a `name` (set in the melody list, shown by the layout library). `normalizeMelody` runs on every edit, so **any field it does not know about is silently dropped** — that is why `name` is part of `createMelody` rather than bolted on by the panel, and why a test pins that an edit does not erase it.

Playback schedules one `setTimeout` per note against `melodyPlaybackSchedule`, through `audio.js`'s shared `playNotes`. `updateTabsUI` stops it whenever the melody sub-tab is not the one on screen, for the same reason it calls `stopMetronome()` — scheduled timers would otherwise keep firing over whatever tab you switched to.

### Styling / theming

Theme is CSS custom properties on `:root` (dark, the default) overridden under `body.light-mode`; toggling swaps the class and persists `cv-theme`. Dimensions that JS needs to know (notably `--white-key-width`) are read back out of computed styles rather than hardcoded — keep them in sync when changing key geometry.

## localStorage keys

`cv-sections-piano`, `cv-sections-guitar`, `cv-melodies-piano`, `cv-melodies-guitar`, `cv-active-section-piano`, `cv-active-section-guitar` (the pre-split `cv-sections` / `cv-active-section` are read once and migrated away), `cv-theme`, `cv-twohands`, `cv-instrument`, `cv-subtabs`, `cv-capo`, `cv-pdf-scale`, `cv-melody-zoom` (melody-panel.js — view state, not per-board), `cv-title-piano` / `cv-title-guitar` / `cv-subtitle-piano` / `cv-subtitle-guitar` (script.js); `cv-guitar-scale-settings` (main.js); `cv-layout` and `cv-layout-scale` (layout.js — cross-instrument, so unlike `cv-sections-*` they are **not** per-board and do not go through `saveSections`/`loadSections`).

## Dead / stale files

`guitar_backup_before_edit.js`, `tmp_before.html`, `temp_guitar.svg`, `old/`, and `mockups/` are not referenced by `index.html`. Don't edit them expecting an effect.
