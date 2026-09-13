// The Tie tool: sustaining a note into the next one of the same pitch.
//
// Split out of melody-editor.test.mjs so a change to just tying can be
// checked in a few seconds. The pure logic (notesMatchPitch, pruneInvalidTies,
// the playback merge) is pinned directly in melody-model.test.mjs, which is
// faster still (no browser) -- this suite covers the UI wiring on top of it:
// the button's enabled/disabled state, the T shortcut, the rendered curve,
// and that an edit which breaks a tie actually clears it end to end.
import { openApp } from "../lib/browser.mjs";

export const name = "Melody tie tool";

const melody = (over = {}) => ({
  id: "m_test",
  name: "Riff",
  clef: "treble",
  timeSig: { num: 4, den: 4 },
  keyRoot: "C",
  tempo: 96,
  events: [
    { den: 4, dots: 0, rest: false, notes: [{ midi: 64 }] }, // E4
    { den: 4, dots: 0, rest: false, notes: [{ midi: 64 }] }, // E4 -- same pitch, tie-able
    { den: 4, dots: 0, rest: false, notes: [{ midi: 67 }] }, // G4 -- different pitch
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

async function clickEvent(page, index) {
  await page.evaluate((i) => {
    document
      .querySelector(`[data-event-index="${i}"]`)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, index);
  await new Promise((r) => setTimeout(r, 120));
}

async function tieButton(page) {
  return page.evaluateHandle(() =>
    [...document.querySelectorAll(".melody-editor-controls button")].find((b) =>
      (b.title || "").startsWith("Tie")
    )
  );
}

async function tieButtonState(page) {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll(".melody-editor-controls button")].find((el) =>
      (el.title || "").startsWith("Tie")
    );
    return b ? { present: true, disabled: b.disabled, active: b.classList.contains("is-active") } : { present: false };
  });
}

export default async function run({ browser, origin, t }) {
  // --- the button reflects whether the selected note CAN tie ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await clickEvent(page, 0); // E4, next note is also E4 -> tie-able
    let s = await tieButtonState(page);
    t.ok("tie button exists", s.present);
    t.ok("tie is enabled when the next note shares its pitch", !s.disabled, JSON.stringify(s));
    t.ok("tie is not active before it's toggled", !s.active);

    await clickEvent(page, 1); // E4, next note is G4 -> not tie-able
    s = await tieButtonState(page);
    t.ok("tie is disabled when the next note is a different pitch", s.disabled, JSON.stringify(s));

    await clickEvent(page, 2); // last note, nothing after it
    s = await tieButtonState(page);
    t.ok("tie is disabled on the last note", s.disabled);
    t.noErrors(page);
    await page.close();
  }

  // --- toggling: the T key and the button both flip event.tie ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await clickEvent(page, 0);
    await page.keyboard.press("T");
    await new Promise((r) => setTimeout(r, 150));
    let m = await read(page);
    t.ok("T sets tie on the selected event", m.events[0].tie === true, JSON.stringify(m.events[0]));

    let s = await tieButtonState(page);
    t.ok("the button shows active once tied", s.active);

    await page.keyboard.press("T");
    await new Promise((r) => setTimeout(r, 150));
    m = await read(page);
    t.ok("T again clears the tie", !m.events[0].tie, JSON.stringify(m.events[0]));

    // The button itself is also a live control, not just the shortcut.
    const btn = await tieButton(page);
    await btn.asElement().click();
    await new Promise((r) => setTimeout(r, 150));
    m = await read(page);
    t.ok("clicking the tie button sets tie too", m.events[0].tie === true, JSON.stringify(m.events[0]));
    t.noErrors(page);
    await page.close();
  }

  // --- the curve actually renders ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await clickEvent(page, 0);
    await page.keyboard.press("T");
    await new Promise((r) => setTimeout(r, 150));
    const ties = await page.evaluate(
      () => document.querySelectorAll(".melody-editor-staff .ms-tie").length
    );
    t.ok("a tied pair draws a tie curve", ties >= 1, `${ties}`);
    t.noErrors(page);
    await page.close();
  }

  // --- an edit that breaks a tie clears it (pruneInvalidTies wired up) ---
  {
    const page = await openApp(browser, origin, { state: pianoState() });
    await clickEvent(page, 0);
    await page.keyboard.press("T");
    await new Promise((r) => setTimeout(r, 150));
    let m = await read(page);
    t.ok("setup: the tie is set before the edit", m.events[0].tie === true);

    // Transpose the FOLLOWING note up a step -- the tie on event 0 no longer
    // points at a matching pitch and must be cleared, not left stale.
    await clickEvent(page, 1);
    await page.keyboard.press("ArrowUp");
    await new Promise((r) => setTimeout(r, 150));
    m = await read(page);
    t.ok(
      "transposing the tied-to note clears the stale tie",
      !m.events[0].tie,
      JSON.stringify(m.events.slice(0, 2))
    );
    t.noErrors(page);
    await page.close();
  }

  // --- ties don't apply to drum beats ---
  {
    const page = await openApp(browser, origin, {
      state: {
        "cv-instrument": "drums",
        "cv-subtabs": JSON.stringify({ drums: "beat" }),
        "cv-melodies-drums": JSON.stringify([
          melody({ id: "m_beat", clef: "drums", events: [{ den: 8, rest: false, notes: [{ midi: 36 }] }] }),
        ]),
      },
    });
    const hasTieButton = await page.evaluate(() =>
      [...document.querySelectorAll(".melody-editor-controls button, .drum-grid-controls button")].some(
        (b) => (b.title || "").startsWith("Tie")
      )
    );
    t.ok("no tie control on a drum beat", !hasTieButton);
    t.noErrors(page);
    await page.close();
  }
}
