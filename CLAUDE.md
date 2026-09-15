# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Z-Chords ("Chord Viewer") is a zero-build, dependency-free static web app for visualizing chords and scales on piano and guitar, notating melodies and drum beats, composing printable sheets, and keeping time with a metronome. The root `package.json` is a stub — no scripts, no devDependencies, no bundler. Its `"type": "module"` is there only so Node reads the `.js` files as the ES modules they already are (the test runner imports `layout-model.js` directly); it changes nothing at runtime.

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

Instrument/subtab pairs today: piano→chord|scales|melody, guitar→chord|scale|melody, drums→beat|metronome, plus layout (no sub-tabs). `#melodyPanel` serves three of those — piano→melody, guitar→melody and drums→beat — so the "stop playback when you leave" test is against the panel's sub-tab *for that instrument* (`beat` on drums, `melody` elsewhere), not against the literal string `melody`.

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

**The SVG is sized from VexFlow's own `getBoundingBox()`, not from `getBBox()` and not from arithmetic.** Sizing by arithmetic means knowing how far every glyph reaches, which is the library's business rather than ours: the treble clef's descender alone put 25px below the declared height on *every* treble melody, an empty one included.

But measuring the DOM is wrong too, now that 5.x draws every glyph as `<text>` in Bravura: **`getBBox()` on an SVG `<text>` returns the font's line box, not the glyph's ink**, so a 10px notehead measures 160px tall and every score came out ~130px taller than its contents. VexFlow's own `getBoundingBox()` is computed from its metrics, which encode real glyph extents — for a 40px stave with a treble clef it reports 130, correctly including the clef's reach. Ask the library; do not measure the font. Staves (which carry their clef and time signature) and notes are collected during rendering and unioned with the planned box, so a negative `minY` is absorbed by the viewBox rather than by shifting coordinates; `getScreenCTM()` already accounts for the viewBox, so the editor's click→pitch inverse is unaffected.

That mistake hid for a while because it was cancelling out with two others: the inline-style bug was separately squeezing the inflated box back down, and the suite's overflow check was measuring `<text>` the same wrong way, so it approved the inflation it was supposed to catch. The check now rasterizes with an **expanded viewBox** — pixels are immune to font metrics, and widening the clip region is what makes ink outside the declared box visible at all.

Durations stay **ticks** in `melody-model.js`, not seconds or note-name strings: `TICKS_PER_WHOLE = 64`, so every supported value down to a double-dotted 16th is an integer and bar arithmetic (`layoutBars`) is exact integer math with no drift. `layoutBars` also splits a note crossing a barline into tied fragments, which is precisely the shape VexFlow wants — it does not split for you. The split uses `decomposeTicks`, a small DP finding the *shortest* exact decomposition rather than a greedy take-the-largest-first pass. Greedy looks equivalent until you measure it: over a full sweep it failed 147 times out of 256, because committing to the largest duration first can strand a leftover a smaller first choice would have avoided (`10` greedily becomes `8+2`, which has no representation, when `6+4` exists and is exact). The DP fails only on the five tick counts (`1,2,3,5,9`) that are genuinely unrepresentable — a coin-problem consequence of the duration vocabulary's tick values having gcd 1 — and folds that rare leftover into the nearest fragment so the total is still exact.

**Filler rests.** `layoutBars` pads the last bar out to its capacity with rest items carrying `filler: true` and `eventIndex: null`, so an untouched 4/4 bar reads as a whole rest rather than as blank paper and the remainder re-forms itself as you write into the bar. They are **not events**: `melody.events` is untouched, nothing is persisted, and `melody-render.js` deliberately stamps no `data-event-index` on them — which is exactly what makes a click on the empty end of a bar write a note there instead of selecting a rest that does not exist. They *are* stamped with `data-filler-index`/`-den`/`-dots`, which is what lets the editor treat each one as a place to write and turn the earlier ones into real rests when it does — see *Input slots* below. Anything totalling ticks over `bar.items` must skip them; they are the one thing in a bar that does not come from an event. Styling follows the `gs-dot-ghost` precedent: dimmed in the editor (they are the one thing on the staff that cannot be clicked), full strength under `.pdf-capture`, where they are ordinary rests on paper.

The fill is **not** `decomposeTicks`. That finds the shortest list, which is right for splitting one note across a barline and wrong here: a rest must also *start* on a boundary its own duration divides, or it hides where the beat is. After one quarter in 4/4 the copyist's answer is a quarter rest then a half rest, never the single dotted-half rest "shortest" gives. `fillerRests` therefore takes the largest duration that both fits and is aligned to the current position. The one exception is an untouched bar: a full measure of silence is one whole rest in *every* meter, 3/4 and 6/8 included, which is why a filler's ticks can exceed a whole note's own duration.

Beaming, which the hand-rolled renderer deferred indefinitely, is now one line (`Beam.generateBeams`) and is pinned by a test.

**Key signatures, and who decides an accidental.** The work is split in two, and the split is the point:

- **`spellNote` decides the spelling** — whether a black key is written C♯ or D♭ — and remains the sharp-keys/flat-keys heuristic it always was. That is ours. Its one visible limit: in a flat key it spells pitch class 11 as B♮ rather than C♭, so a G♭-major score writes B♮ where a copyist writes C♭. The rest of the engraving stays self-consistent around that, because the accidental pass below reads the spelling it is given.
- **VexFlow decides whether that accidental is printed**, via `Accidental.applyAccidentals(voices, keySpec)`. This is not a per-note question and cannot be answered one note at a time: a note the signature already alters takes none, a note altered earlier in the same bar does not restate it, and a note returning to the signature's version needs a natural to cancel. That is a rulebook, and it is the library's — the same "ask the library" lesson as `getBoundingBox()`.

Three things about that call are load-bearing:

- **It runs per bar.** `applyAccidentals` tracks what it has already seen across everything it is handed, so passing the whole score at once would suppress an accidental in bar 8 because bar 2 had one. Calling it inside `drawBar` is what gives the within-bar state the right scope.
- **It runs before formatting**, since the modifiers it adds take horizontal room.
- **One rule is ours and is applied after it**: a tied continuation does not restate its accidental, because it is not a new note but the tail of one `layoutBars` split across a barline. VexFlow cannot know that, so the accidental is stripped from `tiedFrom` fragments afterwards — splicing the live modifier array, which is exactly how `applyAccidentals` itself removes a stale one.

`KEY_ROOTS` (in `melody-model.js`) is the fifteen major keys ordered as the circle of fifths **with C at index 7**, which is not cosmetic: distance from C *is* the accidental count, so both the renderer's width allowance and the editor's `(2♯)` labels derive from the index instead of carrying a second table that could drift. It is also the validation list — `addKeySignature` **throws** on a spelling it does not know, so `createMelody` rejects anything not on it, which is what keeps `normalizeMelody`'s never-throws contract true for a hand-edited song file.

A drum staff gets **no** key signature (`keySpecFor` returns null): its "pitches" are GM percussion numbers, so a flat at the head of the staff would be claiming a kick drum can be flattened.

**Writing notes in the key.** A signature that only changed what was *painted* would be half a feature: entering a melody in D major would still write F naturals and you would correct every diatonic note by hand. So both input paths run their pitch through `applyKeyAlteration(midi, keyRoot)` — the staff click (whose staff position names a letter) and letter entry (where `midiForLetterNear` finds the octave from the natural, then the key bends it). Typing `F` in D major and clicking the F line both write F♯, and `applyAccidentals` then paints no accidental in front of it because the signature already covers it.

Which letters a key alters is derived, not tabled: `keyAlteration` takes the first *n* of `SHARP_ORDER`/`FLAT_ORDER`, where *n* is the accidental count `KEY_ROOTS`'s ordering already gives. One fact, not fifteen.

Two limits are deliberate:

- **Only naturals are bent.** A pitch that is already sharp or flat was reached with the arrow keys, which are the deliberate way *out* of the key; bending it again would put chromatic notes out of reach.
- **The seven-accidental keys don't bend C♭/F♭ (or B♯).** `spellNote` is a sharp/flat heuristic with no C♭ in it, so it spells that pitch B — which would paint the note one staff step *below* the line that was clicked. The editor's contract is that a note lands where you pointed, so `applyKeyAlteration` checks the spelling round-trips to the same letter and leaves those alone rather than moving the notehead. It is the same documented `spellNote` limit, kept from leaking into where the notehead sits.

The canvas width allowance (`KEY_ACCIDENTAL_WIDTH`) only sizes the SVG up front — the notes themselves are justified to whatever room the stave reports is left, which already accounts for the signature exactly. Undersizing it does not misplace a note, it just crams the first bar.

**There is no `.vf-accidental` class.** VexFlow 5 paints an accidental as a `<text>` at a SMuFL codepoint (U+E260 flat, U+E261 natural, U+E262 sharp) inside the note's own group. A selector for that class matches nothing and returns 0 — which is how the suite's "no accidentals on a kit" check spent its life passing vacuously, and would have quietly approved every key-signature check written the same way. Count accidentals by codepoint, and separate signature glyphs from note glyphs by `closest(".vf-keysignature")`. That group class *is* real.

### Melody editing

**Melodies are board content**, authored on **piano→melody** and **guitar→melody**, stored per board under `cv-melodies-<inst>`, and placed on the Layout sheet **by reference** (`{instrument, melodyId}`) exactly as sections and chords are. They were briefly authored in place on the sheet instead; moving them out is what makes a melody have one home — edit it on its instrument tab and every sheet that places it shows the same music, and it rides into song files through `readBoardState`/`writeBoardState` like everything else on a board. A layout melody block is now read-only, which keeps the sheet from being a second, competing editor, the same rule its chord cards already follow (`interactive: false`).

The split is the repo's usual one:

- `melody-editor.js` — `createMelodyEditor(host, melody, { onChange, showControls, clefOptions })` → `{ el, getMelody, setMelody, destroy }`. Mirrors `createChordEditor`'s contract: it owns the DOM inside `host`, holds the caret, reports committed changes through `onChange`, and knows nothing about boards, tabs or storage.
- `melody-panel.js` — owns the `#melodyPanel` DOM (the melody list plus one editor) and takes `readMelodies`/`writeMelodies` as injected deps, so `script.js` keeps the single localStorage vocabulary and no module cycle forms. Same shape as `initLayout(deps)`.

The clef choices differ per instrument (guitar offers staff+tab, piano offers treble/bass/grand) for the same reason the chord tabs draw different cards: a tab stave under a piano melody means nothing.

The staff SVG is the editing surface: clicking a notehead or rest selects it (every one carries `data-event-index`, which is the addressability that justified emitting each element ourselves), and — while **note-input mode** is on — clicking anywhere else on the staff adds a note at the pitch clicked. Both are clicks on the same SVG; the hit test decides which, exactly as `createChordEditor` does for guitar shapes.

Turning a click into a pitch uses `svg.getScreenCTM().inverse()`, not offset or rect arithmetic — the CTM already accounts for every ancestor transform, which is what let the editor move from inside the sheet's fit-to-screen `transform: scale()` to the plain melody tab without changing a line of the conversion. `melody-render.js` publishes the primary stave's geometry on the SVG root (`data-stave-bottom-y`, `data-stave-ref-bottom`, `data-step-px`) so the editor inverts it without duplicating `LINE_GAP`/`CLEF_REF`; `midiFromStaffStep` in the model does the diatonic half. A grand staff has two staves and only the first is published — click-to-enter there is a documented limit, not an oversight.

`data-stave-bottom-y` comes from `stave.getYForLine(numLines - 1)`, **not** `stave.getBottomLineY()`. VexFlow's method is misnamed: it is `getYForLine(numLines)` — index 5 on a five-line stave whose lines are 0..4 — so it returns the y one full line gap *below* the bottom line. Publishing that shifted the entire click→pitch inverse by two diatonic steps: clicking the bottom line wrote a G4 instead of an E4. It hid because the ghost notehead reads the same attribute, so the preview agreed with the click and only the printed staff disagreed — and because the test clicked at `data-stave-bottom-y` and asserted the pitch that attribute was derived from, which is the code agreeing with itself. The check now anchors on the painted stave lines.

**Note-input mode** (`state.noteInput`, off by default, toggled by the pencil button or `N`, exited with `Escape`) is what gates *writing*: letters, `R` and a staff click only write while it is on. Navigation (arrow keys, clicking a note to select it), transposition, deletion, the duration palette and tying all work regardless — the split is "does this write a note" versus "does this act on what's already there", the same distinction MuseScore's own note-input toggle makes so that browsing a melody with the keyboard can never accidentally change it.

**Input slots, and clicking over an existing note.** A *slot* is a place a note can be written, and `slotsFor()` reads them off the **painted score** rather than deriving them from the model, because only the renderer knows where anything actually landed. Two kinds:

- a slot with a numeric `index` is an event already on the staff, and writing there **replaces** it — pitch from the click, duration and dots from the palette, exactly what MuseScore's note input does (the palette is always what you are writing with, so correcting a note can fix its rhythm as well as its pitch);
- a slot with `index: null` is one of the filler rests in the empty tail of the last bar, and writing there puts a note **at that rest**.

Reading slots from the paint rather than the model buys two things for free: an event split across a barline paints twice and so gets two slots naming one event, so clicking either fragment replaces the whole note; and a grand staff's event is a slot wherever it really is, on whichever of the two staves it was routed to. `slotAtX` resolves a pointer x by *containment first*, then nearest centre.

**Each filler rest is its own slot, not one band across the tail.** They were one band once, on the reasoning that they all mean the same thing — "past the end of the melody". They do not: each painted rest is a beat you can write on. As a single band its centre was usually the *gap between two rests*, so the ghost previewed a position no click could write to, which reads on screen as the snap being broken.

Writing at the *k*th filler means the k rests before it stop being empty, so `insertAtFiller` makes them real rest events before appending the note — otherwise the note slides back to wherever the melody already ended. Their durations are read off the paint (`data-filler-index`/`-den`/`-dots`, stamped by `melody-render.js`) rather than re-derived, so what becomes real is exactly what was on screen — `fillerRests`' copyist alignment included. The score therefore does not re-flow under the click: the rests you were looking at stay put and the note lands on the one you aimed at.

A bar nothing has been written into is a single whole rest, so it offers one position. That is not a gap to work around — the tail subdivides itself as you write into it, and the only places a rest is painted are the only places a rest can start.

The keyboard is unaffected: `insertionSlot` carries no `fillerIndex`, so letters still append.

The keyboard is deliberately not part of this. Letters still insert after the caret (`insertionSlot()`), because a click names a note and a keystroke does not.

Two visual cursors appear only in note-input mode, both drawn as plain SVG elements appended to the live score (cleared and redrawn on every `drawStaff`, so they never survive a rebuild stale). Both read `activeSlot()`, so they can never point at different places: the pointer's slot while it is over the staff, the caret's otherwise.

- **The insertion cursor** (`.ms-insert-cursor`, a translucent band) marks the slot about to be written. When that slot holds a note, `.ms-replace-target` fades it as well — the band looks identical over an empty slot and over a note, and only one of those two clicks destroys something.
- **The ghost notehead** (`.ms-input-notehead`, plus `.ms-input-ledger` lines when it falls outside the staff) previews the note a click would write. **Both axes snap and neither follows the raw pixel**: the Y locks to the nearest staff line/space (`staffStepFromLocal`'s rounding — the same inversion a real click uses, so the preview cannot disagree with the click), and the X locks to the slot under the pointer. Snapping to slots rather than floating is the invariant; the ghost floated with the pointer once, which looked like "snap isn't working" because the preview could sit somewhere a click could never write. `tests/suites/melody-note-input.test.mjs` pins both halves of the horizontal claim — the x must *change* between slots (or it is stuck) and must *not* change within one (or it is not snapping).

`state.hoverX` is a user-space **coordinate**, not a resolved slot: every redraw builds a new SVG with new geometry, and a slot cached across one would be stale by exactly the amount the notes just moved.

**Step entry by letter.** With the staff focused and note-input mode on, `A`–`G` insert a note, `R` a rest, `1`–`5` pick the note value (positionally — whole through sixteenth, because matching the denominator would need 1,2,4,8 plus something arbitrary for 16), and `.` cycles the dot. The octave is chosen by `midiForLetterNear`: the octave of that letter nearest the previous pitch, ties upward, so typing C D E after a G4 walks around G rather than leaping to octave 4. Letters enter the **key's** version of the letter and the arrow keys alter them chromatically, the same division the staff click already has — see *Writing notes in the key* below. The emptiness guard in the keydown handler sits *below* this block deliberately — typing must work on a melody with no events, which is exactly when you need it.

**Tying two notes together** (`T`, or the ⌣ button) is a *sustain*, not a barline artifact — different from the `tiedFrom`/`tiedTo` `layoutBars` already stamps when one event's own duration is split across a bar (see "Durations stay ticks" above). A manual tie lives on the event itself as `event.tie` and only ever means anything while the very next event is a real note of the **same pitch** (`notesMatchPitch`, comparing sorted midi sets so a tied chord is judged on all its notes) — the button is disabled otherwise, and `T` on an ineligible caret is a no-op. Because almost any edit can invalidate a tie without touching the flag itself — transposing either note, deleting the one in between, turning the next event into a rest — `commit()` runs `pruneInvalidTies` after *every* edit rather than trusting the flag to stay correct; `normalizeMelody` runs the same pass so a hand-edited song file can't load a stale one back in. `melody-render.js`'s tie-drawing loop draws the identical `VF.StaveTie` curve for both kinds of tie, gated on `notesMatchPitch` so a tie that slipped through anyway still can't draw a curve to the wrong note. `melodyPlaybackSchedule` merges a tied run into one sustained scheduled note rather than re-triggering — playing each fragment separately would put an audible click at the join, exactly what a tie means not to do. Ties are hidden on drum beats, where a "note" is a percussion voice rather than a sustained pitch.

**The duration palette is drawn in Bravura**, not as digits. VexFlow 5 registers the face through the FontFace API at load, so it is in `document.fonts` and any CSS on the page can ask for it — no `@font-face`, nothing hosted, nothing fetched. `bravuraReady()` checks before using it and falls back to digits, because VexFlow is a CDN script that can genuinely be absent and the alternative is a row of tofu boxes. Unicode's own musical symbols (U+1D15D…) would need no font but are not drawn by any normal system stack. Each glyph button keeps a real `aria-label`: a private-use codepoint is not text.

**An active control must differ from the page behind it, in both themes.** This has gone wrong twice in opposite directions — first tinting the active button `--button-bg` on a `--button-bg` fill (blue on blue, dark theme), then inverting it to `--button-text`, which is `#ffffff` in *both* themes and so became a white pill on a white page in light mode, leaving the glyph apparently floating. Only screenshots ever caught either one, which is why a test now states the invariant per theme rather than pinning any particular scheme.

Both failures came from the same root cause: every `button` was filled with the accent, so the active one could not be marked by *being* filled. Now that the default button is outlined (see *Buttons* below), the accent fill is itself the active mark and the inversion is gone. The active glyph button must not change `font-weight`, though — bolder Bravura is wider, and the palette's fixed box is what stops the row shifting as the active value moves.

Two things about how edits are applied:

- **`drawStaff` redraws only the staff, preserving focus.** Rebuilding the whole editor destroys focus on every keystroke, which makes keyboard editing impossible. The duration palette is the exception — it also redraws the controls, since its active-button state lives there.
- **The caret, selected duration and note-input mode are not persisted**, and neither is which melody is open. A cursor — or a mode that only changes how input is interpreted — is view state, not content, the same way `activeSectionIndex` is.

**The painted size is governed by the SVG's inline `style`, not its `width` attribute.** `renderer.resize()` writes `style.width`/`style.height` in px, and an inline style outranks a presentation attribute — so any code that resizes the score must set the style, and a test that watches the attribute is watching the wrong thing. This mattered twice over: because `resize()` is called with the pre-`getBBox()` *estimate*, leaving that style in place displayed every score squeezed into a box narrower than the viewBox it had grown to, which is why notation looked small even before zoom existed.

**Zoom scales the declared `width`/`height`, never the viewBox.** VexFlow's default engraving is too small to edit comfortably, so the editor renders at `scale` (default 1.6, persisted as `cv-melody-zoom`, clamped 1–3 by `clampScale`). The viewBox stays in VexFlow's own user space, which is what makes this free: `data-step-px` and `data-stave-bottom-y` are user-space coordinates and `getScreenCTM()` already folds in the viewBox→viewport ratio, so the click→pitch inverse needs no knowledge of the zoom at all. The two alternatives both cost more — re-rendering at a larger size would change VexFlow's own spacing decisions, and a CSS `transform` would leave the element's layout box at the old size, so the container would not scroll. `cv-melody-zoom` is view state, so it is **not** per-board and does not ride into song files; it is the same status `cv-layout-scale` has.

Guitar tab positions are **derived, never stored**: `assignTab` runs at render time from the pitches, so a fret can never go stale after an edit, and the saved melody carries no `fret`/`stringIdx` at all. Only a manual override would need persisting (`manualTab`), and arrow-key transposition deletes that flag, because a hand-picked position stops being valid once the pitch moves.

A melody carries a `name` (set in the melody list, shown by the layout library). `normalizeMelody` runs on every edit, so **any field it does not know about is silently dropped** — that is why `name` is part of `createMelody` rather than bolted on by the panel, and why a test pins that an edit does not erase it.

Playback schedules one `setTimeout` per note against `melodyPlaybackSchedule`, through `audio.js`'s shared `playNotes`. `updateTabsUI` stops it whenever the melody sub-tab is not the one on screen, for the same reason it calls `stopMetronome()` — scheduled timers would otherwise keep firing over whatever tab you switched to.

### Drums (the Beat tab)

A beat is **a melody with `clef: "drums"`** — not a fifth notation system. The events, the tick arithmetic, `layoutBars`, the layout blocks, the PDF path and the song file all work on it unchanged, which is exactly why Phase 5 was specified this way rather than as a grid format of its own.

A voice is identified by its **General MIDI percussion number** (`DRUM_VOICES` in `melody-model.js`: kick 36, snare 38, hi-hat 42, crash 49, ride 51), so `notes: [{midi}]` keeps its existing meaning and nothing downstream needs a drum-shaped special case. Staff position and notehead are presentation and live next to it only because the renderer and the grid editor must agree on them.

Two consequences the renderer has to respect, both of which are "a drum note is not a pitch":

- **Vertical extent is fixed (`DRUM_EXTENT`), not derived from the notes present.** `spellNote` would read kick 36 as a C2 — four ledger lines below a treble staff — and size the canvas for ink that is never drawn there.
- **Stems are forced up, and `Beam.generateBeams` must be told to keep them** (`maintainStemDirections`). Left alone, VexFlow picks a direction per chord from its average pitch, so a hat+kick chord stems down while a hat alone stems up and the beam zigzags across the staff. Real drum notation uses two voices (cymbals up, kick down); one voice with a consistent direction is the honest simplification. Setting the direction on the note alone is *not* enough — `generateBeams` silently re-decides it.

The grid sits under a **live staff** of the beat it is writing: the grid answers "which sixteenth" and is the right thing to edit in, the staff answers "what does this read as" and is what gets printed. Showing both is what makes the gap-to-next-hit duration rule *visible* rather than something you have to know. It shares the melody editor's zoom preference, so one setting governs notation everywhere.

**The grid is a view; `melody.events` is the storage.** `drum-grid.js` rebuilds the melody from the grid on every click via `melodyFromGrid`, and `gridFromMelody` reads it back; the round trip is pinned by tests in both `melody-model` and `melody-editor`. The non-obvious half is that **a hit is written with the duration of the gap to the next hit**, not as a 16th — that is what makes a hat on every off-8th read as a row of beamed 8ths instead of 16ths alternating with 16th rests, so the event count is deliberately not the hit count. Runs are clipped to the bar, because a merged rest crossing a barline comes back from `layoutBars` as a *tied* pair, and neither a tied rest nor a tied drum hit is a thing.

`drum-grid.js` mirrors `createMelodyEditor`'s contract exactly, so `melody-panel.js` picks between them **by clef** and is otherwise identical for either. A grid rather than a staff because the input problem is genuinely different: on a melody staff the question is "which pitch" and the staff answers it, but a kit is a fixed short list of voices and the question is "which sixteenth".

Beats live on the **drums board** (`cv-melodies-drums`) and are placed on the sheet by reference like anything else. Two places needed widening for a board that has beats but no chords: `readBoards()` in `layout.js` reads a third board, and the library decides a group is empty from **the items it actually built**, not from section count — testing sections would have hidden the drums group entirely. Song files carry `boards.drums` as a **melodies-only board** written directly rather than through `BOARD_INSTRUMENTS`, which stays the two *chord* boards — adding drums there would also hand `migrateSharedSections` a third board to copy legacy chords into.

Playback is a sketch: each voice is a short pitched blip (`DRUM_SOUND`), dark and low for the kick, bright and short for the cymbals, through the shared `playNotes` with `retrigger: false` — a kick and a hat land on the same tick constantly, and the default would have each cut the other off. It is enough to hear whether a pattern grooves; it is not a drum synth.

### Styling / theming

Theme is CSS custom properties on `:root` (dark, the default) overridden under `body.light-mode`; toggling swaps the class and persists `cv-theme`. Dimensions that JS needs to know (notably `--white-key-width`) are read back out of computed styles rather than hardcoded — keep them in sync when changing key geometry.

The palette is one warm family in both themes (paper and clay in light, warm charcoal and the same clay in dark), so the two sides read as one app. Two consequences that are easy to undo by accident:

- **Never write a hairline as `rgba(255,255,255,α)`.** That silently assumes a dark page: on the light theme it is white on paper, which is no line at all. Use `--hairline`, `--surface-1` (a raised container) and `--surface-2` (its hover). Several containers had no visible edge in light mode for exactly this reason.
- **Don't mix a tinted background toward `black` or `white`.** Mixing the peach page toward black desaturates it into grey-taupe, which reads as a colder family than the page it sits on. Mix toward another token in the family, or set the value explicitly per theme (`--toolbar-bg` is set explicitly precisely because any single mix collapsed into the page in one theme or the other).

`.pdf-capture` keeps its own white-paper values, so none of this reaches the exported PDF.

### Buttons

Three tiers, and **the default is the quiet one**: a bare `<button>` is outlined, not filled. `.btn-primary` (filled accent) is for the one action in a view that commits — Update, Export sheet, Add Chord, Start. `.btn-danger` (outlined red, filling on hover) is for actions that destroy work. This replaced a single rule that painted every `button` *and every `select`* in the accent colour, which left no way to read which control mattered.

Because most generated controls (the melody palette, the drum transport, layout block chrome, the card steppers) carry no class, they are quiet by default — which is correct, since none is the primary action of its view. A `<select>` is an input and is styled as one.

Sizing is two tokens, `--control-h` (38px, toolbar rows) and `--control-h-sm` (30px, dense editor rows), with `--r-control` nested inside `--r-group` so a group's corners stay concentric with its children's. **Everything in one row uses one height, selects and inputs included** — five different heights in a single row was the main reason the UI read as unfinished.

Containers share one shell (`.segmented`, `.toolbar-cluster`, `.transpose-group`, `.hand-toggle`). The melody and beat editor rows are toolbars built from `.tb-group`s, where `.tb-group + .tb-group` grows its own divider from CSS — so a group that ends up empty (the tie button is absent on a beat) leaves no stray line behind.

### Editable fretboard

On the guitar scale tab's **custom** view, every neck position is drawn, so an unchosen dot is an *affordance* ("a note could go here"), not information. It carries `gs-dot-ghost` and is nearly transparent until hovered, when it fills with the accent and reveals its note name. Do not merge this with plain `gs-dot-inactive`: on a *scale* board an inactive dot is information — the note is deliberately not in the scale — and must stay legible. The name reveal is `.gs-dot-ghost:hover + .gs-label-ghost`, so `renderScaleSVG` must keep appending each ghost label immediately after its own circle, with nothing between them. Ghosts are `display: none` under `.pdf-capture`; an affordance must not print.

Clear lives in a bar `drawScale()` builds *inside* `#guitar`, above the neck, because it acts on the fretboard rather than on the app. It is built rather than declared in `index.html` because `drawScale()` clears `#guitar` on every redraw.

## localStorage keys

`cv-sections-piano`, `cv-sections-guitar`, `cv-melodies-piano`, `cv-melodies-guitar`, `cv-melodies-drums` (beats — the drums board has melodies but no sections), `cv-active-section-piano`, `cv-active-section-guitar` (the pre-split `cv-sections` / `cv-active-section` are read once and migrated away), `cv-theme`, `cv-twohands`, `cv-instrument`, `cv-subtabs`, `cv-capo`, `cv-pdf-scale`, `cv-melody-zoom` (melody-panel.js — view state, not per-board), `cv-title-piano` / `cv-title-guitar` / `cv-subtitle-piano` / `cv-subtitle-guitar` (script.js); `cv-guitar-scale-settings` (main.js); `cv-layout` and `cv-layout-scale` (layout.js — cross-instrument, so unlike `cv-sections-*` they are **not** per-board and do not go through `saveSections`/`loadSections`).

## Dead / stale files

`guitar_backup_before_edit.js`, `tmp_before.html`, `temp_guitar.svg`, `old/`, and `mockups/` are not referenced by `index.html`. Don't edit them expecting an effect.
