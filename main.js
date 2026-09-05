import {
  computeCAGEDShapes,
  getParentMajorRoot,
  renderScaleSVG,
} from "./guitar.js";
import { NOTES, SCALE_FORMULAS, noteIndex } from "./theory.js";

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
const guitarEditHint = document.getElementById("guitarEditHint");
const labelModeButtons = document.querySelectorAll("[data-guitar-label-mode]");
const resetNotesBtn = document.getElementById("resetGuitarNotes");

let shapeIndex = 0;
let shapeStarts = [1, 4, 7, 10, 13];

const GUITAR_SCALE_STORAGE_KEY = "cv-guitar-scale-settings";
const DEFAULT_LABEL_MODE = "interval";

let guitarScaleSettings = {
  viewMode: "scales",
  labelMode: DEFAULT_LABEL_MODE,
  customNoteKeys: [],
};

const CAGED_MODES = new Set([
  "major",
  "dorian",
  "phrygian",
  "lydian",
  "mixolydian",
  "aeolian",
  "harmonicMinor",
  "melodicMinor",
  "harmonicMajor",
  "locrian",
  "majorPentatonic",
  "minorPentatonic",
  "majorBlues",
  "minorBlues",
  "blues",
]);

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
  if (guitarEditHint) {
    guitarEditHint.textContent = isCustom
      ? "Click any fretboard note to add or remove that exact note."
      : "Scale mode keeps the preset scale layout.";
  }
  if (resetNotesBtn) {
    resetNotesBtn.style.display = isCustom ? "inline-flex" : "none";
    resetNotesBtn.textContent = "Clear";
  }
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

function normalizeWindowStart(start) {
  let windowStart = start;
  while (windowStart < 1) windowStart += 12;
  while (windowStart > 13) windowStart -= 12;
  return windowStart;
}

function midiToNoteName(midi) {
  const note = NOTES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

function midiToSpelledNote(midi) {
  const pitchClass = ((midi % 12) + 12) % 12;
  const note = NOTES[pitchClass];
  const octave = Math.floor(midi / 12) - 1;
  const letter = note[0];
  const accidental = note.length > 1 ? note.slice(1) : "";
  return { note, octave, letter, accidental };
}

function trebleStepFromSpelledNote(spelled) {
  const letterOrder = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
  return (spelled.octave - 4) * 7 + (letterOrder[spelled.letter] - letterOrder.E);
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

  const lineGap = 14;
  const staffStep = lineGap / 2;
  const bottomLineY = 112;
  const topLineY = bottomLineY - 4 * lineGap;
  const staffLeft = 58;
  const staffRight = 18;
  const noteSpacing = 60;
  const leftMargin = 120;
  const width = Math.max(760, leftMargin + selected.length * noteSpacing + staffRight);
  const height = 170;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Selected custom notes on treble clef staff");
  svg.style.color = "#111";

  const bg = document.createElementNS(svgNS, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", width);
  bg.setAttribute("height", height);
  bg.setAttribute("fill", "#fffdf7");
  svg.appendChild(bg);

  const clef = document.createElementNS(svgNS, "text");
  clef.setAttribute("x", 10);
  clef.setAttribute("y", 104);
  clef.setAttribute("fill", "#111");
  clef.setAttribute("font-size", "64");
  clef.setAttribute("font-family", "serif");
  clef.textContent = "𝄞";
  svg.appendChild(clef);

  for (let i = 0; i < 5; i += 1) {
    const y = topLineY + i * lineGap;
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", staffLeft);
    line.setAttribute("y1", y);
    line.setAttribute("x2", width - staffRight);
    line.setAttribute("y2", y);
    line.setAttribute("stroke", "#111");
    line.setAttribute("stroke-width", "1.4");
    line.setAttribute("opacity", "0.65");
    svg.appendChild(line);
  }

  const staffBottomStep = 0;
  const staffTopStep = 8;
  const noteWidth = 18;
  const noteHeight = 13;
  const stemLength = 36;
  const xStart = 96;
  const measureSize = 7;

  selected.forEach((note, index) => {
    const x = xStart + index * noteSpacing;
    const notatedMidi = note.midi + 12;
    const spelled = midiToSpelledNote(notatedMidi);
    const step = trebleStepFromSpelledNote(spelled);
    const y = bottomLineY - step * staffStep;
    const stemUp = step < 4;

    if (step < staffBottomStep) {
      for (let s = -2; s >= step; s -= 2) {
        const ledgerY = bottomLineY - s * staffStep;
        const ledger = document.createElementNS(svgNS, "line");
        ledger.setAttribute("x1", x - 16);
        ledger.setAttribute("y1", ledgerY);
        ledger.setAttribute("x2", x + 16);
        ledger.setAttribute("y2", ledgerY);
        ledger.setAttribute("stroke", "#111");
        ledger.setAttribute("stroke-width", "1.3");
        ledger.setAttribute("opacity", "0.6");
        svg.appendChild(ledger);
      }
    } else if (step > staffTopStep) {
      for (let s = 10; s <= step; s += 2) {
        const ledgerY = bottomLineY - s * staffStep;
        const ledger = document.createElementNS(svgNS, "line");
        ledger.setAttribute("x1", x - 16);
        ledger.setAttribute("y1", ledgerY);
        ledger.setAttribute("x2", x + 16);
        ledger.setAttribute("y2", ledgerY);
        ledger.setAttribute("stroke", "#111");
        ledger.setAttribute("stroke-width", "1.3");
        ledger.setAttribute("opacity", "0.6");
        svg.appendChild(ledger);
      }
    }

    const head = document.createElementNS(svgNS, "ellipse");
    head.setAttribute("cx", x);
    head.setAttribute("cy", y);
    head.setAttribute("rx", String(noteWidth / 2));
    head.setAttribute("ry", String(noteHeight / 2));
    head.setAttribute("fill", "#111");
    head.setAttribute("stroke", "#111");
    head.setAttribute("stroke-width", "1");
    svg.appendChild(head);

    const accidental = spelled.accidental === "#" ? "♯" : spelled.accidental === "b" ? "♭" : "";
    if (accidental) {
      const acc = document.createElementNS(svgNS, "text");
      acc.setAttribute("x", x - 18);
      acc.setAttribute("y", y + 4);
      acc.setAttribute("fill", "#111");
      acc.setAttribute("font-size", "14");
      acc.textContent = accidental;
      svg.appendChild(acc);
    }

    const stem = document.createElementNS(svgNS, "line");
    stem.setAttribute("x1", stemUp ? x + noteWidth / 2 - 1 : x - noteWidth / 2 + 1);
    stem.setAttribute("y1", y);
    stem.setAttribute("x2", stemUp ? x + noteWidth / 2 - 1 : x - noteWidth / 2 + 1);
    stem.setAttribute("y2", stemUp ? y - stemLength : y + stemLength);
    stem.setAttribute("stroke", "#111");
    stem.setAttribute("stroke-width", "1.6");
    svg.appendChild(stem);

    const noteLabel = document.createElementNS(svgNS, "text");
    noteLabel.setAttribute("x", x);
    noteLabel.setAttribute("y", bottomLineY + 28);
    noteLabel.setAttribute("text-anchor", "middle");
    noteLabel.setAttribute("fill", "#111");
    noteLabel.setAttribute("font-size", "12");
    noteLabel.textContent = spelled.note;
    svg.appendChild(noteLabel);

    if ((index + 1) % measureSize === 0 && index < selected.length - 1) {
      const barX = x + noteSpacing / 2;
      const bar = document.createElementNS(svgNS, "line");
      bar.setAttribute("x1", barX);
      bar.setAttribute("y1", topLineY - 6);
      bar.setAttribute("x2", barX);
      bar.setAttribute("y2", bottomLineY + 6);
      bar.setAttribute("stroke", "#111");
      bar.setAttribute("stroke-width", "1.6");
      bar.setAttribute("opacity", "0.8");
      svg.appendChild(bar);
    }
  });

  const finalBarX = xStart + selected.length * noteSpacing + 8;
  const finalBar = document.createElementNS(svgNS, "line");
  finalBar.setAttribute("x1", finalBarX);
  finalBar.setAttribute("y1", topLineY - 6);
  finalBar.setAttribute("x2", finalBarX);
  finalBar.setAttribute("y2", bottomLineY + 6);
  finalBar.setAttribute("stroke", "#111");
  finalBar.setAttribute("stroke-width", "3");
  svg.appendChild(finalBar);

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
    try {
      if (mode === "wholeTone") {
        const ePc = noteIndex("E");
        const rIdx = noteIndex(root);
        if (ePc >= 0 && rIdx >= 0) {
          const start = (rIdx - ePc + 12) % 12;
          const starts = [];
          for (let k = 0; k < 6; k++) {
            let value = (start + 2 * k) % 12;
            value = value === 0 ? 12 : value;
            starts.push(normalizeWindowStart(value));
          }
          shapeStarts = starts;
        } else {
          shapeStarts = [1, 4, 7, 10, 13];
        }
      } else if (isCAGEDMode) {
        const parentRoot = getParentMajorRoot(root, mode);
        shapeStarts = computeCAGEDShapes(parentRoot, SCALE_FORMULAS.major);
      } else {
        shapeStarts = computeCAGEDShapes(root, intervals);
      }
    } catch {
      shapeStarts = [1, 4, 7, 10, 13];
    }

    if (shapeIndex >= shapeStarts.length) shapeIndex = shapeStarts.length - 1;
    if (shapeIndex < 0) shapeIndex = 0;
    updateShapeUI();

    windowStart = shapeStarts[shapeIndex];
    windowWidth = 4;

    if (isCAGEDMode) {
      if (shapeIndex === 1 || shapeIndex === 3) {
        windowWidth = 5;
      }
      if (shapeIndex === 4) {
        windowWidth = 5;
        windowStart = windowStart - 1;
      }
      if (mode === "harmonicMinor") {
        if (shapeIndex === 0) windowStart = windowStart - 1;
        if (shapeIndex === 2) windowStart = windowStart - 1;
      }
      windowStart = normalizeWindowStart(windowStart);

      if (windowStart >= 12) {
        fretShift = -12;
        windowStart = windowStart + fretShift;
      }
    } else if (mode === "wholeTone") {
      windowWidth = 5;
      windowStart = normalizeWindowStart(windowStart);
    }
  } else {
    shapeStarts = [1, 4, 7, 10, 13];
    shapeIndex = 0;
    updateShapeUI();
  }

  guitarEl.innerHTML = "";
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

if (resetNotesBtn) {
  resetNotesBtn.addEventListener("click", () => {
    guitarScaleSettings.customNoteKeys = [];
    saveGuitarScaleSettings();
    drawScale();
  });
}

loadGuitarScaleSettings();
updateViewModeButtons();
updateLabelModeButtons();
updateGuitarViewUI();
renderCustomStaff();

drawScale();
