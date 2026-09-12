// The piano tab must be unaffected by anything the layout sheet needed.
//
// makePiano is shared, so a change made for the sheet can silently alter the
// board. These are the numbers the board rendered before that work started.
import { openApp, board } from "../lib/browser.mjs";

export const name = "Board regression";

export default async function run({ browser, origin, t }) {
  for (const twoHands of [false, true]) {
    const page = await openApp(browser, origin, {
      state: {
        "cv-sections-piano": board(["Bb", "Gm"]),
        "cv-twohands": String(twoHands),
        "cv-instrument": "piano",
        "cv-subtabs": { piano: "chord" },
      },
    });

    const r = await page.evaluate(() => {
      const piano = document.querySelector("#boards .piano");
      if (!piano) return null;
      const white = [...piano.querySelectorAll(".white-key")].map((k) => k.getBoundingClientRect());
      const black = [...piano.querySelectorAll(".black-key")].map((k) => k.getBoundingClientRect());
      // How far each black key's centre sits from the nearest white-key edge.
      // Constant = correct geometry; drifting = a bad percentage basis.
      const offsets = black.map((b) => {
        const c = b.left + b.width / 2;
        return Math.min(...white.map((w) => Math.abs(c - w.right)));
      });
      return {
        whiteW: white[0]?.width ?? 0,
        blackW: black[0]?.width ?? 0,
        nWhite: white.length,
        nBlack: black.length,
        offsetSpread: Math.max(...offsets) - Math.min(...offsets),
      };
    });

    const hands = twoHands ? "two-hands" : "one-hand";
    t.ok(`${hands}: board renders`, !!r, "no piano on #boards");
    if (!r) continue;

    // 0.9 preview scale applies in one-hand; two-hands is drawn unscaled.
    const scale = twoHands ? 1 : 0.9;
    t.ok(`${hands}: key count`, r.nWhite === (twoHands ? 21 : 14), `${r.nWhite}`);
    t.near(`${hands}: white key width`, r.whiteW, 36 * scale, 0.6, "px");
    t.near(`${hands}: black key width`, r.blackW, 20 * scale, 0.6, "px");
    t.ok(
      `${hands}: black keys evenly placed`,
      r.offsetSpread < 1.5,
      `offset spread ${r.offsetSpread.toFixed(2)}px across the keyboard`
    );
    t.noErrors(page);
    await page.close();
  }
}
