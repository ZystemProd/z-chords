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
| `keys` | Keyboard proportions at eight block widths in both hand modes. |
| `layout` | Blocks fit their column: sections and single chords, both hand modes, two viewport widths. |
| `board` | The piano tab is unchanged by anything done for the layout sheet. |
| `export` | The sheet export produces pages, and text blocks stay real PDF text. |
| `guitar` | Chord diagrams and the scale fretboard render, fit, and stay print-safe. |

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
