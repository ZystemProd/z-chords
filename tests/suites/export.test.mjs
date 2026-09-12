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

  // --- a melody block survives rasterization ---
  //
  // VexFlow 5 draws every glyph as <text> in Bravura, which is exactly the kind
  // of thing html2canvas is known to drop. The sheet is the only place a melody
  // reaches the PDF, so it is the only place this can be checked.
  {
    const melody = {
      id: "m_exp",
      name: "Riff",
      clef: "treble",
      timeSig: { num: 4, den: 4 },
      keyRoot: "C",
      tempo: 96,
      events: [
        { den: 4, dots: 0, rest: false, notes: [{ midi: 60 }] },
        { den: 8, dots: 0, rest: false, notes: [{ midi: 64 }] },
        { den: 8, dots: 0, rest: false, notes: [{ midi: 67 }] },
      ],
    };
    const p = await openApp(browser, origin, {
      state: {
        "cv-instrument": "layout",
        "cv-melodies-piano": JSON.stringify([melody]),
        "cv-layout": layoutDoc([
          {
            id: "b_mel",
            type: "melody",
            span: 12,
            ref: { instrument: "piano", melodyId: "m_exp" },
          },
        ]),
      },
    });
    await p.click("#layoutExport");
    await p
      .waitForFunction(() => document.querySelectorAll(".pdf-preview-page").length > 0, {
        timeout: 30000,
      })
      .catch(() => {});

    // Not just "an image exists": an image of BLANK PAPER would satisfy that.
    // Read the raster back and count non-background pixels, which is the only
    // way to tell notation that captured from notation that silently did not.
    const ink = await p.evaluate(async () => {
      const img = document.querySelector(".pdf-preview-slice img");
      if (!img) return { found: false };
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 32 && d[i] < 128 && d[i + 1] < 128 && d[i + 2] < 128) dark++;
      }
      return { found: true, dark, total: d.length / 4 };
    });
    t.ok("a melody block rasterizes", ink.found, "no image placed for the melody");
    t.ok(
      "the notation actually appears in the raster",
      ink.found && ink.dark > 200,
      `only ${ink.dark} dark pixels of ${ink.total} — the block captured as blank paper`
    );
    t.noErrors(p);
    await p.close();
  }

  // --- the toolbar export works from every sub-tab, not just a chord tab ---
  //
  // `updateTabsUI` hides #boards with an inline display:none off the chord tabs,
  // and cloneNode copies that — so the capture rasterized a zero-sized element
  // and html2canvas threw on a zero-length gradient ("addColorStop ... non-
  // finite"). The preview died with a console error rather than degrading, so
  // `noErrors` is doing real work here.
  //
  // Two sub-tabs, because the bug was never melody-specific: any tab that hides
  // the board hit it, and Melody was just the newest way to reach it.
  for (const sub of ["melody", "scales"]) {
    const p = await openApp(browser, origin, {
      state: {
        "cv-instrument": "piano",
        "cv-subtabs": JSON.stringify({ piano: sub }),
        "cv-sections-piano": board(["C", "Am"]),
      },
    });
    await p.click("#downloadPdf");
    await p
      .waitForFunction(() => document.querySelectorAll(".pdf-preview-page").length > 0, {
        timeout: 30000,
      })
      .catch(() => {});
    const info = await p.evaluate(() => {
      const img = document.querySelector(".pdf-preview-slice img");
      return {
        pages: document.querySelectorAll(".pdf-preview-page").length,
        w: img ? img.naturalWidth : 0,
      };
    });
    t.ok(`${sub} tab: the toolbar export still produces a page`, info.pages >= 1, `${info.pages}`);
    t.ok(`${sub} tab: the capture has a real width`, info.w > 500, `${info.w}px`);
    t.noErrors(p);
    await p.close();
  }

  // The same song must export IDENTICALLY whichever sub-tab is on screen — the
  // board is the export's subject, and which tab you happen to be looking at is
  // not part of the song. Compared as pixels, because the two defects this
  // guards (a 40px width drift, and black keys stacked at left:0) both produced
  // a page that looked plausible in every structural measure.
  {
    const shots = {};
    for (const sub of ["chord", "melody"]) {
      const p = await openApp(browser, origin, {
        state: {
          "cv-instrument": "piano",
          "cv-subtabs": JSON.stringify({ piano: sub }),
          "cv-sections-piano": board(["C", "Am"]),
        },
      });
      await p.click("#downloadPdf");
      await p
        .waitForFunction(() => document.querySelectorAll(".pdf-preview-page").length > 0, {
          timeout: 30000,
        })
        .catch(() => {});
      shots[sub] = await p.evaluate(async () => {
        const img = document.querySelector(".pdf-preview-slice img");
        if (!img) return null;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: c.width,
          h: c.height,
          data: [...c.getContext("2d").getImageData(0, 0, c.width, c.height).data],
        };
      });
      await p.close();
    }
    const a = shots.chord;
    const b = shots.melody;
    t.ok("both sub-tabs produced a capture", !!a && !!b);
    if (a && b) {
      t.ok(
        "the capture is the same size from either sub-tab",
        a.w === b.w && a.h === b.h,
        `${a.w}x${a.h} vs ${b.w}x${b.h}`
      );
      let differing = 0;
      if (a.w === b.w && a.h === b.h) {
        for (let i = 0; i < a.data.length; i += 4) {
          const d =
            Math.abs(a.data[i] - b.data[i]) +
            Math.abs(a.data[i + 1] - b.data[i + 1]) +
            Math.abs(a.data[i + 2] - b.data[i + 2]);
          if (d > 8) differing++;
        }
      }
      t.ok(
        "the capture is pixel-identical from either sub-tab",
        differing === 0,
        `${differing} pixels differ — the hidden-board capture is not the same page`
      );
    }
  }
}
