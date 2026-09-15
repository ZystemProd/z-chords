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

  // --- horizontal snap: the ghost sits at the SLOT under the pointer ---
  //
  // The x now tracks the pointer, because a click's x decides which note it
  // writes over. What it must not do is float: it snaps to a slot -- an event
  // already on the staff, or the empty tail of the last bar -- because those
  // are the only places a click can actually write, and a preview sitting
  // anywhere else previews something that cannot happen.
  //
  // Snap is the claim to pin, and it takes both halves: the x must CHANGE
  // between slots (or the ghost is simply stuck), and must NOT change within
  // one (or it is not snapping at all).
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await focusStaff(page);
    await pressAndWait(page, "N");

    const readPair = async () => {
      const g = await ghost(page);
      const cursor = await page.evaluate(() => {
        const r = document.querySelector(".ms-insert-cursor");
        return r ? Number(r.getAttribute("x")) + Number(r.getAttribute("width")) / 2 : null;
      });
      return { cx: g && g.cx, cursor };
    };

    const seen = [];
    for (const frac of [0.1, 0.2, 0.4, 0.75, 0.9]) {
      await moveMouseOverStaff(page, frac, 0.35);
      seen.push(await readPair());
    }
    t.ok(
      "the ghost's X follows the pointer across slots",
      new Set(seen.map((s) => s.cx)).size > 1,
      JSON.stringify(seen.map((s) => s.cx))
    );
    t.ok(
      "the ghost and the insertion cursor always mark the same slot",
      seen.every((s) => s.cursor !== null && Math.abs(s.cursor - s.cx) < 1),
      JSON.stringify(seen)
    );

    // Two pointer positions a few pixels apart land in the same slot, so the
    // ghost must not move between them. Measured against the slot's own
    // painted width rather than a guessed pixel count.
    const nudge = await page.evaluate(() => {
      const svg = document.querySelector(".melody-editor-staff svg");
      const n = svg.querySelector('[data-event-index="0"]');
      const r = n.getBoundingClientRect();
      return { x: r.left + r.width * 0.35, x2: r.left + r.width * 0.6, y: r.top + r.height / 2 };
    });
    await page.mouse.move(nudge.x, nudge.y, { steps: 2 });
    await new Promise((r) => setTimeout(r, 120));
    const a = await readPair();
    await page.mouse.move(nudge.x2, nudge.y, { steps: 2 });
    await new Promise((r) => setTimeout(r, 120));
    const b = await readPair();
    t.ok(
      "moving within one note's slot does not move the ghost",
      a.cx != null && a.cx === b.cx,
      `${a.cx} vs ${b.cx}`
    );
    t.ok(
      "the note under the pointer is marked as the one about to be replaced",
      await page.evaluate(
        () =>
          document.querySelectorAll('.ms-replace-target[data-event-index="0"]').length > 0
      )
    );
    t.noErrors(page);
    await page.close();
  }

  // --- clicking a note in note-input mode REPLACES it ---
  //
  // The MuseScore model, and the point of the whole slot mechanism: input does
  // not always go to the end of the melody. A full replace, palette duration
  // included -- so correcting a note can fix its rhythm as well as its pitch.
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await focusStaff(page);
    await pressAndWait(page, "N");

    const before = await read(page);
    t.ok("fixture starts with two quarter notes", before.events.length === 2);

    // Pick the eighth-note value first, so the replace is visible in the
    // duration as well as the pitch. "2" is positional: whole, half, quarter,
    // eighth, sixteenth -- so 4 is the eighth.
    await pressAndWait(page, "4");
    const clicked = await page.evaluate(() => {
      const svg = document.querySelector(".melody-editor-staff svg");
      const n = svg.querySelector('[data-event-index="0"]');
      const r = n.getBoundingClientRect();
      // Well above the note itself, so the pitch written is plainly not the
      // one that was there: the top line of a treble staff is F5 (midi 77).
      const lines = [...svg.querySelectorAll("path")]
        .map((el) => el.getBBox())
        .filter((b) => b.height < 2 && b.width > 100)
        .map((b) => b.y)
        .sort((x, y) => x - y);
      const pt = svg.createSVGPoint();
      pt.x = 0;
      pt.y = lines[0]; // the top line
      const screenY = pt.matrixTransform(svg.getScreenCTM()).y;
      svg.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          clientX: r.left + r.width / 2,
          clientY: screenY,
        })
      );
      return true;
    });
    void clicked;
    await new Promise((r) => setTimeout(r, 200));
    const after = await read(page);
    t.ok(
      "the melody does not grow — the note was replaced, not inserted",
      after.events.length === 2,
      `${before.events.length} -> ${after.events.length}`
    );
    t.ok(
      "the clicked note takes the pitch that was clicked",
      after.events[0].notes[0].midi === 77,
      `midi ${after.events[0].notes[0].midi}`
    );
    t.ok(
      "the clicked note takes the palette's duration too",
      after.events[0].den === 8 && after.events[0].dots === 0,
      `den ${after.events[0].den}, dots ${after.events[0].dots}`
    );
    t.ok(
      "the note after it is untouched",
      after.events[1].notes[0].midi === before.events[1].notes[0].midi,
      `${after.events[1].notes[0].midi}`
    );
    t.noErrors(page);
    await page.close();
  }

  // --- clicking a note with note-input OFF still only selects it ---
  //
  // The mode is the whole guard: browsing a melody by clicking through it must
  // never overwrite anything.
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await page.evaluate(() => {
      const n = document.querySelector('[data-event-index="0"]');
      const r = n.getBoundingClientRect();
      n.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          clientX: r.left + r.width / 2,
          clientY: r.top,
        })
      );
    });
    await new Promise((r) => setTimeout(r, 200));
    const after = await read(page);
    t.ok(
      "a click outside note-input mode changes no pitch",
      after.events.length === 2 && after.events[0].notes[0].midi === 60,
      JSON.stringify(after.events)
    );
    t.ok(
      "it selects instead",
      await page.evaluate(() => document.querySelectorAll(".ms-selected").length > 0)
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

  // --- the filler rests are not a wall between the pointer and the staff ---
  //
  // The empty tail of the last bar is now drawn as rests, which puts glyphs
  // over exactly the region a click used to land on bare staff. They belong to
  // no event and carry no data-event-index, so the hit test has to fall through
  // them and write a note at the pitch clicked — if it ever stops, note entry
  // silently dies everywhere except the sliver before the first filler.
  {
    const page = await openApp(browser, origin, {
      state: pianoState(
        melody({ events: [{ den: 4, dots: 0, rest: false, notes: [{ midi: 64 }] }] })
      ),
    });
    const seen = await page.evaluate(() => {
      document.querySelector('.melody-editor-controls button[title^="Note input"]').click();
      const svg = document.querySelector(".melody-editor-staff svg");
      const fillers = [...svg.querySelectorAll(".ms-rest-filler")];
      // The half rest that fills beats 3-4 sits on the middle line, which in
      // treble clef is B4 — a specific, checkable pitch.
      const target = fillers[fillers.length - 1];
      const r = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        })
      );
      return fillers.length;
    });
    await new Promise((r) => setTimeout(r, 200));
    const after = await read(page);
    t.ok("the unwritten tail of the bar is drawn as rests", seen >= 1, `${seen} fillers`);
    t.ok(
      "clicking a filler rest writes a note rather than selecting it",
      after.events.length === 2,
      `${after.events.length} events`
    );
    t.ok(
      "the note lands at the pitch the filler was covering (middle line = B4)",
      after.events.length === 2 && after.events[1].notes[0].midi === 71,
      `got ${after.events.length === 2 ? after.events[1].notes[0].midi : "nothing"}`
    );
    t.noErrors(page);
    await page.close();
  }
}
