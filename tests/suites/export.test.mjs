// The sheet export produces pages, and text blocks stay real PDF text.
//
// Export reuses the auto-flow path's placement vocabulary, so this also guards
// that contract: if layout.js stopped emitting what savePdfFromLayout expects,
// the preview would come back empty.
import { openApp, board, layoutDoc } from "../lib/browser.mjs";

export const name = "Sheet export";

export default async function run({ browser, origin, t }) {
  const page = await openApp(browser, origin, {
    state: {
      "cv-sections-piano": board(["Gm", "Bb", "Ebmaj7", "F"]),
      "cv-twohands": "true",
      "cv-instrument": "layout",
      "cv-layout": layoutDoc([
        { id: "b1", type: "section", span: 12, ref: { instrument: "piano", sectionId: "s_test" } },
        { id: "b2", type: "text", span: 12, text: "Capo 3, half-time feel", style: "heading" },
        {
          id: "b3",
          type: "fretboard",
          span: 12,
          scale: { root: "A", mode: "minorPentatonic", shapeIndex: 0, labelMode: "interval", view: "shape" },
        },
        { id: "b4", type: "chord", span: 6, ref: { instrument: "piano", sectionId: "s_test", chordId: "c_1_Bb" } },
      ]),
    },
  });

  await page.click("#layoutExport");
  // html2canvas rasterizes every block; give it room on a slow machine.
  await page.waitForFunction(
    () => document.querySelectorAll(".pdf-preview-page").length > 0,
    { timeout: 30000 }
  ).catch(() => {});

  const res = await page.evaluate(() => ({
    modalOpen: getComputedStyle(document.getElementById("pdfPreviewModal")).display,
    pages: document.querySelectorAll(".pdf-preview-page").length,
    images: document.querySelectorAll(".pdf-preview-slice").length,
    texts: [...document.querySelectorAll(".pdf-preview-text")].map((n) => n.textContent),
    exportDisabled: document.getElementById("pdfExportConfirm").disabled,
  }));

  t.ok("preview modal opens", res.modalOpen === "block", res.modalOpen);
  t.ok("pages rendered", res.pages >= 1, `${res.pages}`);
  t.ok("blocks placed as images", res.images >= 1, `${res.images}`);
  t.ok(
    "text block stays selectable text, not a raster",
    res.texts.some((x) => x.includes("Capo 3")),
    JSON.stringify(res.texts)
  );
  t.ok("export button enabled", !res.exportDisabled);
  t.noErrors(page);
  await page.close();
}
