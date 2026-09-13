import { renderScaleSVG, scaleWindow, CAGED_MODES } from "./guitar.js";
import { SCALE_FORMULAS } from "./theory.js";
import { createMelody } from "./melody-model.js";
import { renderMelodySVG } from "./melody-render.js";

const guitarEl = document.getElementById("guitar");
const keySel = document.getElementById("guitarKey");
const modeSel = document.getElementById("guitarMode");
const shapeDown = document.getElementById("shapeDown");
const shapeUp = document.getElementById("shapeUp");
const shapeValue = document.getElementById("shapeValue");
const shapeStepper = document.getElementById("shapeStepper");
const guitarStaffEl = document.getElementById("guitarStaff");
const guitarViewButtons = document.querySelectorAll("[data-guitar-view]");
const guitarLabelRow = document.getElementById("guitarLabelRow");
const labelModeButtons = document.querySelectorAll("[data-guitar-label-mode]");

let shapeIndex = 0;
let shapeStarts = [1, 4, 7, 10, 13];

const GUITAR_SCALE_STORAGE_KEY = "cv-guitar-scale-settings";
const DEFAULT_LABEL_MODE = "interval";

let guitarScaleSettings = {
  viewMode: "scales",
  labelMode: DEFAULT_LABEL_MODE,
  customNoteKeys: [],
};


function loadGuitarScaleSettings() {
  try {
    const saved = localStorage.getItem(GUITAR_SCALE_STORAGE_KEY);
    if (!saved) return;
    const parsed = JSON.parse(saved);
    const next = { ...guitarScaleSettings };
    if (parsed && (parsed.viewMode === "scales" || parsed.viewMode === "custom")) {
      next.viewMode = parsed.viewMode;
    }
    if (parsed && Array.isArray(parsed.customNoteKeys)) {
      next.customNoteKeys = Array.from(new Set(parsed.customNoteKeys.map((value) => String(value))));
    } else if (parsed && Array.isArray(parsed.customMidiNotes)) {
      next.customNoteKeys = Array.from(new Set(parsed.customMidiNotes.map((value) => String(value))));
    }
    if (parsed && (parsed.labelMode === "interval" || parsed.labelMode === "note")) {
      next.labelMode = parsed.labelMode;
    }
    guitarScaleSettings = next;
  } catch (_) {}
}

function saveGuitarScaleSettings() {
  try {
    localStorage.setItem(GUITAR_SCALE_STORAGE_KEY, JSON.stringify(guitarScaleSettings));
  } catch (_) {}
}

function uniqueSortedIntervals(intervals) {
  return Array.from(new Set(intervals)).sort((a, b) => a - b);
}

function getDefaultIntervals(mode) {
  const intervals = SCALE_FORMULAS[mode];
  if (!Array.isArray(intervals)) return [];
  return uniqueSortedIntervals(intervals);
}

function updateViewModeButtons() {
  guitarViewButtons.forEach((btn) => {
    const isActive = btn.getAttribute("data-guitar-view") === guitarScaleSettings.viewMode;
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

function updateGuitarViewUI() {
  const isCustom = guitarScaleSettings.viewMode === "custom";
  if (keySel) keySel.style.display = isCustom ? "none" : "";
  if (modeSel) modeSel.style.display = isCustom ? "none" : "";
  if (shapeStepper) shapeStepper.style.display = isCustom ? "none" : "inline-flex";
  if (guitarLabelRow) guitarLabelRow.style.display = isCustom ? "none" : "";
}

function setViewMode(viewMode) {
  guitarScaleSettings.viewMode = viewMode === "custom" ? "custom" : "scales";
  saveGuitarScaleSettings();
  updateViewModeButtons();
  updateGuitarViewUI();
  renderCustomStaff();
  drawScale();
}

function setLabelMode(labelMode) {
  guitarScaleSettings.labelMode = labelMode === "note" ? "note" : "interval";
  saveGuitarScaleSettings();
  updateLabelModeButtons();
  drawScale();
}

function updateLabelModeButtons() {
  labelModeButtons.forEach((btn) => {
    const isActive = btn.getAttribute("data-guitar-label-mode") === guitarScaleSettings.labelMode;
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

function updateShapeUI() {
  if (shapeValue) shapeValue.textContent = String(shapeIndex + 1);
}

function parseCustomNoteKey(key) {
  if (typeof key !== "string") return null;
  const parts = key.split(":");
  if (parts.length < 3) return null;
  const stringIdx = Number(parts[0]);
  const fret = Number(parts[1]);
  const midi = Number(parts[2]);
  if ([stringIdx, fret, midi].some((value) => Number.isNaN(value))) return null;
  return { stringIdx, fret, midi };
}

function renderCustomStaff() {
  if (!guitarStaffEl) return;
  const isCustom = guitarScaleSettings.viewMode === "custom";
  guitarStaffEl.style.display = isCustom ? "flex" : "none";
  if (!isCustom) {
    guitarStaffEl.innerHTML = "";
    return;
  }

  const selected = (guitarScaleSettings.customNoteKeys || [])
    .map(parseCustomNoteKey)
    .filter(Boolean)
    .sort((a, b) => a.midi - b.midi || a.stringIdx - b.stringIdx || a.fret - b.fret);

  if (!selected.length) {
    guitarStaffEl.innerHTML = `
      <div class="guitar-staff-empty">No custom notes selected yet.</div>
    `;
    return;
  }

  // Guitar notation conventionally reads an octave above concert pitch so the
  // notes sit on the staff rather than piling up on ledger lines below it.
  const melody = createMelody({
    clef: "treble",
    timeSig: { num: 4, den: 4 },
    events: selected.map((note) => ({
      den: 4,
      dots: 0,
      rest: false,
      notes: [{ midi: note.midi + 12 }],
    })),
  });

  const svg = renderMelodySVG(melody, { showTab: false, scale: 1 });
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Selected custom notes on treble clef staff");

  guitarStaffEl.innerHTML = "";
  guitarStaffEl.appendChild(svg);
}

function drawScale() {
  if (!keySel || !modeSel || !guitarEl) return;

  const root = keySel.value;
  const mode = modeSel.value;
  const modeView = guitarScaleSettings.viewMode;
  const isCustom = modeView === "custom";
  const intervals = getDefaultIntervals(mode);
  const isCAGEDMode = CAGED_MODES.has(mode);
  const allowOpen = isCAGEDMode;
  let windowStart = null;
  let windowWidth = 17;
  let fretShift = 0;

  if (!isCustom) {
    // Window selection lives in guitar.js so the printed fretboard blocks on
    // the Layout tab resolve a shape to exactly the same frets this tab draws.
    const win = scaleWindow(root, mode, shapeIndex, intervals);
    shapeStarts = win.starts;
    shapeIndex = win.index;
    updateShapeUI();
    windowStart = win.windowStart;
    windowWidth = win.windowWidth;
    fretShift = win.fretShift;
  } else {
    shapeStarts = [1, 4, 7, 10, 13];
    shapeIndex = 0;
    updateShapeUI();
  }

  guitarEl.innerHTML = "";

  // Custom mode gets its own small bar above the neck. It is built here rather
  // than declared in index.html because drawScale() clears #guitar on every
  // redraw — anything static inside it would be wiped on the first draw. It
  // also means the bar can report the state it acts on: the count says why
  // Clear is disabled, instead of leaving a dead button to be puzzled over.
  if (isCustom) {
    const count = (guitarScaleSettings.customNoteKeys || []).length;
    const bar = document.createElement("div");
    bar.className = "gs-editbar";

    const status = document.createElement("span");
    status.className = "gs-editbar-count";
    status.textContent =
      count === 0
        ? "Click a position on the neck to add a note"
        : `${count} note${count === 1 ? "" : "s"} selected`;
    bar.appendChild(status);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.id = "resetGuitarNotes";
    clearBtn.className = "btn-danger";
    clearBtn.textContent = "Clear";
    clearBtn.title = "Remove every selected note";
    clearBtn.disabled = count === 0;
    clearBtn.addEventListener("click", () => {
      guitarScaleSettings.customNoteKeys = [];
      saveGuitarScaleSettings();
      drawScale();
    });
    bar.appendChild(clearBtn);

    guitarEl.appendChild(bar);
  }

  const svg = renderScaleSVG(root, intervals, 1, 17, {
    windowStart,
    windowWidth,
    showOpen: allowOpen,
    fretShift,
    labelMode: guitarScaleSettings.labelMode,
    editable: isCustom,
    customMode: isCustom,
    customNoteKeys: guitarScaleSettings.customNoteKeys,
  });

  if (isCustom) {
    svg.addEventListener("click", (event) => {
      const circle = event.target.closest("circle[data-note-key]");
      if (!circle || !guitarEl.contains(circle)) return;
      const clickedKey = circle.getAttribute("data-note-key");
      if (!clickedKey) return;
      const current = new Set((guitarScaleSettings.customNoteKeys || []).map(String));
      if (current.has(clickedKey)) current.delete(clickedKey);
      else current.add(clickedKey);
      guitarScaleSettings.customNoteKeys = Array.from(current).sort((a, b) => {
        const pa = parseCustomNoteKey(a);
        const pb = parseCustomNoteKey(b);
        if (!pa || !pb) return String(a).localeCompare(String(b));
        return pa.midi - pb.midi || pa.stringIdx - pb.stringIdx || pa.fret - pb.fret;
      });
      saveGuitarScaleSettings();
      drawScale();
    });
  }

  guitarEl.appendChild(svg);
  updateViewModeButtons();
  updateGuitarViewUI();
  updateLabelModeButtons();
  renderCustomStaff();
}

if (keySel && modeSel) {
  keySel.addEventListener("change", drawScale);
  modeSel.addEventListener("change", drawScale);
}

if (shapeDown) {
  shapeDown.addEventListener("click", () => {
    shapeIndex = Math.max(0, shapeIndex - 1);
    updateShapeUI();
    drawScale();
  });
}

if (shapeUp) {
  shapeUp.addEventListener("click", () => {
    shapeIndex = Math.min(shapeStarts.length - 1, shapeIndex + 1);
    updateShapeUI();
    drawScale();
  });
}

labelModeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    setLabelMode(btn.getAttribute("data-guitar-label-mode"));
  });
});

guitarViewButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    setViewMode(btn.getAttribute("data-guitar-view"));
  });
});

loadGuitarScaleSettings();
updateViewModeButtons();
updateLabelModeButtons();
updateGuitarViewUI();
renderCustomStaff();

drawScale();
