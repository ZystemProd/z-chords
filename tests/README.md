# Tests

Browser tests for Z-Chords. They drive the real app in a real Chrome and assert
**painted geometry** — where things actually end up on screen — because that is
where this app's bugs live.

The app itself stays zero-build and dependency-free. Everything here is confined
to this folder: its own `package.json`, its own `node_modules`. Nothing in
`tests/` is loaded by `index.html`.

## Running

```bash
cd tests
npm install          # once — pulls puppeteer-core only
npm test             # all suites
npm test -- keys     # only suites matching "keys"
npm test -- --verbose  # list every check, not just failures
```

The runner starts its **own** static server on a free port, so you do not need
one running first — and a stale server on :8000 cannot make the results lie.

`puppeteer-core` drives a Chrome already installed on the machine rather than
downloading its own. It looks in the usual places for Chrome, Chromium or Edge;
override with `CHROME_PATH=/path/to/chrome npm test`.

## Suites

| Suite | What it protects |
|---|---|
| `model` | `layout-model.js` arithmetic. No browser — pure functions. Columns fill the content box exactly, blocks never overlap, an over-tall row shrinks rather than being sliced, the scale slider changes what *fits* rather than only the final size, and a corrupt sheet degrades instead of throwing. |
| `melody-model` | `melody-model.js` arithmetic. No browser. Durations sum exactly across every tick count from 1 to four whole notes — including the barline-crossing split — and a corrupt melody degrades instead of throwing. |
| `melody-editor` | The melody editor on piano→melody and guitar→melody, driven through real clicks and keystrokes: clicking empty staff adds a note at the pitch clicked, clicking a note selects rather than adds, arrows transpose, edits reach `cv-melodies-<inst>` and survive a reload, each board's melodies stay its own, and a layout block *renders* a melody by reference without editing it (and shows a placeholder when its source is gone). |
| `melody-render` | `melody-render.js` (a VexFlow wrapper) painted geometry, via `fixtures/melody-preview.html`. Every case's ink lands inside its own declared SVG box; every painted colour is overridable by CSS on screen and forced black under `.pdf-capture`; our own contract survives (one `data-event-index` per item, plus the stave geometry the editor inverts clicks against); and beams, ties, rests and tab numbers are actually drawn. |
| `keys` | Keyboard proportions at eight block widths in both hand modes. |
| `layout` | Blocks fit their column: sections and single chords, both hand modes, two viewport widths. |
| `board` | The piano tab is unchanged by anything done for the layout sheet, and `#emptyState` shows on an empty chord board without following you to another tab. |
| `export` | The sheet export produces pages, and text blocks stay real PDF text. |
| `guitar` | Chord diagrams and the scale fretboard render, fit, and stay print-safe. |

**Pure suites (`needsBrowser = false`) run in a worker thread**, not the main
process, with a hard 15s deadline (`PURE_SUITE_TIMEOUT_MS` in `run.mjs`). This
is not a style choice — `melody-model.js`'s bar-splitting once had a
synchronous `while` loop that never terminated, and a same-process timeout
cannot rescue that: a tight loop never yields to the event loop, so no timer
fires until something outside the process intervenes. A worker thread has its
own event loop; the parent can `terminate()` it on a deadline no matter what
the worker's JS is doing. Browser suites get a lighter `Promise.race` guard
instead (`BROWSER_SUITE_TIMEOUT_MS`, 60s) — real protection against a
forgotten `await`, but not against a synchronous hang, since Puppeteer calls
are already async by nature.

## Why these assertions

Each suite's header comment names the bug it exists for. Three are worth
repeating, because they are the shape of mistake this app invites.

**Assert ratios, not sizes.** Black keys were sized in fixed pixels while white
keys reflowed, so in a narrow block the black keys came out *wider than the white
keys they sit between*. No absolute measurement catches that — the invariant is
`black / white`, and it must hold at every width. `keys` checks eight widths.

**Assert both axes.** A first pass checked only horizontal fit. It passed while
every keyboard was being cut off at the *bottom*, because the scaling transform
was applied to the element whose height had been set, so the box ended up `k²`
tall while the keyboard inside it was `k`. `keys` now asserts vertical clipping
too.

**Assert the thing you did not change.** `makePiano` is shared between the board
and the sheet, so a fix made for one silently alters the other. `board` pins the
numbers the piano tab rendered before the layout work started.

**A fixed cost is not covered by a content-proportional buffer.** `melody-render`'s
height was computed from how far notes range above/below the staff, plus a flat
buffer meant to cover stems and dots. The clef glyph itself — drawn whether or
not there is a single note — reaches further than that buffer on its own, so an
*empty* melody (nothing "too far" from the staff, by definition) still drew its
clef above `y=0`. Whenever a canvas is sized from content, check what gets drawn
unconditionally too.

**Take the screenshot anyway — assertions only cover what you thought to
assert.** The melody editor's move to its own sub-tab passed 358 checks, and a
single screenshot of the finished tab showed two things none of them asked
about: the chord board's "start by adding a chord" hint sitting under the
staff, and the active duration button rendered blue-on-blue and therefore
invisible. The first was a real pre-existing routing leak (`#emptyState` was
toggled only by `renderSections`, so it followed you onto every other tab); the
second was new CSS marking an active button by tinting it the colour the button
already is. Both are obvious in a picture and invisible to every assertion that
does not already suspect them.

**A visual bug can look like a screenshot problem instead of a rendering one.**
Debugging melody-render's barline placement, a zoomed crop appeared to show no
barline where the model said one belonged — until checking the actual element's
coordinates showed it was correctly placed a few dozen pixels outside the crop
window. The bug was in the debugging tool, not the code under test. Prefer
querying the DOM for the specific element over eyeballing a screenshot crop;
save the screenshot for judging things numbers can't, like whether a hand-drawn
clef reads as a clef.

**Don't trust an analysis you haven't run — including your own.** Before
`decomposeTicks` existed, its design comment argued (correctly) that five tick
counts have no exact decomposition and reasoned (incorrectly) that greedy
would only fail on those five. Sweeping every value from 1 to 256 found greedy
actually failing 147 times — it commits to the largest duration first and can
strand a leftover that a smaller first choice would have avoided. `melody-model`
sweeps the same range against the *shortest* decomposition and asserts the
count of true failures is exactly the five the math predicts, not a hand-typed
threshold — so a regression back to greedy trips the test immediately instead
of needing to be rediscovered.

**A fetch tool's summary is not a data source, especially over a large table.**
Adding Bravura (a SMuFL music font) meant looking up ~18 Unicode codepoints in
its few-hundred-entry glyph table. A summarized fetch of that table returned
plausible-looking hex values, several of them wrong — `noteheadHalf` and
`noteheadBlack` landed on entries for fully composed notes-with-stems, and
every "rest" landed on a note-with-flag glyph, because the summarizing model
mixed up adjacent rows in a large, repetitive table. Nothing about the wrong
values looked wrong until the glyphs were actually rendered and looked at.
`font-calibrate.html` downloads the canonical `glyphnames.json` and parses it
directly instead — no model in between — specifically because this class of
error survives a "does this look plausible" check but not a raw-data parse.

**A DOM measurement API can have a quirk specific to one kind of content.**
`getBBox()`/`getBoundingClientRect()` on an SVG `<text>` element set in a
music font reported a box with the *same height for every glyph*, regardless
of shape — a font-metrics box (ascent/descent), not the individual glyph's
ink. The fix at the time was to stop asking the DOM and rasterize instead:
draw the SVG onto a padded canvas and scan for ink in the padding. Worth
remembering for any future custom-font work.

**...and a fix for one quirk can be structurally unable to do its job.** That
rasterization check was wrong, and wrong in a way no passing run could reveal:
an SVG loaded through an `<img>` is **clipped to its own viewBox**, so ink
painted outside the viewBox can never reach the padding being scanned. The
check could only ever have returned zero. It sat green over a guitar melody
whose tab stave was painted 30px below the SVG's declared height — found by
eye, in a screenshot, not by the suite written to catch exactly that. It is
now a DOM bounds comparison again, which is trustworthy once more because
VexFlow draws paths rather than font glyphs, so the original quirk no longer
applies. Two lessons worth more than the bug: a test that *cannot* fail is
worse than no test, because it also stops you looking; and when the reason
for a workaround disappears, the workaround needs revisiting rather than
inheriting.

**Measure the library, don't argue about it.** Melody notation was hand-rolled
over three objections to VexFlow — that it could only be themed through JS,
that its output wouldn't be addressable for an editor, and that fonts were a
risk. A 60-line probe page against the real library refuted all three in
minutes. The hand-rolled renderer was ~660 lines and still owed beaming. None
of the three objections were unreasonable in the abstract; all three were cheap
to check and none had been.

**A CDN's version label is a claim, not evidence.** The wrapper was then
written against "VexFlow 4.2.2" from cdnjs — which is actually **VexFlow
3.0.9** from 2019. The npm package carries a stale legacy `releases/` directory
that was never rebuilt, cdnjs mirrors it, and every 4.x label there serves
byte-identical 3.0.9 (verifiable with a SHA256 of two "different" versions).
Every "verified API fact" recorded about that build — index-first
`addModifier`, no `Dot.buildAndAttach`, no `getSVGElement` — was really 3.0.9
behaviour, and the oddness of an API contradicting its own documentation was
the clue that got ignored. What caught it was the browser console saying so.
Check the version string *inside* the file.

**A check that counts the wrong set passes vacuously — and this suite has now
done it twice.** The first was `rasterOverflow` above. The second: the colour
assertion scanned `svg.querySelectorAll("*")` for elements with a `fill`
attribute, and on VexFlow 5 that set is **empty**, because the colours live on
the `<svg>` root and children inherit. `notOverridden === 0` was trivially
true, so the suite green-lit notation rendering black on a black page. Both
bugs share one shape: an assertion over a collection, with nothing asserting
the collection is non-empty. Every such check here now carries an explicit
`paintedCount > 0`-style guard, and that guard is the assertion that actually
matters.

**Assert what is painted, not what was declared.** The melody zoom check watched
the SVG's `width` *attribute* grow and passed — while the staff on screen never
changed size, because VexFlow's `resize()` leaves an inline `style.width` behind
and an inline style outranks a presentation attribute. The attribute was real,
settable, and completely inert. This is the same failure as the two above wearing
different clothes: the check measured something adjacent to the property it
cared about. `getBoundingClientRect()` would have caught it on the first run, and
the suite now also pins that the painted box and the declared box agree — a drift
between them means the score is being squeezed into a box of the wrong size,
which it silently had been.

**Some bugs only pixels can see.** Exporting a PDF from a non-chord sub-tab
produced a page with the right number of pages, the right number of images, each
at a plausible size — and every keyboard on it collapsed into a stack of black
keys at the left edge, because the board was hidden when it was measured. No
structural assertion available caught it; comparing the chord-tab capture with
the melody-tab capture pixel-for-pixel caught it instantly and located it
exactly. When two paths are supposed to produce *the same* output, comparing the
outputs directly beats enumerating properties you hope are sufficient.

## Adding a suite

Drop a `*.test.mjs` in `suites/`:

```js
import { openApp, board, layoutDoc } from "../lib/browser.mjs";

export const name = "What this protects";
export const needsBrowser = false; // omit unless the suite is pure

export default async function run({ browser, origin, t }) {
  const page = await openApp(browser, origin, {
    viewport: { width: 1400, height: 1000 },
    state: {
      "cv-sections-piano": board(["Gm", "Bb"]),
      "cv-twohands": "true",
      "cv-instrument": "layout",
      "cv-layout": layoutDoc([{ id: "b1", type: "chord", span: 6, ref: { … } }]),
    },
  });

  t.ok("label", condition, "detail shown when it fails");
  t.near("label", actual, expected, tolerance, "px");
  t.noErrors(page);          // fails on any pageerror or console.error
  await page.close();
}
```

`openApp` seeds `localStorage`, reloads so the app boots against that state, and
waits two animation frames plus a beat — the black keys are placed a frame after
a card is built, and the sheet repaginates after that. Measure only once it has
settled.

A recorder collects results rather than throwing, so one run reports every
failure instead of stopping at the first.

## Gotchas

- **`offsetWidth`/`offsetHeight`, not `getBoundingClientRect`, for layout maths.**
  The sheet sits inside a fit-to-screen `transform: scale()`; `offset*` ignores
  ancestor transforms and `getBoundingClientRect` does not. Use
  `getBoundingClientRect` when you want what the user *sees* — clipping,
  overlap, painted size — which is what most assertions here want.
- **Keys are named by construction.** `board(["Gm","Bb"])` builds section
  `s_test` with chords `c_0_Gm`, `c_1_Bb`; reference those ids in a layout doc.
- Screenshots are not written by default. Add `await page.screenshot({ path: … })`
  inside a suite while debugging, and look at the image — a passing number and a
  correct picture are not the same thing.
