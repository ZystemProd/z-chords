// Guitar blocks: chord diagrams and the scale fretboard.
//
// These share `.lb-section-chords` and the `.pdf-capture` inking with the piano
// blocks, so they are the regression check for changes made for either.
import { openApp, board, layoutDoc } from "../lib/browser.mjs";

export const name = "Guitar blocks";

export default async function run({ browser, origin, t }) {
  const page = await openApp(browser, origin, {
    state: {
      "cv-sections-guitar": board(["Am", "C", "F", "G", "Dm"], { id: "s_g", name: "Riff" }),
      "cv-instrument": "layout",
      "cv-layout": layoutDoc([
        { id: "gsec", type: "section", span: 12, ref: { instrument: "guitar", sectionId: "s_g" } },
        { id: "gc", type: "chord", span: 3, ref: { instrument: "guitar", sectionId: "s_g", chordId: "c_0_Am" } },
        {
          id: "gfb",
          type: "fretboard",
          span: 12,
          scale: { root: "A", mode: "minorPentatonic", shapeIndex: 0, labelMode: "interval", view: "shape" },
        },
      ]),
    },
  });

  const res = await page.evaluate(() => {
    const diagrams = [];
    document.querySelectorAll(".layout-block").forEach((block) => {
      const br = block.getBoundingClientRect();
      block.querySelectorAll("svg.gc-diagram").forEach((svg) => {
        const r = svg.getBoundingClientRect();
        diagrams.push({
          id: block.dataset.blockId,
          w: r.width,
          h: r.height,
          escapesRight: r.right - br.right,
          dots: svg.querySelectorAll(".gc-dot, .gc-barre").length,
        });
      });
    });
    const fb = document.querySelector(".lb-fretboard svg.gs-fretboard");
    return {
      diagrams,
      fretboard: fb
        ? {
            dots: fb.querySelectorAll(".gs-dot").length,
            roots: fb.querySelectorAll(".gs-dot-root").length,
            rootLabels: fb.querySelectorAll(".gs-label-on-root").length,
            // The conversion away from inline colours is what lets the sheet
            // print black-on-white; a regression would reintroduce them.
            inlineColoured: [...fb.querySelectorAll("*")].filter(
              (el) => el.getAttribute("fill") || el.getAttribute("stroke")
            ).length,
          }
        : null,
    };
  });

  t.ok("chord diagrams rendered", res.diagrams.length > 0, `${res.diagrams.length}`);
  for (const d of res.diagrams) {
    t.ok(`${d.id}: diagram has finger dots`, d.dots > 0);
    t.ok(`${d.id}: diagram inside its block`, d.escapesRight <= 0.5, `overflows ${d.escapesRight.toFixed(1)}px`);
    t.ok(`${d.id}: diagram not collapsed`, d.w > 20 && d.h > 20, `${d.w}x${d.h}`);
  }

  t.ok("fretboard block rendered", !!res.fretboard);
  if (res.fretboard) {
    t.ok("fretboard marks scale tones", res.fretboard.dots > 0, `${res.fretboard.dots}`);
    t.ok("fretboard marks roots", res.fretboard.roots > 0, `${res.fretboard.roots}`);
    t.ok(
      "every root dot has a print-safe label",
      res.fretboard.roots === res.fretboard.rootLabels,
      `${res.fretboard.roots} dots vs ${res.fretboard.rootLabels} labels`
    );
    t.ok(
      "fretboard uses CSS classes, not inline colours",
      res.fretboard.inlineColoured === 0,
      `${res.fretboard.inlineColoured} elements carry fill/stroke attributes`
    );
  }
  t.noErrors(page);
  await page.close();
}
