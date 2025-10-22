import {
  computeCAGEDShapes,
  getParentMajorRoot,
  renderScaleSVG,
  SCALE_FORMULAS,
} from "./guitar.js";

const guitarEl = document.getElementById("guitar");
const keySel = document.getElementById("guitarKey");
const modeSel = document.getElementById("guitarMode");
const shapeDown = document.getElementById("shapeDown");
const shapeUp = document.getElementById("shapeUp");
const shapeValue = document.getElementById("shapeValue");

let shapeIndex = 0;
let shapeStarts = [1, 4, 7, 10, 13];

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

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const ENHARMONIC = {
  Db: "C#",
  Eb: "D#",
  Gb: "F#",
  Ab: "G#",
  Bb: "A#",
};

function noteIdx(name) {
  const normalized = ENHARMONIC[name] || name;
  return NOTES.indexOf(normalized);
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

function drawScale() {
  if (!keySel || !modeSel || !guitarEl) return;

  const root = keySel.value;
  const mode = modeSel.value;
  const intervals = SCALE_FORMULAS[mode];
  if (!intervals) return;

  const isCAGEDMode = CAGED_MODES.has(mode);

  try {
    if (mode === "wholeTone") {
      const ePc = noteIdx("E");
      const rIdx = noteIdx(root);
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

  guitarEl.innerHTML = "";
  let windowStart = shapeStarts[shapeIndex];
  let windowWidth = 4;

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
  } else if (mode === "wholeTone") {
    windowWidth = 5;
    windowStart = normalizeWindowStart(windowStart);
  }

  const svg = renderScaleSVG(root, intervals, 1, 17, {
    windowStart,
    windowWidth,
    showOpen: false,
  });

  guitarEl.appendChild(svg);
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

drawScale();
