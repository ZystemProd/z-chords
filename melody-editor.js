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
} from "./melody-model.js";
import { playNotes, stopAll } from "./audio.js";

const DURATION_LABEL = {
  1: "Whole",
  2: "Half",
  4: "Quarter",
  8: "Eighth",
  16: "Sixteenth",
};

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

// A click's position, converted back to a staff position. getScreenCTM() is
// the right tool rather than any offset/rect arithmetic: an editor may sit
// inside a scaled container, and the CTM already accounts for every ancestor
// transform between the SVG and the screen.
function staffStepFromEvent(svg, event) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const local = pt.matrixTransform(ctm.inverse());

  const bottomY = Number(svg.getAttribute("data-stave-bottom-y"));
  const refBottom = Number(svg.getAttribute("data-stave-ref-bottom"));
  const stepPx = Number(svg.getAttribute("data-step-px"));
  if (!Number.isFinite(bottomY) || !Number.isFinite(refBottom) || !stepPx) return null;
  return Math.round(refBottom + (bottomY - local.y) / stepPx);
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
  };
  const onScaleChange = options.onScaleChange || (() => {});

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
    "Melody staff. Click the staff to add a note, click a note to select it, arrow keys to move and transpose."
  );

  if (showControls) root.appendChild(controls);
  root.appendChild(staffHost);
  host.appendChild(root);

  function commit() {
    // Tab positions are derived from pitch, so they are recomputed on every
    // change rather than stored and left to go stale after an edit.
    if (current.clef === "guitar") assignTab(current);
    onChange(current);
  }

  function markSelection() {
    staffHost.querySelectorAll(".ms-selected").forEach((n) => n.classList.remove("ms-selected"));
    if (state.caret == null) return;
    staffHost
      .querySelectorAll(`[data-event-index="${state.caret}"]`)
      .forEach((n) => n.classList.add("ms-selected"));
  }

  // Redraws only the staff, keeping focus. Rebuilding the whole editor would
  // destroy focus on every keystroke, which makes keyboard editing impossible.
  function drawStaff() {
    if (current.clef === "guitar") assignTab(current);
    const hadFocus = document.activeElement === staffHost;
    staffHost.innerHTML = "";
    staffHost.appendChild(renderMelodySVG(current, { scale: state.scale }));
    markSelection();
    if (hadFocus) staffHost.focus();
  }

  function insertEvent(event) {
    const at = state.caret == null ? current.events.length : state.caret + 1;
    current.events.splice(at, 0, event);
    state.caret = at;
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
    controls.appendChild(clefSel);

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
    controls.appendChild(timeSel);

    // Plain digits rather than note glyphs: the note-value symbols live in the
    // Bravura font, but a button's label is ordinary UI text.
    const palette = document.createElement("span");
    palette.className = "melody-duration-palette no-drag";
    DURATION_DENOMS.forEach((den) => {
      palette.appendChild(
        mkButton(
          String(den),
          `${DURATION_LABEL[den]} note`,
          () => {
            state.den = den;
            applyDuration();
          },
          state.den === den
        )
      );
    });
    controls.appendChild(palette);

    controls.appendChild(
      mkButton(
        state.dots === 2 ? ".." : ".",
        "Dotted (adds half the duration again)",
        () => {
          state.dots = state.dots === 0 ? 1 : state.dots === 1 ? 2 : 0;
          applyDuration();
        },
        state.dots > 0
      )
    );

    controls.appendChild(
      mkButton("rest", "Insert a rest at the caret", () =>
        insertEvent({ den: state.den, dots: state.dots, rest: true, notes: [] })
      )
    );
    controls.appendChild(mkButton("×", "Delete the selected note", deleteSelection));
    controls.appendChild(mkButton("▶", "Play this melody", () => playMelody(current)));
    controls.appendChild(mkButton("■", "Stop playback", stopMelodyPlayback));

    const zoom = document.createElement("span");
    zoom.className = "melody-zoom no-drag";
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
    if (hit) {
      state.caret = Number(hit.getAttribute("data-event-index"));
      markSelection();
      return;
    }

    const staffStep = staffStepFromEvent(svg, e);
    if (staffStep == null) return;
    insertEvent({
      den: state.den,
      dots: state.dots,
      rest: false,
      notes: [{ midi: midiFromStaffStep(staffStep) }],
    });
  });

  staffHost.addEventListener("keydown", (e) => {
    const count = current.events.length;
    if (!count) return;

    const move = (delta) => {
      state.caret = state.caret == null ? (delta > 0 ? 0 : count - 1) : state.caret + delta;
      state.caret = Math.max(0, Math.min(count - 1, state.caret));
      markSelection();
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
