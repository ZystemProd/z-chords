// Note-input mode on the melody staff: the toggle that gates writing, and the
// two visual cursors that appear while it's on.
//
// Split out of melody-editor.test.mjs so a change to just this feature can be
// checked in a few seconds instead of running that suite's full 70+ checks.
//
// What's worth pinning here specifically:
//   - letters/R/a blank-staff click do NOTHING until note-input is switched
//     on (N, the toggle button, or off again via Escape) -- the whole point
//     of the mode is that browsing a melody cannot accidentally write to it;
//   - the ghost notehead only shows in note-input mode, over the staff;
//   - the ghost's Y snaps to the nearest staff line/space rather than
//     following the raw pixel -- that's what "snap" means vertically;
//   - the ghost's X does NOT follow the mouse at all: insertion is
//     caret-based, not click-x-based, so the ghost has to sit at the actual
//     insertion slot or it previews a place a click could never write to.
//     This was broken once (the ghost floated with the pointer) and is
//     exactly the regression this suite exists to catch.
import { openApp } from "../lib/browser.mjs";

export const name = "Melody note input";

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

const pianoState = (m = melody()) => ({
  "cv-instrument": "piano",
  "cv-subtabs": JSON.stringify({ piano: "melody" }),
  "cv-melodies-piano": JSON.stringify([m]),
});

async function read(page) {
  return page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem("cv-melodies-piano") || "[]");
    return list[0] || null;
  });
}

async function focusStaff(page) {
  await page.evaluate(() => document.querySelector(".melody-editor-staff").focus());
}

function pressAndWait(page, key, ms = 100) {
  return page.keyboard.press(key).then(() => new Promise((r) => setTimeout(r, ms)));
}

async function noteInputButton(page) {
  return page.evaluateHandle(() =>
    [...document.querySelectorAll(".melody-editor-controls button")].find((b) =>
      (b.title || "").startsWith("Note input")
    )
  );
}

async function moveMouseOverStaff(page, xFrac = 0.5, yFrac = 0.35) {
  const box = await page.evaluate((fx, fy) => {
    const r = document.querySelector(".melody-editor-staff svg").getBoundingClientRect();
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  }, xFrac, yFrac);
  await page.mouse.move(box.x, box.y, { steps: 3 });
  await new Promise((r) => setTimeout(r, 150));
}

async function ghost(page) {
  return page.evaluate(() => {
    const n = document.querySelector(".ms-input-notehead");
    return n ? { cx: Number(n.getAttribute("cx")), cy: Number(n.getAttribute("cy")) } : null;
  });
}

export default async function run({ browser, origin, t }) {
  // --- writing is gated behind the toggle ---
  {
    const page = await openApp(browser, origin, {
      state: pianoState(melody({ events: [] })),
    });
    await focusStaff(page);
    await pressAndWait(page, "C");
    let m = await read(page);
    t.ok("a letter does nothing before note-input is on", m.events.length === 0, `${m.events.length}`);

    const btn = await noteInputButton(page);
    t.ok("the note-input toggle button exists", !!(await btn.jsonValue()));

    await pressAndWait(page, "N");
    const active = await page.evaluate(
      () => document.querySelector(".melody-editor-staff").classList.contains("ms-note-input-active")
    );
    t.ok("N switches note-input mode on", active);

    await pressAndWait(page, "C");
    m = await read(page);
    t.ok("a letter writes once note-input is on", m.events.length === 1, `${m.events.length}`);

    await pressAndWait(page, "Escape");
    const activeAfterEscape = await page.evaluate(() =>
      document.querySelector(".melody-editor-staff").classList.contains("ms-note-input-active")
    );
    t.ok("Escape switches note-input mode back off", !activeAfterEscape);

    await pressAndWait(page, "D");
    m = await read(page);
    t.ok(
      "a letter does nothing again after Escape",
      m.events.length === 1,
      `${m.events.length}`
    );
    t.noErrors(page);
    await page.close();
  }

  // --- a blank staff click only writes in note-input mode ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    const before = await read(page);
    await page.evaluate(() => {
      const svg = document.querySelector(".melody-editor-staff svg");
      const [, , vbW] = svg.getAttribute("viewBox").split(/\s+/).map(Number);
      const pt = svg.createSVGPoint();
      pt.x = vbW - 30;
      pt.y = Number(svg.getAttribute("data-stave-bottom-y"));
      const screen = pt.matrixTransform(svg.getScreenCTM());
      svg.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: screen.x, clientY: screen.y })
      );
    });
    await new Promise((r) => setTimeout(r, 150));
    let after = await read(page);
    t.ok(
      "a blank click does nothing before note-input is on",
      after.events.length === before.events.length,
      `${before.events.length} -> ${after.events.length}`
    );
    t.noErrors(page);
    await page.close();
  }

  // --- the ghost preview: shown only in note-input mode, over the staff ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await focusStaff(page);

    await moveMouseOverStaff(page);
    t.ok("no ghost before note-input is on", (await ghost(page)) === null);

    await pressAndWait(page, "N");
    await moveMouseOverStaff(page);
    t.ok("the ghost notehead appears once note-input is on", (await ghost(page)) !== null);

    await page.mouse.move(5, 5); // off the staff entirely
    await new Promise((r) => setTimeout(r, 150));
    t.ok("the ghost disappears once the pointer leaves the staff", (await ghost(page)) === null);

    await moveMouseOverStaff(page);
    await pressAndWait(page, "N"); // toggle back off
    t.ok("the ghost is cleared when note-input is switched off", (await ghost(page)) === null);
    t.noErrors(page);
    await page.close();
  }

  // --- vertical snap: the ghost locks to a staff line/space ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await focusStaff(page);
    await pressAndWait(page, "N");

    const stepPx = await page.evaluate(
      () => Number(document.querySelector(".melody-editor-staff svg").getAttribute("data-step-px"))
    );
    // Two mouse Ys a few pixels apart, both nearer the SAME staff line/space,
    // must resolve to the exact same ghost Y -- if it just followed the pixel,
    // these would differ.
    const box = await page.evaluate(() => {
      const r = document.querySelector(".melody-editor-staff svg").getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    const baseY = box.top + box.height * 0.4;
    await page.mouse.move(box.left + box.width * 0.5, baseY, { steps: 2 });
    await new Promise((r) => setTimeout(r, 120));
    const g1 = await ghost(page);
    await page.mouse.move(box.left + box.width * 0.5, baseY + Math.max(1, stepPx * 0.3), { steps: 2 });
    await new Promise((r) => setTimeout(r, 120));
    const g2 = await ghost(page);
    t.ok(
      "a small mouse movement within one staff step keeps the same Y",
      g1 && g2 && g1.cy === g2.cy,
      `${g1 && g1.cy} vs ${g2 && g2.cy}`
    );
    t.noErrors(page);
    await page.close();
  }

  // --- horizontal snap: the ghost sits at the insertion slot, not the mouse ---
  //
  // Insertion is caret-based -- a click's x has never decided WHERE in the
  // sequence a note lands, only its y decides the pitch -- so the ghost must
  // not track the pointer horizontally at all. This is the exact bug report
  // that prompted this suite: the ghost used to float with the mouse.
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await focusStaff(page);
    await pressAndWait(page, "N");

    const xs = [];
    for (const frac of [0.15, 0.4, 0.75]) {
      await moveMouseOverStaff(page, frac, 0.35);
      const g = await ghost(page);
      xs.push(g && g.cx);
    }
    t.ok(
      "the ghost's X is identical no matter where the mouse is horizontally",
      xs.every((x) => x === xs[0]),
      JSON.stringify(xs)
    );

    // And that fixed X must actually BE the insertion slot the blue cursor
    // marks -- not just some other constant -- so the two indicators agree.
    const cursorX = await page.evaluate(() => {
      const r = document.querySelector(".ms-insert-cursor");
      return r ? Number(r.getAttribute("x")) + Number(r.getAttribute("width")) / 2 : null;
    });
    t.ok(
      "the ghost sits at the same slot the insertion cursor highlights",
      cursorX !== null && Math.abs(cursorX - xs[0]) < 1,
      `ghost cx ${xs[0]} vs cursor centre ${cursorX}`
    );
    t.noErrors(page);
    await page.close();
  }

  // --- the insertion cursor tracks the caret ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await focusStaff(page);
    t.ok("no insertion cursor before note-input is on", (await page.evaluate(
      () => !document.querySelector(".ms-insert-cursor")
    )));

    await pressAndWait(page, "N");
    const xAtEnd = await page.evaluate(() => {
      const r = document.querySelector(".ms-insert-cursor");
      return r ? Number(r.getAttribute("x")) : null;
    });
    t.ok("the insertion cursor appears once note-input is on", xAtEnd !== null);

    // Move the caret to the first note; the cursor should move left to sit
    // next to it instead of staying at the end of the melody.
    await page.evaluate(() => {
      document.querySelector('[data-event-index="0"]').dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
    });
    await new Promise((r) => setTimeout(r, 150));
    const xAtCaret = await page.evaluate(() => {
      const r = document.querySelector(".ms-insert-cursor");
      return r ? Number(r.getAttribute("x")) : null;
    });
    t.ok(
      "moving the caret moves the insertion cursor",
      xAtCaret !== null && xAtCaret < xAtEnd,
      `${xAtCaret} vs ${xAtEnd}`
    );
    t.noErrors(page);
    await page.close();
  }
}
