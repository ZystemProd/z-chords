// The melody editor, on piano→melody and guitar→melody.
//
// Melodies are board content: authored on the instrument's own sub-tab, stored
// under `cv-melodies-<inst>`, and placed on the Layout sheet by reference. This
// suite drives the real UI — actual clicks on the staff, actual keystrokes —
// rather than calling the model directly, because the editor's whole job is
// translating pointer and keyboard input into model edits. The parts most worth
// pinning:
//   - clicking empty staff adds a note AT THE PITCH CLICKED (the click→y→
//     staffStep→midi inverse is easy to get subtly wrong, and a half-step
//     error looks plausible);
//   - clicking a note SELECTS rather than adds (both are clicks on one SVG);
//   - edits reach `cv-melodies-<inst>` and survive a reload;
//   - each instrument's melodies are its own, the way its chords already are —
//     this is the failure the per-board split exists to prevent;
//   - a sheet block RENDERS a melody but never edits it, so the sheet cannot
//     become a second, competing editor.
import { openApp, layoutDoc } from "../lib/browser.mjs";

export const name = "Melody editor";

const melody = (over = {}) => ({
  id: "m_test",
  name: "Riff",
  clef: "treble",
  timeSig: { num: 4, den: 4 },
  keyRoot: "C",
  tempo: 96,
  events: [
    { den: 4, dots: 0, rest: false, notes: [{ midi: 60 }] },
    { den: 4, dots: 0, rest: false, notes: [{ midi: 64 }] },
  ],
  ...over,
});

// piano→melody, with one melody on the piano board.
const pianoState = (m = melody()) => ({
  "cv-instrument": "piano",
  "cv-subtabs": JSON.stringify({ piano: "melody" }),
  "cv-melodies-piano": JSON.stringify([m]),
});

async function read(page, inst = "piano") {
  return page.evaluate((i) => {
    const list = JSON.parse(localStorage.getItem(`cv-melodies-${i}`) || "[]");
    return list[0] || null;
  }, inst);
}

async function selectFirstNote(page) {
  await page.evaluate(() => {
    const n = document.querySelector('[data-event-index="0"]');
    const r = n.getBoundingClientRect();
    n.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      })
    );
  });
}

export default async function run({ browser, origin, t }) {
  // --- the tab renders an editor, and it is addressable ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    const info = await page.evaluate(() => {
      const panel = document.getElementById("melodyPanel");
      const host = document.querySelector(".melody-editor-staff");
      const svg = host && host.querySelector("svg");
      return {
        panelShown: panel ? getComputedStyle(panel).display !== "none" : false,
        boardHidden:
          getComputedStyle(document.getElementById("boards")).display === "none",
        controls: document.querySelectorAll(".melody-editor-controls").length,
        focusable: host ? host.tabIndex === 0 : false,
        noteheads: svg ? svg.querySelectorAll(".ms-note").length : 0,
        addressable: svg ? svg.querySelectorAll("[data-event-index]").length : 0,
        hasStaveGeometry:
          !!svg &&
          svg.hasAttribute("data-stave-bottom-y") &&
          svg.hasAttribute("data-step-px"),
        listed: document.querySelectorAll(".melody-list-item").length,
      };
    });
    t.ok("the melody sub-tab shows its panel", info.panelShown);
    t.ok("the chord board is not also on screen", info.boardHidden);
    t.ok("the editor draws the stored melody", info.noteheads === 2, JSON.stringify(info));
    t.ok("the editor has its controls", info.controls === 1, `${info.controls}`);
    t.ok("the melody is listed", info.listed === 1, `${info.listed}`);
    t.ok("staff is focusable for keyboard editing", info.focusable);
    t.ok("every event is addressable for hit-testing", info.addressable >= 2, `${info.addressable}`);
    t.ok("stave geometry is published for click→pitch", info.hasStaveGeometry);
    t.noErrors(page);
    await page.close();
  }

  // --- clicking a notehead selects it, rather than adding a note ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    const before = await read(page);
    await selectFirstNote(page);
    const after = await read(page);
    const selected = await page.evaluate(
      () => document.querySelectorAll(".ms-selected").length
    );
    t.ok(
      "clicking a note does not add one",
      after.events.length === before.events.length,
      `${before.events.length} -> ${after.events.length}`
    );
    t.ok("clicking a note marks it selected", selected >= 1, `${selected}`);
    t.noErrors(page);
    await page.close();
  }

  // --- clicking empty staff adds a note at the clicked pitch ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    // Click exactly on the staff's bottom line, which in treble clef is E4
    // (midi 64) — a specific, checkable pitch rather than "some note appeared".
    const clicked = await page.evaluate(() => {
      const svg = document.querySelector(".melody-editor-staff svg");
      const bottomY = Number(svg.getAttribute("data-stave-bottom-y"));
      const pt = svg.createSVGPoint();
      // Far to the right of the existing notes, so it lands on empty staff.
      // From the viewBox, not the width attribute: the editor zooms by scaling
      // width/height while the viewBox stays in VexFlow's user space, which is
      // the space this point is built in.
      const [, , vbW] = svg.getAttribute("viewBox").split(/\s+/).map(Number);
      pt.x = vbW - 30;
      pt.y = bottomY;
      const screen = pt.matrixTransform(svg.getScreenCTM());
      svg.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: screen.x, clientY: screen.y })
      );
      return { x: screen.x, y: screen.y };
    });
    await new Promise((r) => setTimeout(r, 150));
    const after = await read(page);
    const added = after.events[after.events.length - 1];
    t.ok("clicking empty staff adds an event", after.events.length === 3, `${after.events.length}`);
    t.ok(
      "the added note is the pitch that was clicked (bottom line = E4)",
      added && !added.rest && added.notes[0].midi === 64,
      `got midi ${added && added.notes && added.notes[0] && added.notes[0].midi} at ${JSON.stringify(clicked)}`
    );
    t.noErrors(page);
    await page.close();
  }

  // --- zoom does not break click→pitch ---
  //
  // The whole reason zoom is applied to the SVG's width/height rather than by
  // re-rendering or by a CSS transform is that getScreenCTM already folds the
  // viewBox→viewport ratio in, so the editor's inverse needs no knowledge of it.
  // That claim is only worth as much as a test that clicks at a zoom level.
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    const zoomed = await page.evaluate(() => {
      const before = document.querySelector(".melody-editor-staff svg");
      // The PAINTED width, not the width attribute. VexFlow's resize() leaves an
      // inline style.width behind, which outranks the attribute — so an earlier
      // version of this check watched the attribute grow while the staff on
      // screen never changed size at all. Measure what the user sees.
      const w0 = before.getBoundingClientRect().width;
      const vb0 = before.getAttribute("viewBox");
      [...document.querySelectorAll(".melody-zoom button")]
        .find((b) => b.textContent === "+")
        .click();
      const after = document.querySelector(".melody-editor-staff svg");
      return {
        grew: after.getBoundingClientRect().width > w0 + 1,
        // The declared box and the painted box must agree: if they drift, the
        // score is being squeezed or stretched into a box of the wrong size.
        boxAgrees:
          Math.abs(
            after.getBoundingClientRect().width - Number(after.getAttribute("width"))
          ) <= 1,
        // The user space must NOT change — everything the editor inverts against
        // (data-step-px, data-stave-bottom-y) is expressed in it.
        sameUserSpace: after.getAttribute("viewBox") === vb0,
      };
    });
    t.ok("zoom enlarges the rendered staff", zoomed.grew);
    t.ok("the staff is painted at its declared size", zoomed.boxAgrees);
    t.ok("zoom leaves the notation's user space alone", zoomed.sameUserSpace);

    const clickedPitch = await page.evaluate(() => {
      const svg = document.querySelector(".melody-editor-staff svg");
      const [, , vbW] = svg.getAttribute("viewBox").split(/\s+/).map(Number);
      const pt = svg.createSVGPoint();
      pt.x = vbW - 30;
      pt.y = Number(svg.getAttribute("data-stave-bottom-y"));
      const screen = pt.matrixTransform(svg.getScreenCTM());
      svg.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: screen.x, clientY: screen.y })
      );
      return true;
    });
    void clickedPitch;
    await new Promise((r) => setTimeout(r, 150));
    const m = await read(page);
    const added = m.events[m.events.length - 1];
    t.ok(
      "the bottom line is still E4 when zoomed in",
      m.events.length === 3 && added.notes[0].midi === 64,
      `${m.events.length} events, last midi ${added && added.notes[0] && added.notes[0].midi}`
    );
    t.noErrors(page);
    await page.close();
  }

  // --- keyboard: transpose and delete ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await selectFirstNote(page);
    await page.evaluate(() => document.querySelector(".melody-editor-staff").focus());
    await page.keyboard.press("ArrowUp");
    await new Promise((r) => setTimeout(r, 120));
    let m = await read(page);
    t.ok(
      "ArrowUp raises the selected note a semitone",
      m.events[0].notes[0].midi === 61,
      `midi ${m.events[0].notes[0].midi}`
    );

    await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.up("Shift");
    await new Promise((r) => setTimeout(r, 120));
    m = await read(page);
    t.ok(
      "Shift+ArrowDown drops it an octave",
      m.events[0].notes[0].midi === 49,
      `midi ${m.events[0].notes[0].midi}`
    );

    await page.keyboard.press("Delete");
    await new Promise((r) => setTimeout(r, 120));
    m = await read(page);
    t.ok("Delete removes the selected note", m.events.length === 1, `${m.events.length}`);
    t.noErrors(page);
    await page.close();
  }

  // --- edits persist across a reload ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await selectFirstNote(page);
    await page.evaluate(() => document.querySelector(".melody-editor-staff").focus());
    await page.keyboard.press("ArrowUp");
    await new Promise((r) => setTimeout(r, 150));
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 600));
    const m = await read(page);
    t.ok(
      "an edited pitch survives a reload",
      m && m.events[0].notes[0].midi === 61,
      `midi ${m && m.events[0] && m.events[0].notes[0].midi}`
    );
    // And the melody's name is not collateral damage of an edit — the editor
    // normalizes the melody on every change, so a field it does not know about
    // is exactly the kind of thing that quietly disappears.
    t.ok("the melody keeps its name through an edit", m && m.name === "Riff", `${m && m.name}`);
    t.noErrors(page);
    await page.close();
  }

  // --- the two boards' melodies are separate, like their chords ---
  {
    const page = await openApp(browser, origin, {
      state: {
        "cv-instrument": "piano",
        "cv-subtabs": JSON.stringify({ piano: "melody", guitar: "melody" }),
        "cv-melodies-piano": JSON.stringify([melody()]),
        "cv-melodies-guitar": JSON.stringify([
          melody({ id: "m_gtr", name: "Lick", clef: "guitar" }),
        ]),
      },
    });
    await selectFirstNote(page);
    await page.evaluate(() => document.querySelector(".melody-editor-staff").focus());
    await page.keyboard.press("ArrowUp");
    await new Promise((r) => setTimeout(r, 150));

    // Switch to the guitar tab and confirm it shows its own melody, untouched.
    await page.evaluate(() =>
      document.querySelector('.instrument-tabs .tab[data-instrument="guitar"]').click()
    );
    await new Promise((r) => setTimeout(r, 300));
    const shown = await page.evaluate(() => {
      const input = document.querySelector(".melody-list-item .melody-name");
      return {
        name: input ? input.value : null,
        tabNums: document.querySelectorAll(".vf-tabnote text").length,
      };
    });
    const gtr = await read(page, "guitar");
    t.ok("the guitar tab shows the guitar's melody", shown.name === "Lick", `${shown.name}`);
    t.ok("a guitar melody renders tab numbers", shown.tabNums === 2, `${shown.tabNums}`);
    t.ok(
      "editing the piano melody left the guitar's alone",
      gtr.events[0].notes[0].midi === 60,
      `midi ${gtr.events[0].notes[0].midi}`
    );
    // Tab position is DERIVED from pitch, so it is deliberately not written
    // into storage — recomputed on every render instead, which is what stops a
    // stored fret from going stale when the pitch is edited.
    t.ok(
      "derived tab positions are not persisted",
      (gtr.events || []).every((e) => e.rest || e.notes.every((n) => n.fret === undefined)),
      JSON.stringify(gtr.events)
    );
    t.noErrors(page);
    await page.close();
  }

  // --- the sheet renders a melody by reference, and does not edit it ---
  {
    const page = await openApp(browser, origin, {
      state: {
        "cv-instrument": "layout",
        "cv-melodies-piano": JSON.stringify([melody()]),
        "cv-layout": layoutDoc([
          {
            id: "b_mel",
            type: "melody",
            span: 12,
            ref: { instrument: "piano", melodyId: "m_test" },
          },
        ]),
      },
    });
    const info = await page.evaluate(() => {
      const host = document.querySelector(".lb-melody-host");
      return {
        drawn: host ? host.querySelectorAll(".ms-note").length : 0,
        editors: document.querySelectorAll("#layoutFlow .melody-editor").length,
        missing: document.querySelectorAll("#layoutFlow .lb-missing").length,
      };
    });
    t.ok("a melody block draws the referenced melody", info.drawn === 2, JSON.stringify(info));
    t.ok("the sheet places no editor", info.editors === 0, `${info.editors}`);

    // A reference whose melody is gone degrades visibly rather than silently —
    // the one failure mode references have, and the reason they beat snapshots.
    const gone = await page.evaluate(() => {
      localStorage.setItem("cv-melodies-piano", "[]");
      return true;
    });
    void gone;
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 500));
    const after = await page.evaluate(() => ({
      drawn: document.querySelectorAll("#layoutFlow .ms-note").length,
      placeholders: document.querySelectorAll("#layoutFlow .lb-missing").length,
    }));
    t.ok(
      "a melody whose source is gone shows a placeholder",
      after.drawn === 0 && after.placeholders === 1,
      JSON.stringify(after)
    );
    t.noErrors(page);
    await page.close();
  }
}
