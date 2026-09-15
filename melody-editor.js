// The melody editor: the staff itself is the editing surface.
//
// Contract mirrors `createChordEditor` in guitar-chords.js — hand it a host
// element and a melody, it owns the DOM inside that host and reports every
// committed change through `onChange`. It knows nothing about boards, tabs,
// layout blocks or storage; whoever creates it decides what a melody belongs
// to and when to save.
//
// Clicking a notehead or rest selects it; clicking anywhere else on the staff
// adds a note at the pitch clicked. Both are clicks on the same SVG, and the
// hit test decides which — the same shape of interaction createChordEditor
// uses for fret positions. That works because melody-render.js stamps
// `data-event-index` on every note and rest it draws; addressability is the
// whole reason that renderer emits each element itself.

import { renderMelodySVG, clampScale, MIN_SCALE, MAX_SCALE } from "./melody-render.js";
import {
  createMelody,
  normalizeMelody,
  assignTab,
  melodyPlaybackSchedule,
  midiFromStaffStep,
  DURATION_DENOMS,
  notesMatchPitch,
  pruneInvalidTies,
} from "./melody-model.js";
import { playNotes, stopAll } from "./audio.js";

const DURATION_LABEL = {
  1: "Whole",
  2: "Half",
  4: "Quarter",
  8: "Eighth",
  16: "Sixteenth",
};

// SMuFL codepoints for the note values, in Bravura.
//
// The palette used to be plain digits, on the reasoning that "note symbols live
// in a music font and a button's label is ordinary UI text". That stopped being
// true with VexFlow 5: it registers Bravura through the FontFace API at load, so
// the face is in `document.fonts` and any CSS on the page can ask for it — we
// get the glyphs without shipping, hosting or fetching a font ourselves.
//
// Unicode's own musical symbols (U+1D15D and friends) would need no font, but
// nothing in a normal system font stack actually draws them.
const DURATION_GLYPH = {
  1: "", // noteWhole
  2: "", // noteHalfUp
  4: "", // noteQuarterUp
  8: "", // note8thUp
  16: "", // note16thUp
};
const GLYPH_DOT = ""; // augmentationDot
const GLYPH_REST = ""; // restQuarter

const GLYPH_NOTE_INPUT = "✎"; // pencil — plain Unicode, not a Bravura glyph
const GLYPH_TIE = "⌣"; // a tie is a curve, not a note shape — plain Unicode too

const SVG_NS = "http://www.w3.org/2000/svg";

// A five-line stave's own top line sits this many diatonic steps above its
// bottom line (5 lines = 4 gaps = 8 steps). Mirrors melody-render.js's
// TOP_STEP_OFFSET, which that file does not export — but a five-line staff is
// not going to change shape, and the preview only needs it to know where
// ledger lines start.
const TOP_STEP_OFFSET = 8;

// Bravura arrives with VexFlow, which is a CDN script and can genuinely be
// absent. Asking `document.fonts` is the honest test — without it the buttons
// would render tofu boxes, so they fall back to the digits they used to show.
function bravuraReady() {
  try {
    return typeof document !== "undefined" && document.fonts.check('16px Bravura');
  } catch (_) {
    return false;
  }
}

// Letter-key entry needs a starting octave when there is nothing to be near.
// Middle of each clef's staff, so the first note lands on the staff rather than
// several ledger lines away from it.
const CLEF_HOME_MIDI = { treble: 60, grand: 60, guitar: 60, bass: 43, drums: 60 };

// Semitone above C for each letter name. Letters enter naturals; the arrow keys
// alter them, which is the same division of labour the staff click has.
const LETTER_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// The octave of `letter` that lands nearest `refMidi` — step entry the way a
// notation program does it, so typing C D E after a G4 walks around G rather
// than leaping to octave 4 every time. A tie goes upward.
export function midiForLetterNear(letter, refMidi) {
  const pc = LETTER_SEMITONE[letter];
  if (pc == null) return null;
  let best = null;
  for (let octave = 0; octave <= 9; octave += 1) {
    const midi = (octave + 1) * 12 + pc;
    if (midi < 0 || midi > 127) continue;
    const d = Math.abs(midi - refMidi);
    if (!best || d < best.d || (d === best.d && midi > best.midi)) best = { midi, d };
  }
  return best ? best.midi : null;
}

// One shared set of playback timers: two editors on screen should not be able
// to play over each other, and leaving the view has a single thing to stop.
let playbackTimers = [];

export function stopMelodyPlayback() {
  playbackTimers.forEach(clearTimeout);
  playbackTimers = [];
  stopAll(0.05);
}

export function playMelody(melody) {
  stopMelodyPlayback();
  melodyPlaybackSchedule(melody).forEach((ev) => {
    playbackTimers.push(
      setTimeout(
        () => playNotes(ev.midis, { duration: Math.max(0.15, ev.durationMs / 1000) }),
        ev.atMs
      )
    );
  });
}

// A pointer position, converted to the SVG's own user-space coordinates.
// getScreenCTM() is the right tool rather than any offset/rect arithmetic: an
// editor may sit inside a scaled container, and the CTM already accounts for
// every ancestor transform between the SVG and the screen. Shared by the click
// handler and the note-input mouse preview, which both need it.
function svgLocalPoint(svg, event) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  return pt.matrixTransform(ctm.inverse());
}

function staffStepFromLocal(svg, local) {
  if (!local) return null;
  const bottomY = Number(svg.getAttribute("data-stave-bottom-y"));
  const refBottom = Number(svg.getAttribute("data-stave-ref-bottom"));
  const stepPx = Number(svg.getAttribute("data-step-px"));
  if (!Number.isFinite(bottomY) || !Number.isFinite(refBottom) || !stepPx) return null;
  return Math.round(refBottom + (bottomY - local.y) / stepPx);
}

// Which ledger-line offsets (relative to the stave's bottom line, in the same
// units as staffStep) a note at `offset` needs. Offsets 0..TOP_STEP_OFFSET are
// the five lines themselves; a note one step outside that range sits in open
// air just past the staff and needs no ledger (that is what a plain space
// above/below the staff looks like), so the first ledger line only appears two
// steps out, and every one closer to the staff than the note's own line is
// implied along with it.
function ledgerOffsetsFor(offset) {
  const list = [];
  if (offset <= -2) {
    const lowest = offset % 2 === 0 ? offset : offset + 1;
    for (let e = -2; e >= lowest; e -= 2) list.push(e);
  } else if (offset >= TOP_STEP_OFFSET + 2) {
    const highest = offset % 2 === 0 ? offset : offset - 1;
    for (let e = TOP_STEP_OFFSET + 2; e <= highest; e += 2) list.push(e);
  }
  return list;
}

/**
 * @param {HTMLElement} host      element the editor fills (its contents are replaced)
 * @param {object} melody         a melody per melody-model.js
 * @param {{onChange?: (melody) => void, showControls?: boolean}} options
 * @returns {{ el, getMelody, setMelody, destroy }}
 */
export function createMelodyEditor(host, melody, options = {}) {
  const onChange = options.onChange || (() => {});
  const showControls = options.showControls !== false;

  let current = normalizeMelody(melody);
  // Caret and selected duration are view state, not content — they are never
  // handed to onChange and never persisted, the same way `activeSectionIndex`
  // is a cursor rather than part of a song.
  // Zoom is view state too, but unlike the caret it is a preference rather than
  // a cursor, so the panel hands one in and is told when it changes. Keeping the
  // storage out here is the same split `initMelodyPanel` already has with
  // readMelodies/writeMelodies.
  const state = {
    den: 4,
    dots: 0,
    caret: null,
    scale: clampScale(options.scale != null ? options.scale : 1.6),
    // Note input starts OFF: arrow-key navigation, deletion and the duration
    // palette all work regardless, but letters, R and a blank-staff click only
    // write notes while this is on — the same split notation software makes so
    // that browsing a melody cannot accidentally add to it.
    noteInput: false,
    // The pointer's last position over the staff, in the SVG's own user space,
    // or null when it is elsewhere. A coordinate rather than a resolved slot
    // on purpose — see activeSlot().
    hoverX: null,
  };
  const onScaleChange = options.onScaleChange || (() => {});
  // Checked once per editor rather than per button: the font either arrived
  // with VexFlow or it did not, and that cannot change mid-session.
  const glyphsAvailable = bravuraReady();

  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "melody-editor";

  const controls = document.createElement("div");
  controls.className = "melody-editor-controls no-drag";

  const staffHost = document.createElement("div");
  staffHost.className = "melody-editor-staff no-drag";
  staffHost.tabIndex = 0;
  staffHost.setAttribute("role", "application");
  staffHost.setAttribute(
    "aria-label",
    "Melody staff. Type A to G to add notes, R for a rest, 1 to 5 for the note value, " +
      "full stop to dot it. Arrow keys move and transpose. T ties the selected note to " +
      "the next one, when they share a pitch. N toggles note input mode, which is what " +
      "lets the keyboard and staff clicks write notes rather than just navigate. With it " +
      "off, clicking a note selects it. With it on, clicking a note replaces it at the " +
      "pitch clicked, and clicking the empty end of the last bar adds a note there."
  );

  if (showControls) root.appendChild(controls);
  root.appendChild(staffHost);
  host.appendChild(root);

  function commit() {
    // Tab positions are derived from pitch, so they are recomputed on every
    // change rather than stored and left to go stale after an edit.
    if (current.clef === "guitar") assignTab(current);
    // A tie only means anything while it still points at a matching pitch
    // right after it — any edit (transpose, delete, a duration change that
    // shifts what follows) can invalidate one, so this runs after EVERY edit
    // rather than being trusted to stay correct on its own.
    pruneInvalidTies(current.events);
    onChange(current);
  }

  // Whether the event at `i` can be tied to the one right after it: both must
  // be real notes (not rests) and share the same pitch(es) — a tie says
  // "keep sounding this note", which only means something between two notes
  // that ARE the same note.
  function canTie(i) {
    const a = current.events[i];
    const b = current.events[i + 1];
    return !!(a && b && notesMatchPitch(a, b));
  }

  function toggleTie() {
    if (state.caret == null || !canTie(state.caret)) return;
    const ev = current.events[state.caret];
    ev.tie = !ev.tie;
    commit();
    drawStaff();
  }

  function markSelection() {
    staffHost.querySelectorAll(".ms-selected").forEach((n) => n.classList.remove("ms-selected"));
    if (state.caret == null) return;
    staffHost
      .querySelectorAll(`[data-event-index="${state.caret}"]`)
      .forEach((n) => n.classList.add("ms-selected"));
  }

  function clearGhost() {
    const svg = staffHost.querySelector("svg");
    const g = svg && svg.querySelector(".ms-input-preview");
    if (g) g.remove();
  }

  // The floating notehead that follows the pointer in note-input mode, at the
  // pitch a click would write there — musescore-style. `x` is the pointer's
  // own position (so the preview tracks the cursor left-to-right too), `y`
  // comes from `staffStep` through the same offset math the renderer and the
  // click-to-pitch inverse both use, so the preview can never disagree with
  // where the note would actually land. staffStep is always an integer (snapped
  // to staff lines and spaces).
  function drawGhost(svg, x, staffStep) {
    clearGhost();
    const bottomY = Number(svg.getAttribute("data-stave-bottom-y"));
    const refBottom = Number(svg.getAttribute("data-stave-ref-bottom"));
    const stepPx = Number(svg.getAttribute("data-step-px"));
    if (!Number.isFinite(bottomY) || !Number.isFinite(refBottom) || !stepPx) return;
    const offset = staffStep - refBottom;
    const y = bottomY - offset * stepPx;

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "ms-input-preview");
    g.setAttribute("aria-hidden", "true");

    ledgerOffsetsFor(offset).forEach((e) => {
      const ly = bottomY - e * stepPx;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("class", "ms-input-ledger");
      line.setAttribute("x1", String(x - stepPx * 1.6));
      line.setAttribute("x2", String(x + stepPx * 1.6));
      line.setAttribute("y1", String(ly));
      line.setAttribute("y2", String(ly));
      g.appendChild(line);
    });

    const notehead = document.createElementNS(SVG_NS, "ellipse");
    notehead.setAttribute("class", "ms-input-notehead");
    notehead.setAttribute("cx", String(x));
    notehead.setAttribute("cy", String(y));
    notehead.setAttribute("rx", String(stepPx * 1.05));
    notehead.setAttribute("ry", String(stepPx * 0.8));
    notehead.setAttribute("transform", `rotate(-18 ${x} ${y})`);
    g.appendChild(notehead);

    svg.appendChild(g);
  }

  // ---- Input slots ----
  //
  // A slot is a place a note can be written. There are two kinds, and which one
  // the pointer is over is the whole of "where does this click go":
  //
  //   - `index` is a number — an event already on the staff. Writing there
  //     REPLACES it, pitch from the click and duration from the palette, which
  //     is what note input does in MuseScore: the palette is always what you
  //     are writing with, so re-entering a note can change its rhythm too.
  //   - `index` is null — the empty tail of the last bar (the filler rests).
  //     Writing there appends to the end of the melody.
  //
  // Slots are read back off the PAINTED score rather than computed from the
  // model, because only the renderer knows where anything actually landed. Two
  // consequences fall out of that and are both wanted: an event split across a
  // barline paints twice and so gets two slots naming one event (clicking
  // either fragment replaces the whole note), and a grand staff paints one
  // event on one of its two staves, so the slot is wherever it really is.
  function slotsFor(svg) {
    const stepPx = Number(svg.getAttribute("data-step-px")) || 10;
    const slots = [];
    svg.querySelectorAll("[data-event-index]").forEach((node) => {
      const bb = node.getBBox();
      if (!(bb.width > 0)) return;
      slots.push({
        index: Number(node.getAttribute("data-event-index")),
        x: bb.x - 3,
        w: bb.width + 6,
      });
    });
    slots.sort((a, b) => a.x - b.x);

    // The append region: the filler rests, taken as one band rather than one
    // slot each — they all mean the same thing, "past the end of the melody".
    // Placing a note at a specific beat inside that emptiness would mean
    // writing the rests before it as real events, which is a different feature.
    const fillers = [...svg.querySelectorAll(".ms-rest-filler")]
      .map((n) => n.getBBox())
      .filter((b) => b.width > 0);
    if (fillers.length) {
      const left = Math.min(...fillers.map((b) => b.x)) - 3;
      const right = Math.max(...fillers.map((b) => b.x + b.width)) + 3;
      slots.push({ index: null, x: left, w: right - left });
    } else if (slots.length) {
      const last = slots[slots.length - 1];
      slots.push({ index: null, x: last.x + last.w + 2, w: stepPx * 3.5 });
    } else {
      // Past the clef and time signature, on an otherwise empty stave.
      slots.push({ index: null, x: 72, w: stepPx * 3.5 });
    }
    return slots;
  }

  // Which slot a pointer at user-space `x` is addressing: the one it is inside,
  // else the nearest by centre. Containment first matters for the append band,
  // which is wide — judging it by its centre alone would hand the left end of
  // an empty bar to the last note instead.
  function slotAtX(svg, x) {
    const slots = slotsFor(svg);
    if (!slots.length) return null;
    const inside = slots.find((s) => x >= s.x && x <= s.x + s.w);
    if (inside) return inside;
    let best = slots[0];
    let bestD = Infinity;
    for (const s of slots) {
      const d = Math.abs(x - (s.x + s.w / 2));
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  // Where the KEYBOARD writes: the slot next to whatever is at the caret.
  // Letters still insert after the caret rather than replacing — the pointer is
  // what overwrites, because a click names a note and a keystroke does not.
  function insertionSlot(svg) {
    const stepPx = Number(svg.getAttribute("data-step-px")) || 10;
    const insertAt = state.caret == null ? current.events.length : state.caret + 1;
    const targetEl = svg.querySelector(`[data-event-index="${insertAt}"]`);
    const prevEl = insertAt > 0 ? svg.querySelector(`[data-event-index="${insertAt - 1}"]`) : null;

    if (targetEl) {
      const bb = targetEl.getBBox();
      return { index: null, x: bb.x - 4, w: bb.width + 8 };
    }
    if (prevEl) {
      const bb = prevEl.getBBox();
      return { index: null, x: bb.x + bb.width + 2, w: stepPx * 3.5 };
    }
    return { index: null, x: 72, w: stepPx * 3.5 };
  }

  // The slot both cursors show. While the pointer is over the staff it wins —
  // a click is about to happen there, and the band and the ghost must never
  // point at different places. With the pointer away, it falls back to the
  // caret, which is where the keyboard writes.
  //
  // `state.hoverX` is kept as a user-space COORDINATE, not as a resolved slot:
  // every redraw builds a new SVG with new geometry, and a slot cached across
  // one would be stale by exactly the amount the notes just moved.
  function activeSlot(svg) {
    if (state.noteInput && state.hoverX != null) {
      const s = slotAtX(svg, state.hoverX);
      if (s) return s;
    }
    return insertionSlot(svg);
  }

  function updateInsertCursor() {
    const svg = staffHost.querySelector("svg");
    if (!svg) return;
    const old = svg.querySelector(".ms-insert-cursor");
    if (old) old.remove();
    svg
      .querySelectorAll(".ms-replace-target")
      .forEach((n) => n.classList.remove("ms-replace-target"));
    if (!state.noteInput) return;

    const bottomY = Number(svg.getAttribute("data-stave-bottom-y"));
    const stepPx = Number(svg.getAttribute("data-step-px"));
    if (!Number.isFinite(bottomY) || !stepPx) return;

    const top = bottomY - (TOP_STEP_OFFSET + 2) * stepPx;
    const bottom = bottomY + 2 * stepPx;
    const slot = activeSlot(svg);

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("class", "ms-insert-cursor");
    rect.setAttribute("x", String(slot.x));
    rect.setAttribute("y", String(top));
    rect.setAttribute("width", String(Math.max(slot.w, 4)));
    rect.setAttribute("height", String(bottom - top));
    rect.setAttribute("aria-hidden", "true");
    // Behind the notation (SVG paints in document order), so it reads as a
    // highlighted slot rather than a box drawn over the notes.
    svg.insertBefore(rect, svg.firstChild);

    // The note about to be overwritten is marked, because the band alone does
    // not distinguish "a note goes here" from "this note is replaced" — and
    // replacing is the destructive one.
    if (slot.index != null) {
      svg
        .querySelectorAll(`[data-event-index="${slot.index}"]`)
        .forEach((n) => n.classList.add("ms-replace-target"));
    }
  }

  function updateCaretVisuals() {
    markSelection();
    updateInsertCursor();
    // The tie button's active/disabled state depends on which event is
    // selected, so a plain caret move (arrow keys, clicking a note) has to
    // refresh it too, not just edits that already redraw controls anyway.
    drawControls();
  }

  // Redraws only the staff, keeping focus. Rebuilding the whole editor would
  // destroy focus on every keystroke, which makes keyboard editing impossible.
  function drawStaff() {
    if (current.clef === "guitar") assignTab(current);
    const hadFocus = document.activeElement === staffHost;
    staffHost.innerHTML = "";
    staffHost.appendChild(renderMelodySVG(current, { scale: state.scale }));
    updateCaretVisuals();
    if (hadFocus) staffHost.focus();
  }

  function setNoteInput(v) {
    if (state.noteInput === v) return;
    state.noteInput = v;
    staffHost.classList.toggle("ms-note-input-active", v);
    if (!v) {
      state.hoverX = null;
      clearGhost();
    }
    drawControls();
    updateInsertCursor();
  }

  function insertEvent(event, at = null) {
    const index = at != null ? at : state.caret == null ? current.events.length : state.caret + 1;
    current.events.splice(index, 0, event);
    state.caret = index;
    commit();
    drawStaff();
  }

  // Writing over an event that is already there — what a click does in
  // note-input mode. A full replace, not a re-pitch: the palette's duration and
  // dots come with it, the way note input works in MuseScore, so correcting a
  // note can fix its rhythm as well as its pitch. Nothing of the old event
  // survives; a tie it carried, or one pointing at it, is dropped by the
  // pruneInvalidTies pass every commit runs.
  function replaceEvent(index, event) {
    if (!current.events[index]) return;
    current.events[index] = event;
    state.caret = index;
    commit();
    drawStaff();
  }

  function deleteSelection() {
    if (state.caret == null || !current.events[state.caret]) return;
    current.events.splice(state.caret, 1);
    state.caret = current.events.length ? Math.max(0, state.caret - 1) : null;
    commit();
    drawStaff();
  }

  // The palette doubles as "what gets added next" and "change what is picked".
  function applyDuration() {
    const ev = state.caret != null ? current.events[state.caret] : null;
    if (ev) {
      ev.den = state.den;
      ev.dots = state.dots;
      commit();
    }
    drawControls();
    drawStaff();
  }

  function mkButton(label, title, onClick, active) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "no-drag" + (active ? " is-active" : "");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  // A button whose face is a music glyph. The glyph is decorative — the button
  // still carries a real `aria-label` and tooltip, because "" tells a screen
  // reader nothing and a private-use codepoint is not text.
  function mkGlyphButton(glyph, fallback, title, onClick, active) {
    const b = mkButton("", title, onClick, active);
    b.classList.add("melody-glyph-btn");
    b.setAttribute("aria-label", title);
    const face = document.createElement("span");
    if (glyphsAvailable) {
      face.className = "ms-glyph";
      face.textContent = glyph;
    } else {
      face.textContent = fallback;
    }
    face.setAttribute("aria-hidden", "true");
    b.appendChild(face);
    return b;
  }

  // One toolbar group. The divider before it is drawn by CSS, so adding or
  // removing a group never leaves a stray line behind — which matters because
  // the tie group is absent on a beat.
  function mkGroup(...children) {
    const g = document.createElement("span");
    g.className = "tb-group no-drag";
    children.filter(Boolean).forEach((c) => g.appendChild(c));
    return g;
  }

  function drawControls() {
    if (!showControls) return;
    controls.innerHTML = "";

    const clefSel = document.createElement("select");
    clefSel.className = "no-drag";
    clefSel.setAttribute("aria-label", "Clef");
    (options.clefOptions || [
      ["treble", "Treble"],
      ["bass", "Bass"],
      ["grand", "Grand"],
      ["guitar", "Guitar + tab"],
    ]).forEach(([v, label]) => clefSel.appendChild(new Option(label, v)));
    clefSel.value = current.clef;
    clefSel.addEventListener("change", () => {
      current.clef = clefSel.value;
      commit();
      drawStaff();
    });

    const timeSel = document.createElement("select");
    timeSel.className = "no-drag";
    timeSel.setAttribute("aria-label", "Time signature");
    [
      [4, 4],
      [3, 4],
      [2, 4],
      [6, 8],
    ].forEach(([num, den]) => timeSel.appendChild(new Option(`${num}/${den}`, `${num}/${den}`)));
    timeSel.value = `${current.timeSig.num}/${current.timeSig.den}`;
    timeSel.addEventListener("change", () => {
      const [num, den] = timeSel.value.split("/").map(Number);
      current.timeSig = { num, den };
      commit();
      drawStaff();
    });

    // Group 1 — what the score is: clef and time signature.
    controls.appendChild(mkGroup(clefSel, timeSel));

    // Note input is off by default: browsing and selecting a melody must not
    // risk writing to it. Toggling this is what lets letters, R and a blank
    // staff click add notes, the same gate MuseScore's own N key opens. Plain
    // Unicode rather than mkGlyphButton — a pencil is not a Bravura codepoint.
    //
    // Group 2 — the mode gate, alone, because it governs everything after it
    // rather than being one more thing you can press.
    controls.appendChild(
      mkGroup(
        mkButton(
          GLYPH_NOTE_INPUT,
          "Note input — type notes or click the staff to write them  (N)",
          () => setNoteInput(!state.noteInput),
          state.noteInput
        )
      )
    );

    // The note values, drawn as the notes they are. Each also names its number
    // key in the tooltip, which is how a keyboard shortcut gets discovered at
    // all — nobody guesses that 3 means a quarter note.
    const palette = document.createElement("span");
    palette.className = "melody-duration-palette no-drag";
    DURATION_DENOMS.forEach((den, i) => {
      palette.appendChild(
        mkGlyphButton(
          DURATION_GLYPH[den],
          String(den),
          `${DURATION_LABEL[den]} note  (${i + 1})`,
          () => {
            state.den = den;
            applyDuration();
          },
          state.den === den
        )
      );
    });
    // Group 3 — the note value being written: the durations and the dot, which
    // modifies whichever of them is selected.
    controls.appendChild(
      mkGroup(
        palette,
        mkGlyphButton(
          state.dots === 2 ? `${GLYPH_DOT}${GLYPH_DOT}` : GLYPH_DOT,
          state.dots === 2 ? ".." : ".",
          `Dotted — adds half the duration again  (.)`,
          () => {
            state.dots = state.dots === 0 ? 1 : state.dots === 1 ? 2 : 0;
            applyDuration();
          },
          state.dots > 0
        )
      )
    );

    // A tie only makes sense between two real notes of the same pitch, and
    // never on a beat (a drum "note" is a voice, not a sustained pitch — see
    // melody-model.js). Disabled rather than hidden when the caret can't tie,
    // so the button stays a discoverable affordance instead of vanishing.
    let tieBtn = null;
    if (current.clef !== "drums") {
      const caretEvent = state.caret != null ? current.events[state.caret] : null;
      tieBtn = mkButton(
        GLYPH_TIE,
        "Tie to the next note — requires the same pitch  (T)",
        toggleTie,
        !!(caretEvent && caretEvent.tie)
      );
      tieBtn.disabled = state.caret == null || !canTie(state.caret);
    }

    // Group 4 — acting on the sequence itself: add a rest, tie, delete.
    controls.appendChild(
      mkGroup(
        mkGlyphButton(GLYPH_REST, "rest", "Insert a rest at the caret  (R)", () =>
          insertEvent({ den: state.den, dots: state.dots, rest: true, notes: [] })
        ),
        tieBtn,
        mkButton("×", "Delete the selected note  (Delete)", deleteSelection)
      )
    );

    // Group 5 — transport.
    controls.appendChild(
      mkGroup(
        mkButton("▶", "Play this melody", () => playMelody(current)),
        mkButton("■", "Stop playback", stopMelodyPlayback)
      )
    );

    // Group 6 — the view, pushed to the far end: zoom changes how the staff is
    // displayed, not what is written.
    const zoom = document.createElement("span");
    zoom.className = "melody-zoom tb-group no-drag";
    const setScale = (next) => {
      const v = clampScale(next);
      if (v === state.scale) return;
      state.scale = v;
      onScaleChange(v);
      drawControls();
      drawStaff();
    };
    const out = mkButton("−", "Zoom out", () => setScale(state.scale - 0.2));
    const inn = mkButton("+", "Zoom in", () => setScale(state.scale + 0.2));
    out.disabled = state.scale <= MIN_SCALE;
    inn.disabled = state.scale >= MAX_SCALE;
    zoom.appendChild(out);
    const pct = document.createElement("span");
    pct.className = "melody-zoom-value";
    pct.textContent = `${Math.round(state.scale * 100)}%`;
    zoom.appendChild(pct);
    zoom.appendChild(inn);
    controls.appendChild(zoom);
  }

  staffHost.addEventListener("click", (e) => {
    e.stopPropagation();
    staffHost.focus();
    const svg = staffHost.querySelector("svg");
    if (!svg) return;

    const hit = e.target.closest && e.target.closest("[data-event-index]");

    // Outside note-input mode a click never writes: on a note it moves the
    // caret, on open staff it does nothing but focus, the same as clicking
    // blank space anywhere else in the app.
    if (!state.noteInput) {
      if (hit) {
        state.caret = Number(hit.getAttribute("data-event-index"));
        updateCaretVisuals();
      }
      return;
    }

    const local = svgLocalPoint(svg, e);
    const staffStep = staffStepFromLocal(svg, local);
    if (staffStep == null) return;
    const event = {
      den: state.den,
      dots: state.dots,
      rest: false,
      notes: [{ midi: midiFromStaffStep(staffStep) }],
    };

    // Which event this lands on. The element actually under the pointer wins
    // when there is one — it is the most precise answer available — and
    // otherwise the x resolves to a slot, so clicking the gap beside a note
    // still names that note rather than falling through to the end of the
    // melody. A slot with no index is the empty tail of the last bar, which
    // appends; note that is the END of the melody, not the caret's position,
    // because the pointer is pointing at the end of the melody.
    const slot = hit ? { index: Number(hit.getAttribute("data-event-index")) } : slotAtX(svg, local.x);
    if (slot && slot.index != null) replaceEvent(slot.index, event);
    else insertEvent(event, current.events.length);
  });

  // The pointer's live pitch preview — only meaningful in note-input mode, and
  // only while the pointer is actually over the staff. Both axes SNAP, and
  // neither follows the raw pixel: the pitch (y) locks to the nearest staff
  // line or space, and the x locks to the slot under the pointer — an existing
  // note, or the empty tail of the last bar. Snapping to slots rather than
  // floating is what keeps the preview honest, since those are the only places
  // a click can actually write; it tracks the pointer horizontally because a
  // click's x now decides WHICH note it writes over.
  staffHost.addEventListener("mousemove", (e) => {
    const svg = staffHost.querySelector("svg");
    if (!state.noteInput || !svg) {
      state.hoverX = null;
      clearGhost();
      return;
    }
    const local = svgLocalPoint(svg, e);
    const staffStep = staffStepFromLocal(svg, local);
    if (staffStep == null) {
      state.hoverX = null;
      clearGhost();
      return;
    }
    state.hoverX = local.x;
    const slot = activeSlot(svg);
    updateInsertCursor();
    drawGhost(svg, slot.x + slot.w / 2, staffStep);
  });
  staffHost.addEventListener("mouseleave", () => {
    state.hoverX = null;
    clearGhost();
    updateInsertCursor();
  });

  // The pitch a letter-entered note should be measured against: the note at the
  // caret if there is one, else the last note written, else the middle of the
  // clef. Rests are skipped — they have no pitch to be near.
  function referenceMidi() {
    const upTo =
      state.caret != null ? Math.min(state.caret + 1, current.events.length) : current.events.length;
    for (let i = upTo - 1; i >= 0; i -= 1) {
      const ev = current.events[i];
      if (ev && !ev.rest && ev.notes && ev.notes.length) return ev.notes[0].midi;
    }
    return CLEF_HOME_MIDI[current.clef] != null ? CLEF_HOME_MIDI[current.clef] : 60;
  }

  staffHost.addEventListener("keydown", (e) => {
    // Letter and number entry must work on an EMPTY melody — that is the whole
    // point of typing a melody in. Only the commands that act on an existing
    // event need something to act on, so the emptiness guard moved down to them
    // rather than covering the whole handler as it used to.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = e.key.toUpperCase();

    if (key === "N") {
      e.preventDefault();
      setNoteInput(!state.noteInput);
      return;
    }

    if (key === "ESCAPE" && state.noteInput) {
      e.preventDefault();
      setNoteInput(false);
      return;
    }

    // Letters and R only WRITE while note input is on — see the toggle button
    // and the state.noteInput comment above for why browsing must not.
    if (state.noteInput && LETTER_SEMITONE[key] != null) {
      e.preventDefault();
      const midi = midiForLetterNear(key, referenceMidi());
      if (midi == null) return;
      insertEvent({ den: state.den, dots: state.dots, rest: false, notes: [{ midi }] });
      // Hearing the note as it is entered is what makes typing a melody
      // possible without constantly replaying from the top.
      playNotes([midi], { duration: 0.35 });
      return;
    }

    if (state.noteInput && key === "R") {
      e.preventDefault();
      insertEvent({ den: state.den, dots: state.dots, rest: true, notes: [] });
      return;
    }

    // Tie is not gated on note-input: it acts on the already-selected note,
    // the same as transpose and delete below rather than writing a new one.
    if (key === "T") {
      e.preventDefault();
      toggleTie();
      return;
    }

    // 1..5 select the duration, in palette order — whole through sixteenth.
    // Deliberately positional rather than "the key whose digit matches the
    // denominator": that would need 1,2,4,8 plus something arbitrary for 16.
    const slot = Number(e.key);
    if (Number.isInteger(slot) && slot >= 1 && slot <= DURATION_DENOMS.length) {
      e.preventDefault();
      state.den = DURATION_DENOMS[slot - 1];
      applyDuration();
      return;
    }

    if (e.key === ".") {
      e.preventDefault();
      state.dots = state.dots === 0 ? 1 : state.dots === 1 ? 2 : 0;
      applyDuration();
      return;
    }

    const count = current.events.length;
    if (!count) return;

    const move = (delta) => {
      state.caret = state.caret == null ? (delta > 0 ? 0 : count - 1) : state.caret + delta;
      state.caret = Math.max(0, Math.min(count - 1, state.caret));
      updateCaretVisuals();
    };

    const transpose = (semitones) => {
      const ev = state.caret != null ? current.events[state.caret] : null;
      if (!ev || ev.rest) return;
      ev.notes.forEach((n) => {
        n.midi = Math.max(0, Math.min(127, n.midi + semitones));
        // A hand-placed tab position stops being valid once the pitch moves.
        delete n.manualTab;
      });
      commit();
      drawStaff();
    };

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        move(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        transpose(e.shiftKey ? 12 : 1);
        break;
      case "ArrowDown":
        e.preventDefault();
        transpose(e.shiftKey ? -12 : -1);
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        deleteSelection();
        break;
      default:
        break;
    }
  });

  drawControls();
  drawStaff();

  return {
    el: root,
    getMelody: () => current,
    setMelody(next) {
      current = normalizeMelody(next || createMelody());
      state.caret = null;
      drawControls();
      drawStaff();
    },
    destroy() {
      stopMelodyPlayback();
      host.innerHTML = "";
    },
  };
}
