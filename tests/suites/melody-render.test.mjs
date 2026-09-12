// melody-render.js: structural correctness of the notation SVG.
//
// The renderer is now a VexFlow wrapper, so this suite no longer checks
// engraving VexFlow is responsible for (stem direction, glyph shapes, ledger
// arithmetic). It checks the seams — the things OUR code decides and that a
// library upgrade or a refactor could silently break:
//
//   - the canvas is sized from real content. VexFlow will happily paint above
//     y=0; nothing in it clamps to the SVG we declared. The previous
//     hand-rolled renderer shipped this bug twice (a note a few ledger lines
//     out, and a clef on an EMPTY melody, where there is no note to be "far"
//     from the staff at all), so the check outlived the renderer it was
//     written for.
//   - every painted colour is overridable by CSS. This is the single property
//     the whole VexFlow decision rests on: it writes colours as presentation
//     attributes (fill="black"), which any CSS rule outranks, so theming and
//     .pdf-capture work exactly as they do for .gc-* and .gs-*. If a future
//     version switched to inline style="" instead, that would silently stop
//     being true and every melody would print black-on-black in dark mode.
//   - our own contract survives: one `data-event-index` per rendered item
//     (what melody-editor.js hit-tests), and the stave geometry the editor
//     inverts clicks against.
//   - beams, ties and rests are actually drawn. Beaming is the capability this
//     swap was made for, so it gets pinned rather than assumed.
//
// Uses tests/fixtures/melody-preview.html, which renders a fixed set of
// melodies through the real renderMelodySVG and tags each with
// data-case-label so this suite can query them by name.
export const name = "Melody notation rendering";

export default async function run({ browser, origin, t }) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  await page.goto(`${origin}/tests/fixtures/melody-preview.html`, {
    waitUntil: "networkidle0",
  });
  await page.waitForFunction("window.__melodyPreviewReady === true", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 200));

  const report = await page.evaluate(async () => {
    const out = [];

    // Does anything paint outside the SVG's own declared box?
    //
    // This check has been wrong twice, in opposite directions, and both
    // failures are worth keeping in mind before "simplifying" it:
    //
    //  1. It rasterized the SVG as-is and scanned a padded canvas for ink.
    //     STRUCTURALLY INCAPABLE of catching anything: an SVG loaded through an
    //     <img> is clipped to its own viewBox, so ink outside can never reach
    //     the padding. It passed a guitar melody whose tab stave was painted
    //     30px below the declared height.
    //  2. It measured the DOM with getBoundingClientRect, on the stated
    //     assumption that "VexFlow draws paths, so the boxes mean what they
    //     say". VexFlow 5 draws every glyph as <text> in Bravura, and a text
    //     element's box is the FONT'S LINE BOX — a 10px notehead measures
    //     160px tall. It reported ~38px of overflow on notation that is
    //     perfectly inside its box, and it had only been passing because the
    //     renderer was inflating the SVG using that same wrong number.
    //
    // So: rasterize, but EXPAND THE VIEWBOX FIRST. That is what fixes (1) —
    // the clipping region is the viewBox, so widening it makes the surrounding
    // area renderable, and ink out there lands in the scanned band. And it is
    // immune to (2), because pixels are pixels: a font's line box paints
    // nothing.
    async function paintedOverflow(svg) {
      const PAD = 40;
      const vb = (svg.getAttribute("viewBox") || "").split(/\s+/).map(Number);
      if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n)))
        return { over: 0, culprit: "no viewBox" };
      const [vx, vy, vw, vh] = vb;

      const clone = svg.cloneNode(true);
      clone.setAttribute(
        "viewBox",
        `${vx - PAD} ${vy - PAD} ${vw + PAD * 2} ${vh + PAD * 2}`
      );
      clone.setAttribute("width", String(vw + PAD * 2));
      clone.setAttribute("height", String(vh + PAD * 2));
      // Standalone in an <img> the page's CSS does not apply, so the colours
      // come from VexFlow's own presentation attributes on the root — black on
      // a white canvas, which is exactly what we want to scan for.
      const url =
        "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(new XMLSerializer().serializeToString(clone));

      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch (_) {
        return { over: 0, culprit: "could not rasterize" };
      }

      const c = document.createElement("canvas");
      c.width = vw + PAD * 2;
      c.height = vh + PAD * 2;
      const cx = c.getContext("2d");
      cx.fillStyle = "#fff";
      cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(img, 0, 0);
      const data = cx.getImageData(0, 0, c.width, c.height).data;

      const inked = (x, y) => {
        const i = (y * c.width + x) * 4;
        // Anti-aliasing puts faint grey at every edge; only count real ink.
        return data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200;
      };

      // How far into the padding band ink reaches, on any side.
      let worst = 0;
      let culprit = null;
      const note = (d, where) => {
        if (d > worst) {
          worst = d;
          culprit = where;
        }
      };
      for (let y = 0; y < c.height; y += 1) {
        for (let x = 0; x < c.width; x += 1) {
          if (!inked(x, y)) continue;
          if (x < PAD) note(PAD - x, "left");
          else if (x >= c.width - PAD) note(x - (c.width - PAD) + 1, "right");
          if (y < PAD) note(PAD - y, "top");
          else if (y >= c.height - PAD) note(y - (c.height - PAD) + 1, "bottom");
        }
      }
      // A pixel of anti-aliasing at the boundary is not a bug.
      return { over: worst > 2 ? worst : 0, culprit };
    }

    for (const c of document.querySelectorAll(".case")) {
      const svg = c.querySelector("svg");
      const stamped = [...svg.querySelectorAll("[data-event-index]")];

      // Every element that actually paints, INCLUDING the <svg> root: VexFlow
      // puts fill/stroke on the root and lets most children inherit, so a
      // descendant-only scan finds almost nothing and silently passes. That is
      // exactly how black-on-black dark mode got through once already.
      const painted = [svg, ...svg.querySelectorAll("*")].filter((e) => {
        const f = e.getAttribute("fill");
        const st = e.getAttribute("stroke");
        return (f && f !== "none" && f !== "white") || (st && st !== "none");
      });
      const notOverridden = painted.filter((e) => {
        const cs = getComputedStyle(e);
        const black = (v) => v === "rgb(0, 0, 0)" || v === "black";
        // Black means no CSS rule reached it — the page paints in --text.
        const fillBlack = e.getAttribute("fill") && e.getAttribute("fill") !== "none"
          ? black(cs.fill) : false;
        const strokeBlack = e.getAttribute("stroke") && e.getAttribute("stroke") !== "none"
          ? black(cs.stroke) : false;
        return fillBlack || strokeBlack;
      }).length;

      out.push({
        label: c.dataset.caseLabel,
        print: c.classList.contains("pdf-capture"),
        // Our own fallback SVG (drums, or a missing library) rather than a
        // VexFlow score — themed by the .ms-placeholder class alone, so it
        // carries no colour attributes and needs its own check.
        placeholder: !!svg.querySelector(".ms-placeholder"),
        placeholderFill: (() => {
          const n = svg.querySelector(".ms-placeholder");
          return n ? getComputedStyle(n).fill : null;
        })(),
        viewBox: svg.getAttribute("viewBox"),
        width: +svg.getAttribute("width"),
        height: +svg.getAttribute("height"),
        stamped: stamped.length,
        // Distinct event indices, i.e. how many of OUR events made it through.
        events: new Set(stamped.map((n) => n.getAttribute("data-event-index"))).size,
        notes: svg.querySelectorAll(".ms-note").length,
        rests: svg.querySelectorAll(".ms-rest").length,
        beams: svg.querySelectorAll(".ms-beam").length,
        ties: svg.querySelectorAll(".ms-tie").length,
        // 5.x draws every glyph as <text> at a SMuFL codepoint, so a bare
        // text query returns noteheads and clefs too. Fret numbers live on the
        // tab notes specifically.
        tabNums: [...svg.querySelectorAll(".vf-tabnote text")].map((n) => n.textContent),
        // A cross notehead is its own SMuFL glyph, so it is distinguishable
        // from a normal one by codepoint. U+E0A9 is noteheadXBlack.
        crossHeads: [...svg.querySelectorAll("text")].filter((n) =>
          (n.textContent || "").includes("")
        ).length,
        accidentals: svg.querySelectorAll(".vf-accidental").length,
        paintedCount: painted.length,
        notOverridden,
        hasGeometry:
          svg.hasAttribute("data-stave-bottom-y") &&
          svg.hasAttribute("data-stave-ref-bottom") &&
          svg.hasAttribute("data-step-px"),
        stepPx: +svg.getAttribute("data-step-px"),
        noteXs: stamped.map((g) => Math.round(g.getBoundingClientRect().left)),
        overflow: await paintedOverflow(svg),
      });
    }
    return out;
  });

  const byLabel = Object.fromEntries(report.map((r) => [r.label, r]));
  const expectCase = (label) => {
    t.ok(`${label}: case present`, !!byLabel[label], "fixture did not render this case");
    return byLabel[label] || {};
  };

  for (const r of report) {
    t.ok(`${r.label}: has a viewBox`, !!r.viewBox);
    t.ok(`${r.label}: non-degenerate size`, r.width > 0 && r.height > 0, `${r.width}x${r.height}`);
    t.ok(
      `${r.label}: nothing painted outside the declared box`,
      r.overflow.over === 0,
      `${r.overflow.culprit} extends ${r.overflow.over}px beyond the SVG's own width/height`
    );
    // The property the whole renderer choice rests on, asserted in whichever
    // direction the case calls for: on screen every painted element must move
    // OFF VexFlow's own black, and under .pdf-capture every one must be forced
    // TO black. Checking only the first direction would have called the print
    // case a failure for doing exactly the right thing.
    if (r.placeholder) {
      // Not a score: assert the one thing that matters, that it is themed
      // rather than left at the SVG default black.
      t.ok(
        `${r.label}: the placeholder text is themed`,
        !!r.placeholderFill && r.placeholderFill !== "rgb(0, 0, 0)",
        `placeholder fill is ${r.placeholderFill}`
      );
      continue;
    }
    // `paintedCount > 0` is not decoration: without it the whole check passes
    // trivially on an empty set, which is how it once approved notation that
    // was rendering black on a black page.
    t.ok(
      `${r.label}: something actually paints`,
      r.paintedCount > 0,
      "no element carries a colour — the colour assertions below would be vacuous"
    );
    if (r.print) {
      t.ok(
        `${r.label}: print forces every painted colour to black`,
        r.paintedCount > 0 && r.notOverridden === r.paintedCount,
        `${r.notOverridden} of ${r.paintedCount} are black`
      );
    } else {
      t.ok(
        `${r.label}: CSS overrides every painted colour`,
        r.paintedCount > 0 && r.notOverridden === 0,
        `${r.notOverridden} of ${r.paintedCount} painted elements kept VexFlow's own black`
      );
    }
  }

  // --- our contract with the editor ---
  for (const label of ["treble-basic", "bass-basic", "grand-basic", "guitar-tab"]) {
    const r = expectCase(label);
    t.ok(`${label}: publishes stave geometry for click→pitch`, !!r.hasGeometry);
    t.ok(`${label}: a staff step is half the line gap`, r.stepPx === 5, `${r.stepPx}`);
  }

  // 9 events, one of which crosses a barline and is drawn as two tied pieces:
  // 10 rendered items, but still 9 distinct event indices. That distinction is
  // the whole reason the editor addresses events rather than noteheads.
  {
    const r = expectCase("treble-basic");
    t.ok("treble-basic: every event is addressable", r.events === 9, `${r.events} distinct indices`);
    t.ok("treble-basic: a rest is drawn as a rest", r.rests === 1, `${r.rests}`);
    t.ok(
      "treble-basic: consecutive 8ths are beamed",
      r.beams >= 1,
      "no beam drawn — beaming is the capability this renderer was chosen for"
    );
  }

  t.ok(
    "treble-ledgers-accidentals: nothing clipped by a note far off the staff",
    (expectCase("treble-ledgers-accidentals").overflow || {}).over === 0
  );

  {
    const r = expectCase("tied-across-barline");
    t.ok("tied-across-barline: a tie is drawn", r.ties >= 1, `${r.ties}`);
    t.ok(
      "tied-across-barline: the split event stays one event",
      r.events === 5 && r.stamped === 6,
      `${r.events} events over ${r.stamped} rendered items`
    );
  }

  {
    const r = expectCase("guitar-tab");
    t.ok(
      "guitar-tab: one fret number per note",
      JSON.stringify(r.tabNums) === JSON.stringify(["0", "3", "5", "7", "8"]),
      JSON.stringify(r.tabNums)
    );
  }

  // Proportional spacing: 16th, 8th, quarter, half, whole at one pitch in one
  // bar. The gap AFTER each note reflects that note's own duration, so the
  // gaps must grow — a fixed per-note spacing would make them all equal.
  {
    const xs = expectCase("spacing-progression").noteXs || [];
    t.ok("spacing-progression: five notes", xs.length === 5, `${xs.length}`);
    if (xs.length === 5) {
      const gaps = xs.slice(1).map((x, i) => x - xs[i]);
      t.ok(
        "spacing-progression: a longer note claims more room than a shorter one",
        gaps[gaps.length - 1] > gaps[0],
        `gaps: ${gaps.join(", ")}`
      );
      // Sublinear, as real engraving is: a whole note does not claim 16x a
      // 16th's room just because it sounds 16x longer.
      t.ok(
        "spacing-progression: growth is sublinear, not a flat multiply",
        gaps[gaps.length - 1] < gaps[0] * 16,
        `first ${gaps[0]}, last ${gaps[gaps.length - 1]}`
      );
    }
  }

  t.ok("empty-melody: renders a staff and no notes", expectCase("empty-melody").stamped === 0);

  // Drums are the same model with clef "drums", so the checks that matter are
  // the ones where a drum event is NOT like a pitched one.
  {
    const r = expectCase("drums-beat");
    t.ok("drums-beat: draws real notation, not a placeholder", !r.placeholder);
    t.ok(
      "drums-beat: one stamped item per event",
      r.events === 4 && r.notes === 4,
      `${r.events} events, ${r.notes} notes`
    );
    t.ok("drums-beat: eighths are beamed", r.beams >= 1, `${r.beams}`);
    t.ok(
      "drums-beat: cymbals get a cross notehead",
      r.crossHeads >= 4,
      `${r.crossHeads} cross noteheads for 4 hi-hat hits`
    );
    // The failure this guards is specific: a GM percussion number read as a
    // pitch. Kick 36 would be C2 — four ledger lines below a treble staff —
    // which shows up as ink outside the box the staff was sized for.
    t.ok(
      "drums-beat: nothing is placed as if its GM number were a pitch",
      r.overflow.over === 0,
      `${r.overflow.culprit} extends ${r.overflow.over}px beyond the SVG`
    );
    t.ok(
      "drums-beat: no accidentals on a kit",
      r.accidentals === 0,
      `${r.accidentals} accidentals drawn`
    );
  }
  {
    const r = expectCase("drums-empty");
    t.ok("drums-empty: an empty beat still draws a staff", !r.placeholder && r.stamped === 0);
  }

  // The degraded path must still BE a path: this is the only case that reaches
  // the placeholder now that drums render real notation, and without it the
  // `if (r.placeholder)` branch above would silently stop executing.
  {
    const r = expectCase("library-unavailable");
    t.ok(
      "library-unavailable: falls back to a readable placeholder",
      r.placeholder === true,
      "no placeholder drawn when VexFlow is missing"
    );
  }

  if (errors.length) t.ok("no JS errors", false, errors.join(" | "));
  else t.ok("no JS errors", true);

  await page.close();
}
