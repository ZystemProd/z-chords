// The Melody sub-tab: piano→melody and guitar→melody.
//
// Melodies are board content. This panel is to a melody what `#boards` is to a
// chord: the place it is authored. The Layout sheet only ever *references* what
// is written here, which is why the editor moved out of the sheet — a melody
// has one home, on the instrument it is played on, and every sheet that places
// it shows the same music.
//
// Like layout.js this module owns its DOM and takes its storage through
// injected deps, so script.js keeps the single localStorage vocabulary and this
// file stays testable against fakes. One direction, no module cycle.

import { createMelodyEditor, stopMelodyPlayback } from "./melody-editor.js";
import { createDrumGridEditor, stopBeatPlayback } from "./drum-grid.js";
import { createMelody, normalizeMelody } from "./melody-model.js";

// Guitar melodies default to a staff with tab under it; piano to treble. The
// clef list differs per instrument for the same reason the chord tabs draw
// different cards: a tab stave under a piano melody means nothing.
const INSTRUMENT_DEFAULTS = {
  piano: {
    clef: "treble",
    clefOptions: [
      ["treble", "Treble"],
      ["bass", "Bass"],
      ["grand", "Grand"],
    ],
  },
  guitar: {
    clef: "guitar",
    clefOptions: [
      ["guitar", "Staff + tab"],
      ["treble", "Treble only"],
    ],
  },
  // A beat is board content on the drums board exactly like a melody is on the
  // piano's. It has no clef choice: a kit is a kit, and the editor is a grid
  // rather than a staff — see drum-grid.js for why that is the right input.
  drums: { clef: "drums", clefOptions: null },
};

let deps = {
  readMelodies: () => [],
  writeMelodies: () => {},
  onChange: () => {},
};

// Editor zoom. This is view state, not board content, so it does NOT go through
// readMelodies/writeMelodies and is not per-board — it is the same status
// `cv-layout-scale` has in layout.js, which owns its own key for the same
// reason. Read and written defensively: storage can be unavailable.
const ZOOM_KEY = "cv-melody-zoom";

function readZoom() {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    return Number.isFinite(v) && v > 0 ? v : 1.6;
  } catch (_) {
    return 1.6;
  }
}

function writeZoom(v) {
  try {
    localStorage.setItem(ZOOM_KEY, String(v));
  } catch (_) {
    /* a zoom that cannot persist is still a zoom that works this session */
  }
}

let els = null;
let editor = null;
// Which melody is open, per instrument — a cursor, not content, so it is never
// saved. Same status as `activeSectionIndex` on the chord board.
const activeId = { piano: null, guitar: null, drums: null };

export function initMelodyPanel(injected = {}) {
  deps = { ...deps, ...injected };
  els = {
    panel: document.getElementById("melodyPanel"),
    list: document.getElementById("melodyList"),
    stage: document.getElementById("melodyStage"),
  };
}

export { stopMelodyPlayback };

function melodiesFor(instrument) {
  return deps.readMelodies(instrument);
}

function save(instrument, list) {
  deps.writeMelodies(instrument, list);
  deps.onChange(instrument);
}

function activeMelody(instrument, list) {
  if (!list.length) return null;
  const found = list.find((m) => m && m.id === activeId[instrument]);
  return found || list[0];
}

function mkButton(label, title, onClick, className) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  if (className) b.className = className;
  b.addEventListener("click", onClick);
  return b;
}

function addMelody(instrument) {
  const list = melodiesFor(instrument);
  const defaults = INSTRUMENT_DEFAULTS[instrument] || INSTRUMENT_DEFAULTS.piano;
  const melody = createMelody({ clef: defaults.clef });
  melody.name = `${instrument === "drums" ? "Beat" : "Melody"} ${list.length + 1}`;
  list.push(melody);
  activeId[instrument] = melody.id;
  save(instrument, list);
  render(instrument);
}

function removeMelody(instrument, id) {
  const list = melodiesFor(instrument).filter((m) => m && m.id !== id);
  if (activeId[instrument] === id) activeId[instrument] = null;
  save(instrument, list);
  render(instrument);
}

function renderList(instrument, list, current) {
  els.list.innerHTML = "";

  const head = document.createElement("div");
  head.className = "melody-list-head";
  const noun = instrument === "drums" ? "beat" : "melody";
  head.appendChild(
    mkButton(`+ New ${noun}`, `Start a new ${noun}`, () => addMelody(instrument))
  );
  els.list.appendChild(head);

  list.forEach((melody) => {
    const row = document.createElement("div");
    row.className = "melody-list-item";
    if (current && melody.id === current.id) row.classList.add("is-active");

    // The name is an input rather than a label because renaming is the only
    // edit this list makes, and a dedicated rename mode for one field is worse
    // than typing in place.
    const name = document.createElement("input");
    name.type = "text";
    name.className = "melody-name";
    name.value = melody.name || "Melody";
    name.setAttribute("aria-label", "Melody name");
    name.addEventListener("input", () => {
      melody.name = name.value;
      save(instrument, list);
    });
    name.addEventListener("focus", () => {
      activeId[instrument] = melody.id;
      render(instrument);
    });

    row.appendChild(name);
    row.appendChild(
      mkButton("×", "Delete this melody", (e) => {
        e.stopPropagation();
        removeMelody(instrument, melody.id);
      }, "melody-remove")
    );
    row.addEventListener("click", () => {
      if (activeId[instrument] === melody.id) return;
      activeId[instrument] = melody.id;
      render(instrument);
    });
    els.list.appendChild(row);
  });
}

function panelInstrument(instrument) {
  return INSTRUMENT_DEFAULTS[instrument] ? instrument : "piano";
}

function render(instrument) {
  if (!els || !els.panel) return;
  const list = melodiesFor(instrument);
  const current = activeMelody(instrument, list);
  if (current) activeId[instrument] = current.id;

  renderList(instrument, list, current);

  // The editor is rebuilt rather than re-pointed when the melody changes: it
  // holds a caret into the event list, and carrying that across to a different
  // melody would select an event that is not the one it was selecting.
  if (editor) {
    editor.destroy();
    editor = null;
  }
  els.stage.innerHTML = "";

  if (!current) {
    const empty = document.createElement("p");
    empty.className = "melody-empty";
    empty.textContent =
      "No melodies yet. Start one, then click the staff to add notes.";
    els.stage.appendChild(empty);
    return;
  }

  const defaults = INSTRUMENT_DEFAULTS[instrument] || INSTRUMENT_DEFAULTS.piano;
  // Which editor is chosen by the CLEF, not by the instrument: a beat is a
  // melody with clef "drums", and both editors expose the same contract, so
  // everything around this line is identical for either.
  const build = current.clef === "drums" ? createDrumGridEditor : createMelodyEditor;
  editor = build(els.stage, current, {
    clefOptions: defaults.clefOptions,
    scale: readZoom(),
    onScaleChange: writeZoom,
    onChange: (next) => {
      // Write through the stored list rather than the editor's copy: the list
      // is what persists, and the editor normalizes into an object of its own.
      const fresh = melodiesFor(instrument);
      const idx = fresh.findIndex((m) => m && m.id === current.id);
      const merged = normalizeMelody(next);
      merged.id = current.id;
      merged.name = current.name;
      if (idx >= 0) fresh[idx] = merged;
      else fresh.push(merged);
      save(instrument, fresh);
    },
  });
}

// Called from updateTabsUI whenever the melody (or drums→beat) sub-tab comes on
// screen.
export function showMelodyPanel(instrument) {
  render(panelInstrument(instrument));
}

export function hideMelodyPanel() {
  stopMelodyPlayback();
  stopBeatPlayback();
}
