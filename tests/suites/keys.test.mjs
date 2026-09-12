// Keyboard proportions at every block width.
//
// The bug this exists for: black keys were sized in fixed pixels while white
// keys reflowed, so in a narrow block the black keys ended up WIDER than the
// white keys they sit between. The invariant is therefore not a size — it is a
// ratio that must hold at every width.
import { openApp, board, layoutDoc } from "../lib/browser.mjs";

export const name = "Keyboard proportions";

// Black key width as a fraction of a white key (script.js BLACK_KEY_WIDTH_RATIO).
const RATIO = 20 / 36;
const SPANS = [12, 10, 8, 6, 5, 4, 3, 2];

export default async function run({ browser, origin, t }) {
  const sections = board(["Bb"]);
  const doc = layoutDoc(
    SPANS.map((n) => ({
      id: `s${n}`,
      type: "chord",
      span: n,
      ref: { instrument: "piano", sectionId: "s_test", chordId: "c_0_Bb" },
    }))
  );

  for (const twoHands of [true, false]) {
    const page = await openApp(browser, origin, {
      viewport: { width: 1400, height: 1400 },
      state: {
        "cv-sections-piano": sections,
        "cv-twohands": String(twoHands),
        "cv-instrument": "layout",
        "cv-layout": doc,
      },
    });

    const rows = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll(".layout-block").forEach((block) => {
        const piano = block.querySelector(".piano");
        if (!piano) return;
        const br = block.getBoundingClientRect();
        const scroller = piano.closest(".piano-scroll");
        const sr = scroller ? scroller.getBoundingClientRect() : br;
        const white = [...piano.querySelectorAll(".white-key")].map((k) => k.getBoundingClientRect());
        const black = [...piano.querySelectorAll(".black-key")].map((k) => k.getBoundingClientRect());
        out.push({
          id: block.dataset.blockId,
          whiteW: white.length ? white[0].width : 0,
          blackW: black.length ? black[0].width : 0,
          nWhite: white.length,
          nBlack: black.length,
          whiteInside: white.filter((r) => r.right <= br.right + 0.5 && r.left >= br.left - 0.5).length,
          blackInside: black.filter((r) => r.right <= br.right + 0.5 && r.left >= br.left - 0.5).length,
          // Vertical clipping: scaling the wrong element once made the box k²
          // tall while the keyboard was k, silently cutting off the labels.
          vClip: Math.max(0, piano.getBoundingClientRect().bottom - sr.bottom),
        });
      });
      return out;
    });

    const hands = twoHands ? "two-hands" : "one-hand";
    t.ok(`${hands}: every span rendered`, rows.length === SPANS.length, `${rows.length}/${SPANS.length}`);

    for (const r of rows) {
      const where = `${hands} ${r.id}`;
      t.ok(`${where}: black narrower than white`, r.blackW < r.whiteW, `${r.blackW.toFixed(2)} vs ${r.whiteW.toFixed(2)}`);
      t.near(`${where}: black/white ratio`, r.whiteW ? r.blackW / r.whiteW : 0, RATIO, 0.02);
      t.ok(`${where}: no white key clipped`, r.whiteInside === r.nWhite, `${r.whiteInside}/${r.nWhite}`);
      t.ok(`${where}: no black key clipped`, r.blackInside === r.nBlack, `${r.blackInside}/${r.nBlack}`);
      t.ok(`${where}: not vertically clipped`, r.vClip <= 0.5, `${r.vClip.toFixed(2)}px cut off`);
    }
    t.noErrors(page);
    await page.close();
  }
}
