// Blocks fit their column, in both hand modes, for sections and single chords.
//
// The bug this exists for: `.piano-scroll` is `overflow-x: hidden` and the rule
// that makes it scroll is scoped to `#boards`, which a layout block is not
// inside — so a three-octave keybed was simply cut off at the block edge.
import { openApp, board, layoutDoc } from "../lib/browser.mjs";

export const name = "Layout block fit";

export default async function run({ browser, origin, t }) {
  const sections = board(["Gm", "Bb", "Ebmaj7", "F"]);
  const doc = layoutDoc([
    { id: "b_sec", type: "section", span: 12, ref: { instrument: "piano", sectionId: "s_test" } },
    ...[12, 6, 4].map((n) => ({
      id: `b_c${n}`,
      type: "chord",
      span: n,
      ref: { instrument: "piano", sectionId: "s_test", chordId: "c_1_Bb" },
    })),
  ]);

  for (const twoHands of [true, false]) {
    for (const width of [1120, 1400]) {
      const page = await openApp(browser, origin, {
        viewport: { width, height: 1100 },
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
          const br = block.getBoundingClientRect();
          block.querySelectorAll(".card.preview").forEach((card) => {
            const piano = card.querySelector(".piano");
            if (!piano) return;
            const pr = piano.getBoundingClientRect();
            const white = [...piano.querySelectorAll(".white-key")].map((k) => k.getBoundingClientRect());
            out.push({
              id: block.dataset.blockId,
              sym: (card.querySelector("h3") || {}).textContent || "",
              escapesRight: pr.right - br.right,
              inside: white.filter((r) => r.right <= br.right + 0.5 && r.left >= br.left - 0.5).length,
              nWhite: white.length,
              expected: document.querySelector(".lb-section-chords.piano-two-hands-mode") ? 21 : white.length,
            });
          });
        });
        return out;
      });

      const ctx = `${twoHands ? "two-hands" : "one-hand"} @${width}`;
      t.ok(`${ctx}: cards rendered`, rows.length > 0, `${rows.length}`);
      for (const r of rows) {
        t.ok(`${ctx} ${r.id} ${r.sym}: all keys visible`, r.inside === r.nWhite, `${r.inside}/${r.nWhite}`);
        t.ok(`${ctx} ${r.id} ${r.sym}: inside its block`, r.escapesRight <= 0.5, `overflows ${r.escapesRight.toFixed(1)}px`);
      }

      // Two-hands drops the section grid to one column, exactly as the board does.
      const cols = await page.evaluate(() => {
        const g = document.querySelector(".lb-section-chords");
        if (!g) return null;
        return getComputedStyle(g).gridTemplateColumns.split(" ").length;
      });
      if (cols !== null) {
        t.ok(`${ctx}: section grid columns`, cols === (twoHands ? 1 : 2), `got ${cols}`);
      }

      t.noErrors(page);
      await page.close();
    }
  }
}
