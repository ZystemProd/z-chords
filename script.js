let sectionCounter = 0; // track part number
let activeSectionIndex = null; // which section receives new chords
let twoHandsMode = localStorage.getItem("cv-twohands") === "true"; // track hand mode, persisted
let transposeOffset = 0; // current transpose amount shown in UI

document.addEventListener("DOMContentLoaded", () => {
  const addSectionCta = document.getElementById("addSectionCta");
  if (addSectionCta) {
    addSectionCta.addEventListener("click", () => {
      addSection();
    });
  }

  // Click outside any section clears active selection.
  // Use capture so CTA clicks can set a new active after this runs.
  document.addEventListener(
    "click",
    (e) => {
      const boards = document.getElementById("boards");
      if (!boards) return;
      const target = e.target;
      // Hide input suggestions if clicking outside the input wrapper
      const inputWrap = document.querySelector('.input-with-action');
      if (inputWrap && !inputWrap.contains(target)) {
        hideInputSuggestions();
      }
      const closestSection = target && target.closest ? target.closest("#boards .section") : null;
      if (closestSection) return; // clicked inside a section — keep selection

      // ignore clicks that originate from UI that will set an active section immediately after (CTA)
      const ignore = target && target.closest && target.closest("#addSectionCta");
      if (ignore) return;

      if (activeSectionIndex !== null) {
        activeSectionIndex = null;
        try {
          localStorage.removeItem("cv-active-section");
        } catch (_) {}
        document
          .querySelectorAll("#boards .section.active")
          .forEach((el) => el.classList.remove("active"));
      }
    },
    true
  );
});

const N_SHARP = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];
const ENHARMONIC = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#" };
const CHORD_PATTERNS = {
  // --- Triads ---
  "": [0, 4, 7], // Major
  m: [0, 3, 7], // Minor
  dim: [0, 3, 6], // Diminished
  aug: [0, 4, 8], // Augmented
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],

  // --- Sixth chords ---
  6: [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  "6/9": [0, 4, 7, 9, 14],
  "m6/9": [0, 3, 7, 9, 14],
  add6: [0, 4, 7, 9],
  add9: [0, 4, 7, 14],
  add13: [0, 4, 7, 21],
  add4: [0, 4, 7, 5],

  // --- Seventh chords ---
  7: [0, 4, 7, 10], // Dominant 7
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  "m(maj7)": [0, 3, 7, 11],
  "7#5": [0, 4, 8, 10],
  "7b5": [0, 4, 6, 10],
  "maj7#5": [0, 4, 8, 11],
  maj7b5: [0, 4, 6, 11],
  "m7#5": [0, 3, 8, 10],

  // --- Ninth chords ---
  9: [0, 4, 7, 10, 14],
  m9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  "7b9": [0, 4, 7, 10, 13],
  "7#9": [0, 4, 7, 10, 15],
  "9#11": [0, 4, 7, 10, 14, 18],
  m9b5: [0, 3, 6, 10, 14],

  // --- Eleventh chords ---
  11: [0, 4, 7, 10, 14, 17],
  maj11: [0, 4, 7, 11, 14, 17],
  m11: [0, 3, 7, 10, 14, 17],
  "7#11": [0, 4, 7, 10, 18],
  "maj7#11": [0, 4, 7, 11, 18],
  m11b5: [0, 3, 6, 10, 14, 17],

  // --- Thirteenth chords ---
  13: [0, 4, 7, 10, 14, 17, 21],
  maj13: [0, 4, 7, 11, 14, 17, 21],
  m13: [0, 3, 7, 10, 14, 17, 21],
  "7b13": [0, 4, 7, 10, 20],
  "7#13": [0, 4, 7, 10, 22],
  "13b9": [0, 4, 7, 10, 13, 21],
  "13#9": [0, 4, 7, 10, 15, 21],

  // --- Altered Dominants ---
  "7#9#11": [0, 4, 7, 10, 15, 18],
  "7b9b13": [0, 4, 7, 10, 13, 20],
  "7#5b9": [0, 4, 8, 10, 13],
  "7#5#9": [0, 4, 8, 10, 15],
  "7b5b9": [0, 4, 6, 10, 13],
  "7b5#9": [0, 4, 6, 10, 15],

  // --- Add chords / Misc ---
  add2: [0, 2, 4, 7],
  add4: [0, 4, 7, 5],
  add11: [0, 4, 7, 17],
};

const CHORD_TYPES = Object.keys(CHORD_PATTERNS).filter((k) => k !== "");
const typesSorted = CHORD_TYPES.slice().sort((a, b) => b.length - a.length);
const TYPE_RE = typesSorted.join("|");
const CHORD_RE = new RegExp(
  "^[ ]*([A-Ga-g])([#b]?)(?:(" + TYPE_RE + "))?[ ]*$"
);

// Scale formulas for piano scales (mirrors guitar.js)
const SCALE_FORMULAS_PIANO = {
  pentatonic: [0, 3, 5, 7, 10],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  minorBlues: [0, 3, 5, 6, 7, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  majorBlues: [0, 2, 3, 4, 7, 9],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  harmonicMajor: [0, 2, 4, 5, 7, 8, 11],
  diminishedHalfWhole: [0, 1, 3, 4, 6, 7, 9, 10],
  diminishedWholeHalf: [0, 2, 3, 5, 6, 8, 9, 11],
};

function normalizeRoot(r) {
  if (!r) return r;
  r = r.split(" ").join("");
  return r[0].toUpperCase() + (r[1] || "");
}
function nameToIndex(name) {
  if (!name) return -1;
  if (ENHARMONIC[name]) name = ENHARMONIC[name];
  return N_SHARP.indexOf(name);
}
function parseChordSymbol(sym) {
  const m = sym.match(CHORD_RE);
  if (!m) return null;
  return {
    root: normalizeRoot(m[1].toUpperCase() + (m[2] || "")),
    quality: m[3] || "",
  };
}
function buildChordNotes(rootName, quality, inversion = 0, octave = false) {
  const rootIdx = nameToIndex(rootName);
  if (rootIdx < 0) return null;
  const pattern = CHORD_PATTERNS[quality === undefined ? "" : quality];
  if (!pattern) return null;

  const baseMidi = 60;
  const origRootMidi = baseMidi + rootIdx;

  // Interval numbers that correspond to the extensions
  const EXTENDED_SEMITONES = [13, 14, 15, 17, 18, 20, 21, 22]; // matches your chord patterns

  let notes = pattern.map((interval) => {
    let midi = origRootMidi + interval;

    // Shift extended intervals down an octave
    if (EXTENDED_SEMITONES.includes(interval)) {
      midi -= 12;
    }

    return { midi, interval };
  });

  // Apply inversions (move lowest note up an octave for each inversion)
  for (let i = 0; i < inversion; i++) {
    notes[0].midi += 12;
    notes.push(notes.shift());
  }

  // Apply octave shift
  if (octave) {
    notes = notes.map((n) => ({ midi: n.midi + 12, interval: n.interval }));
  }

  // Sort voicing by pitch
  notes.sort((a, b) => a.midi - b.midi);

  // Find the note in the voicing that matches the chord's root pitch-class.
  // Prefer the highest matching one so, for an inversion like E-G-C, the high C is picked.
  const rootPC = origRootMidi % 12;
  let actualRootNote = null;
  for (let i = notes.length - 1; i >= 0; i--) {
    if (notes[i].midi % 12 === rootPC) {
      actualRootNote = notes[i];
      break;
    }
  }
  if (!actualRootNote) actualRootNote = notes[0]; // fallback (shouldn't happen)

  return {
    notes: notes.map((n) => n.midi), // array of midi numbers (sorted)
    notesInfo: notes, // objects with .midi and original .interval
    rootMidi: actualRootNote.midi, // the midi value that represents the chord root in this voicing
    origRootMidi, // optional if you need it elsewhere
  };
}

function splitChordParts(sym = "") {
  const [mainRaw, bassRaw] = sym.split("/");
  return {
    main: (mainRaw || "").trim(),
    bass: bassRaw ? bassRaw.trim() : null,
  };
}

function formatSingleChordSymbol(sym) {
  if (!sym) return "";

  const m = sym.match(/^([A-Ga-g])([#b]?)(.*)$/);
  if (!m) return sym;

  const root = m[1].toUpperCase();
  const accidental = m[2] || "";
  let type = m[3] || "";

  // Replace common alterations with <sup> tags
  // Order matters: #11, b13, #9, b9, #5, b5, 6, 7, 9, 11, 13, addX
  type = type
    .replace(/(b9|#9|b5|#5|b13|#11|#13)/g, "<sup>$1</sup>")
    .replace(/add(\d+)/g, "add<sup>$1</sup>");

  return root + accidental + type;
}

function formatNoteForDisplay(note) {
  const normalized = normalizeRoot(note);
  if (!normalized) return "";
  return normalized.replace("#", "♯");
}

function formatChordSymbol(sym) {
  if (!sym) return "";

  const { main, bass } = splitChordParts(sym);
  const formattedMain = formatSingleChordSymbol(main);

  if (!bass) return formattedMain;

  const formattedBass = formatNoteForDisplay(bass);
  return `${formattedMain}/${formattedBass}`;
}

function getNoteNameNoOctave(midi) {
  return N_SHARP[midi % 12].replace("#", "♯");
}

function getPianoRange(useTwoHands) {
  return useTwoHands
    ? { low: 48, high: 83 } // three octaves (C3–B5)
    : { low: 60, high: 83 }; // original single-hand range
}

function normalizeMidiToRange(midi, low, high) {
  if (typeof midi !== "number") return null;
  let value = midi;
  while (value < low) value += 12;
  while (value > high) value -= 12;
  return value;
}

function computeLeftHandInfo(chord, chordData, useTwoHands) {
  if (!useTwoHands || !chordData) return null;

  const range = getPianoRange(true);
  let midi = null;
  let label = "";
  const voicing = chord.lhVoicing || "root"; // 'root' | 'fifth' | 'seventh'

  if (chord.customMIDIs && chordData.notes.length) {
    const baseMidi = chordData.notes[0];
    // For custom chords, respect existing behavior (root only)
    // Future: could derive 5th/7th by parsing chord.sym if desired
    midi = normalizeMidiToRange(baseMidi - 12, range.low, range.high);
    if (midi === null) return null;
    label = getNoteNameNoOctave(midi);
    return voicing === "root" ? { midi, label } : { leftHandMIDIs: [midi] };
  }

  const { main, bass } = splitChordParts(chord.sym);
  const parsed = parseChordSymbol(main);
  if (!parsed) return null;

  const bassName = bass ? normalizeRoot(bass) : parsed.root;
  const bassIdx = nameToIndex(bassName);
  if (bassIdx < 0) return null;

  let baseMidi = 60 + bassIdx;
  if (chord.octave) baseMidi += 12;

  // Build per-voicing left-hand
  if (voicing === "root") {
    midi = normalizeMidiToRange(baseMidi - 12, range.low, range.high);
    if (midi === null) return null;
    label = formatNoteForDisplay(bassName);
    return { midi, label };
  }

  const rootLH = normalizeMidiToRange(baseMidi - 12, range.low, range.high);
  if (rootLH === null) return null;

  if (voicing === "fifth") {
    const fifth = normalizeMidiToRange(
      baseMidi - 12 + 7,
      range.low,
      range.high
    );
    const arr = [rootLH];
    if (fifth !== null) arr.push(fifth);
    return { leftHandMIDIs: arr };
  }

  // seventh voicing: determine quality-specific 7th
  let seventhSemis = 10; // default minor 7th
  const pattern = CHORD_PATTERNS[parsed.quality || ""]; // may be undefined
  if (pattern && pattern.includes(11)) seventhSemis = 11; // maj7 present
  else if (pattern && pattern.includes(10))
    seventhSemis = 10; // dom/min7 present
  else if (pattern && pattern.includes(9)) seventhSemis = 9; // dim7 present
  else {
    // heuristic fallback if no 7th in pattern
    if ((parsed.quality || "").includes("maj")) seventhSemis = 11;
    else if ((parsed.quality || "").includes("dim")) seventhSemis = 9;
    else seventhSemis = 10;
  }
  const seventh = normalizeMidiToRange(
    baseMidi - 12 + seventhSemis,
    range.low,
    range.high
  );
  const arr = [rootLH];
  if (seventh !== null) arr.push(seventh);
  return { leftHandMIDIs: arr };
}

const boardsEl = document.getElementById("boards");

// Persistence helpers
function saveSections() {
  try {
    localStorage.setItem("cv-sections", boardsEl.dataset.sections || "[]");
  } catch (_) {}
}

function loadSections() {
  try {
    const saved = localStorage.getItem("cv-sections");
    if (saved) boardsEl.dataset.sections = saved;
    const savedActive = localStorage.getItem("cv-active-section");
    if (savedActive !== null) {
      const idx = Number(savedActive);
      if (!Number.isNaN(idx)) activeSectionIndex = idx;
    }
  } catch (_) {}
}

function getWhiteKeyWidth() {
  const value = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(
      "--white-key-width"
    )
  );
  return Number.isFinite(value) ? value : 50;
}

function makePiano(chord, options = {}) {
  if (!chord) return document.createElement("div");

  const {
    twoHands = false,
    leftHandMidi = null,
    leftHandLabel = "",
    leftHandMIDIs = null,
  } = options;
  const midiNotes = chord.notes || [];
  const rootMidi = chord.rootMidi;
  const { low: LOW, high: HIGH } = getPianoRange(twoHands);

  const intervals = midiNotes.map((m) => {
    if (typeof rootMidi !== "number") return "";
    const interval = (m - rootMidi + 12) % 12;
    switch (interval) {
      case 0:
        return "R";
      case 3:
        return "m3";
      case 4:
        return "3";
      case 5:
        return "4";
      case 6:
        return "b5";
      case 7:
        return "5";
      case 8:
        return "6";
      case 9:
        return "6/13";
      case 10:
        return "7";
      case 11:
        return "maj7";
      case 14:
        return "9";
      default:
        return "";
    }
  });

  const highlightMap = new Map();
  midiNotes.forEach((midi, idx) => {
    highlightMap.set(midi, {
      type: "right",
      label: intervals[idx],
    });
  });

  if (twoHands) {
    if (Array.isArray(leftHandMIDIs) && leftHandMIDIs.length) {
      leftHandMIDIs.forEach((lh) => {
        const normalized = normalizeMidiToRange(lh, LOW, HIGH);
        if (normalized !== null) {
          highlightMap.set(normalized, { type: "left", label: "LH" });
        }
      });
    } else if (typeof leftHandMidi === "number") {
      const normalized = normalizeMidiToRange(leftHandMidi, LOW, HIGH);
      if (normalized !== null) {
        highlightMap.set(normalized, {
          type: "left",
          label: leftHandLabel || "LH",
        });
      }
    }
  }

  const whiteMIDIs = [];
  for (let m = LOW; m <= HIGH; m++) {
    if (!N_SHARP[m % 12].includes("#")) whiteMIDIs.push(m);
  }

  const pianoWrap = document.createElement("div");
  pianoWrap.className = "piano";
  if (twoHands) pianoWrap.classList.add("two-hands");

  const whiteGrid = document.createElement("div");
  whiteGrid.className = "white-keys";
  if (twoHands) {
    const keyWidth = getWhiteKeyWidth();
    whiteGrid.style.gridTemplateColumns = `repeat(${whiteMIDIs.length}, ${keyWidth}px)`;
    whiteGrid.style.width = `${whiteMIDIs.length * keyWidth}px`;
  } else {
    whiteGrid.style.gridTemplateColumns = "";
    whiteGrid.style.width = "";
  }

  whiteMIDIs.forEach((midi) => {
    const wk = document.createElement("div");
    wk.className = "white-key";
    wk.dataset.midi = midi;

    if (midi === rootMidi) wk.classList.add("root");

    const nm = N_SHARP[midi % 12];
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = nm.replace("#", "♯");
    wk.appendChild(label);

    const meta = highlightMap.get(midi);
    if (meta) {
      wk.classList.add("pressed");
      if (meta.type === "left") wk.classList.add("left-hand");

      if (meta.label) {
        const interval = document.createElement("div");
        interval.className =
          meta.type === "left" ? "interval left-hand-label" : "interval";
        interval.textContent = meta.label;
        wk.appendChild(interval);
      }
    }

    whiteGrid.appendChild(wk);
  });

  pianoWrap.appendChild(whiteGrid);

  requestAnimationFrame(() => {
    const whiteEls = whiteGrid.querySelectorAll(".white-key");
    whiteEls.forEach((wk) => {
      const midi = parseInt(wk.dataset.midi, 10);
      const note = N_SHARP[midi % 12];
      if (note === "E" || note === "B") return;

      const blackMidi = midi + 1;
      const bk = document.createElement("div");
      bk.className = "black-key";
      bk.dataset.midi = blackMidi;

      const whiteWidthPx = wk.offsetWidth;
      const blackWidthPx = bk.offsetWidth;
      const leftPx = wk.offsetLeft + whiteWidthPx - (blackWidthPx / 2 + -4);
      bk.style.left = leftPx + "px";

      if (blackMidi === rootMidi) bk.classList.add("root");

      const meta = highlightMap.get(blackMidi);
      if (meta) {
        bk.classList.add("pressed");
        if (meta.type === "left") bk.classList.add("left-hand");

        if (meta.label) {
          const interval = document.createElement("div");
          interval.className =
            meta.type === "left" ? "interval left-hand-label" : "interval";
          interval.textContent = meta.label;
          bk.appendChild(interval);
        }
      }

      pianoWrap.appendChild(bk);
    });
  });

  return pianoWrap;
}

function getName(midi) {
  const note = N_SHARP[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return note.replace("#", "♯") + octave;
}

// Make preview mode default
boardsEl.classList.add("preview");

function addChordToList(sym) {
  if (!sym) return;
  const parsed = parseChordSymbol(sym);
  if (!parsed) return;
  const list = boardsEl.dataset.chordsList
    ? JSON.parse(boardsEl.dataset.chordsList)
    : [];
  list.push({ sym: sym.trim(), inversion: 0 });
  boardsEl.dataset.chordsList = JSON.stringify(list);
  render();
}

function addChordsFromInput(inputValue) {
  if (!inputValue) return;

  const chords = inputValue
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c);

  let sections = boardsEl.dataset.sections
    ? JSON.parse(boardsEl.dataset.sections)
    : [];

  if (sections.length === 0) {
    sections.push({ name: "Untitled", chords: [] });
  }

  const targetIdx =
    typeof activeSectionIndex === "number" &&
    activeSectionIndex >= 0 &&
    activeSectionIndex < sections.length
      ? activeSectionIndex
      : sections.length - 1;

  chords.forEach((c) => {
    sections[targetIdx].chords.push({ sym: c, inversion: 0 });
  });

  boardsEl.dataset.sections = JSON.stringify(sections);
  renderSections();
}

const chordInput = document.getElementById("chordInput");
// Hover glow for the chord input wrapper (radial gradient that follows mouse)
(() => {
  const inputWrap = document.querySelector('.input-with-action');
  if (!inputWrap) return;

  const RADIUS = 140; // px

  function setGlowVisible(visible) {
    // keep size constant for smoother fade; only animate opacity
    inputWrap.style.setProperty('--glow-opacity', visible ? '1' : '0');
  }

  inputWrap.addEventListener('mouseenter', () => setGlowVisible(true));
  inputWrap.addEventListener('mouseleave', () => setGlowVisible(false));
  inputWrap.addEventListener('mousemove', (e) => {
    const rect = inputWrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    inputWrap.style.setProperty('--glow-x', `${x}px`);
    inputWrap.style.setProperty('--glow-y', `${y}px`);
  });

  // initialize hidden and set base size/color
  inputWrap.style.setProperty('--glow-size', `${RADIUS}px`);
  if (!getComputedStyle(inputWrap).getPropertyValue('--glow-color')) {
    inputWrap.style.setProperty('--glow-color', 'rgba(30,110,240,0.55)');
  }
  setGlowVisible(false);
})();
const suggestionsEl = document.getElementById("suggestions"); // legacy datalist (unused for UI)
const inputSuggestions = document.getElementById("inputSuggestions");
const handModeToggle = document.getElementById("handModeToggle");
const transposeValueEl = document.getElementById("transposeValue");

function updateTransposeUI() {
  if (transposeValueEl) transposeValueEl.textContent = String(transposeOffset);
}

function buildInputMatches(val) {
  const matches = [];
  if (!val) return matches;
  const u = val.toUpperCase();
  N_SHARP.forEach((note) => {
    CHORD_TYPES.forEach((type) => {
      const chord = note + type;
      if (chord.toUpperCase().startsWith(u)) matches.push(chord);
    });
  });
  return matches.slice(0, 10);
}

function showInputSuggestions() {
  if (!inputSuggestions) return;
  const val = chordInput.value.trim();
  const matches = buildInputMatches(val);
  inputSuggestions.innerHTML = "";

  // Always first: Add Custom Chord
  const custom = document.createElement("div");
  custom.className = "suggestion add-custom";
  custom.setAttribute("role", "option");
  custom.innerHTML = '<span class="plus">+</span> Add Custom Chord';
  custom.addEventListener("click", () => {
    openCustomChordModal();
    hideInputSuggestions();
  });
  inputSuggestions.appendChild(custom);

  // Divider
  const div = document.createElement("div");
  div.className = "menu-divider";
  inputSuggestions.appendChild(div);

  if (matches.length) {
    matches.forEach((m) => {
      const item = document.createElement("div");
      item.className = "suggestion";
      item.setAttribute("role", "option");
      item.textContent = m;
      item.addEventListener("click", () => {
        chordInput.value = m;
        addChordsFromInput(m);
        chordInput.value = "";
        hideInputSuggestions();
      });
      inputSuggestions.appendChild(item);
    });
  }

  inputSuggestions.hidden = false;
}

function hideInputSuggestions() {
  if (inputSuggestions) inputSuggestions.hidden = true;
}

chordInput.addEventListener("focus", () => {
  showInputSuggestions();
});

chordInput.addEventListener("input", () => {
  showInputSuggestions();
});

chordInput.addEventListener("keydown", (e) => {
  if (!inputSuggestions || inputSuggestions.hidden) return;
  const items = Array.from(inputSuggestions.querySelectorAll('.suggestion'));
  const current = inputSuggestions.querySelector('.suggestion.highlight');
  let idx = current ? items.indexOf(current) : -1;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    idx = Math.min(items.length - 1, idx + 1);
    items.forEach(el => el.classList.remove('highlight'));
    if (idx >= 0) items[idx].classList.add('highlight');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    idx = Math.max(0, idx - 1);
    items.forEach(el => el.classList.remove('highlight'));
    if (idx >= 0) items[idx].classList.add('highlight');
  } else if (e.key === 'Enter' && idx >= 0) {
    e.preventDefault();
    items[idx].click();
  } else if (e.key === 'Escape') {
    hideInputSuggestions();
  }
});

function transposeChords(amount) {
  let sections = JSON.parse(boardsEl.dataset.sections || "[]");

  sections.forEach((section) => {
    section.chords.forEach((ch) => {
      // Standard chords
      if (!ch.customMIDIs) {
        const { main, bass } = splitChordParts(ch.sym);
        const parsed = parseChordSymbol(main);
        if (parsed) {
          let rootIdx = nameToIndex(parsed.root);
          if (rootIdx >= 0) {
            rootIdx = (rootIdx + amount + 12) % 12;
            const newRoot = N_SHARP[rootIdx];
            let updated = newRoot + (parsed.quality || "");

            if (bass) {
              const bassIdxOrig = nameToIndex(normalizeRoot(bass));
              if (bassIdxOrig >= 0) {
                const bassIdx = (bassIdxOrig + amount + 12) % 12;
                const newBass = N_SHARP[bassIdx];
                updated += `/${newBass}`;
              }
            }

            ch.sym = updated;
          }
        }
      }

      // Custom chords
      if (ch.customMIDIs) {
        ch.customMIDIs = ch.customMIDIs.map((m) => m + amount); // shift MIDI numbers
        if (ch.rootMidi !== undefined && ch.rootMidi !== null) {
          ch.rootMidi += amount;
        }
        if (Array.isArray(ch.leftHandMIDIs)) {
          ch.leftHandMIDIs = ch.leftHandMIDIs.map((m) => m + amount);
        }
      }
    });
  });

  boardsEl.dataset.sections = JSON.stringify(sections);
  renderSections();
}

document.getElementById("transposeUp").addEventListener("click", () => {
  transposeOffset += 1;
  updateTransposeUI();
  transposeChords(1);
});
document.getElementById("transposeDown").addEventListener("click", () => {
  transposeOffset -= 1;
  updateTransposeUI();
  transposeChords(-1);
});

chordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault(); // stop form submission or focus jumps
    addChordsFromInput(chordInput.value);
    chordInput.value = "";
    suggestionsEl.innerHTML = "";
  }
});

// One-hand / two-hands icons via Material Symbols 'back_hand'
const HAND_ICONS = {
  one: `<span class="material-symbols-outlined" aria-hidden="true">back_hand</span>`,
  two: `<span class="material-symbols-outlined hand-mirror" aria-hidden="true">back_hand</span><span class="material-symbols-outlined" aria-hidden="true">back_hand</span>`,
};

if (handModeToggle) {
  const updateHandModeButton = () => {
    handModeToggle.innerHTML = twoHandsMode ? HAND_ICONS.two : HAND_ICONS.one;
    handModeToggle.classList.add("icon-btn");
    handModeToggle.setAttribute(
      "title",
      twoHandsMode ? "Switch to one-hand layout" : "Switch to two-hands layout"
    );
    handModeToggle.setAttribute(
      "aria-label",
      twoHandsMode ? "Two hands mode" : "One hand mode"
    );
    handModeToggle.setAttribute("aria-pressed", String(twoHandsMode));
  };

  handModeToggle.addEventListener("click", () => {
    twoHandsMode = !twoHandsMode;
    boardsEl.classList.toggle("two-hands-mode", twoHandsMode);
    renderSections();
    updateHandModeButton();
    try {
      localStorage.setItem("cv-twohands", String(twoHandsMode));
    } catch (_) {}
  });

  updateHandModeButton();
}

function updateSuggestions() {
  suggestedEl.innerHTML = "";
  if (selectedMIDIs.size < 2) return;

  const selectedPCs = Array.from(selectedMIDIs)
    .map((m) => m % 12)
    .sort((a, b) => a - b);
  const matches = [];

  for (const [type, pattern] of Object.entries(CHORD_PATTERNS)) {
    const rootsToCheck =
      rootMID !== null
        ? [rootMID % 12] // only the selected root
        : [...Array(12).keys()]; // all roots if no root selected

    rootsToCheck.forEach((rootPC) => {
      const chordPCs = pattern
        .map((i) => (rootPC + i) % 12)
        .sort((a, b) => a - b);

      if (rootMID !== null) {
        // **Exact match** if root is selected
        if (
          selectedPCs.length === chordPCs.length &&
          selectedPCs.every((pc) => chordPCs.includes(pc))
        ) {
          const rootName = N_SHARP[rootPC];
          matches.push(rootName + (type || ""));
        }
      } else {
        // Partial match if no root is selected (don't multiply suggestions)
        if (selectedPCs.every((pc) => chordPCs.includes(pc))) {
          const rootName = N_SHARP[rootPC];
          matches.push(rootName + (type || ""));
        }
      }
    });
  }

  const uniqueMatches = [...new Set(matches)];

  if (!uniqueMatches.length) {
    suggestedEl.textContent = "No matching chord found";
  } else {
    suggestedEl.innerHTML = "";
    uniqueMatches.forEach((match) => {
      const btn = document.createElement("div");
      btn.className = "clickable-suggestion";
      btn.innerHTML = formatChordSymbol(match);
      btn.addEventListener("click", () => (customChordNameInput.value = match));
      suggestedEl.appendChild(btn);
    });
  }
}

const customModal = document.getElementById("customChordModal");
const openModalBtn = document.getElementById("openCustomChordModal");
const closeModalBtn = document.getElementById("closeModal");
const customPianoEl = document.getElementById("customPiano");
const addCustomChordBtn = document.getElementById("addCustomChord");
const suggestedEl = document.getElementById("suggestedChords");
const customChordNameInput = document.getElementById("customChordName");
const markRightBtn = document.getElementById("markRight");
const markLeftBtn = document.getElementById("markLeft");

let selectedMIDIs = new Set(); // right-hand selections in modal
let selectedLeftMIDIs = new Set(); // left-hand selections in modal
let customMarkingHand = "right"; // which hand new clicks mark in modal
let editingContext = { active: false, sectionIndex: null, chordIndex: null };

function openCustomChordModal() {
  if (!customModal) return;
  customModal.style.display = "block";
  selectedMIDIs.clear();
  selectedLeftMIDIs.clear();
  customChordNameInput.value = "";
  suggestedEl.innerHTML = "";
  editingContext = { active: false, sectionIndex: null, chordIndex: null };
  customMarkingHand = "right";
  if (markRightBtn && markLeftBtn) {
    markRightBtn.setAttribute("aria-pressed", "true");
    markLeftBtn.setAttribute("aria-pressed", "false");
  }
  try {
    addCustomChordBtn.textContent = "Add Chord";
  } catch (_) {}
  renderCustomPiano();
  updateSuggestions();
}

document.addEventListener("DOMContentLoaded", () => {
  const customModal = document.getElementById("customChordModal");
  const openModalBtn = document.getElementById("openCustomChordModal");
  const closeModalBtn = document.getElementById("closeModal");

  function updateHandToggleUI() {
    if (markRightBtn && markLeftBtn) {
      markRightBtn.setAttribute(
        "aria-pressed",
        String(customMarkingHand === "right")
      );
      markLeftBtn.setAttribute(
        "aria-pressed",
        String(customMarkingHand === "left")
      );
    }
  }

  if (markRightBtn && markLeftBtn) {
    markRightBtn.addEventListener("click", () => {
      customMarkingHand = "right";
      updateHandToggleUI();
    });
    markLeftBtn.addEventListener("click", () => {
      customMarkingHand = "left";
      updateHandToggleUI();
    });
  }

  if (openModalBtn) {
    openModalBtn.addEventListener("click", () => {
      openCustomChordModal();
    });
  }

  closeModalBtn.addEventListener("click", () => {
    customModal.style.display = "none";
    resetCustomChordModal();
  });

  window.addEventListener("click", (e) => {
    if (e.target === customModal) {
      customModal.style.display = "none";
      resetCustomChordModal();
    }
  });
});

// Tracks the current root and previous root element
let rootMID = null; // tracks the chosen root

function renderCustomPiano() {
  customPianoEl.innerHTML = "";
  // Use 3-octave range and two-hands layout for custom modal
  const { low: LOW, high: HIGH } = getPianoRange(true);
  const whiteMIDIs = [];
  for (let m = LOW; m <= HIGH; m++)
    if (!N_SHARP[m % 12].includes("#")) whiteMIDIs.push(m);

  const pianoWrap = document.createElement("div");
  pianoWrap.className = "piano two-hands";
  const whiteGrid = document.createElement("div");
  whiteGrid.className = "white-keys";

  // Explicit grid so black keys position correctly in wide layouts
  const keyWidth = getWhiteKeyWidth();
  whiteGrid.style.gridTemplateColumns = `repeat(${whiteMIDIs.length}, ${keyWidth}px)`;
  whiteGrid.style.width = `${whiteMIDIs.length * keyWidth}px`;

  // Left hand is user-selected; no auto-derivation

  // White keys
  whiteMIDIs.forEach((midi) => {
    const wk = document.createElement("div");
    wk.className = "white-key";
    wk.dataset.midi = midi;

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = N_SHARP[midi % 12].replace("#", "♯");
    wk.appendChild(label);

    // Apply classes instead of inline styles to match main piano
    if (selectedMIDIs.has(midi)) wk.classList.add("pressed"); // right hand
    if (selectedLeftMIDIs.has(midi)) {
      wk.classList.add("pressed", "left-hand");
      const lh = document.createElement("div");
      lh.className = "interval left-hand-label";
      lh.textContent = "LH";
      wk.appendChild(lh);
    }
    if (rootMID === midi) wk.classList.add("root");

    // Only show "R" on marked keys (selected or root)
    if (
      selectedMIDIs.has(midi) ||
      selectedLeftMIDIs.has(midi) ||
      rootMID === midi
    ) {
      const rootLabel = document.createElement("div");
      rootLabel.className = "root-label";
      rootLabel.textContent = "R";

      if (rootMID === midi) rootLabel.classList.add("active");

      rootLabel.addEventListener("click", (e) => {
        e.stopPropagation();
        rootMID = midi;
        renderCustomPiano();
      });

      wk.appendChild(rootLabel); // append inside the key
      updateSuggestions(); // <-- update suggestions now
    }

    wk.addEventListener("click", () => toggleKey(midi, wk));
    whiteGrid.appendChild(wk);
  });

  pianoWrap.appendChild(whiteGrid);

  // Black keys
  requestAnimationFrame(() => {
    const whiteEls = whiteGrid.querySelectorAll(".white-key");
    whiteEls.forEach((wk) => {
      const midi = parseInt(wk.dataset.midi);
      if (["E", "B"].includes(N_SHARP[midi % 12])) return;

      const blackMidi = midi + 1;
      const bk = document.createElement("div");
      bk.className = "black-key";
      bk.dataset.midi = blackMidi;

      if (selectedMIDIs.has(blackMidi)) bk.classList.add("pressed"); // right hand
      if (selectedLeftMIDIs.has(blackMidi)) {
        bk.classList.add("pressed", "left-hand");
        const lh = document.createElement("div");
        lh.className = "interval left-hand-label";
        lh.textContent = "LH";
        bk.appendChild(lh);
      }
      if (rootMID === blackMidi) bk.classList.add("root");

      if (
        selectedMIDIs.has(blackMidi) ||
        selectedLeftMIDIs.has(blackMidi) ||
        rootMID === blackMidi
      ) {
        const rootLabel = document.createElement("div");
        rootLabel.className = "root-label";
        rootLabel.textContent = "R";

        if (rootMID === blackMidi) rootLabel.classList.add("active");

        rootLabel.addEventListener("click", (e) => {
          e.stopPropagation();
          rootMID = blackMidi; // set the root
          renderCustomPiano(); // re-render keys
          updateSuggestions(); // update chord suggestions
        });

        bk.appendChild(rootLabel); // append inside black key
      }

      bk.addEventListener("click", () => toggleKey(blackMidi, bk));

      const whiteWidthPx = wk.offsetWidth;
      const blackWidthPx = bk.offsetWidth;
      const leftPx = wk.offsetLeft + whiteWidthPx - (blackWidthPx / 2 + -4);
      bk.style.left = leftPx + "px";
      pianoWrap.appendChild(bk);
    });
  });

  customPianoEl.appendChild(pianoWrap);
}

function resetCustomChordModal() {
  selectedMIDIs.clear();
  selectedLeftMIDIs.clear();
  rootMID = null;
  customChordNameInput.value = "";
  suggestedEl.innerHTML = "";
  customPianoEl.innerHTML = "";
  customMarkingHand = "right";
  try {
    addCustomChordBtn.textContent = "Add Chord";
  } catch (_) {}
}

function toggleKey(midi, el) {
  const isLeft = customMarkingHand === "left";
  const addSet = isLeft ? selectedLeftMIDIs : selectedMIDIs;
  const otherSet = isLeft ? selectedMIDIs : selectedLeftMIDIs;

  if (addSet.has(midi)) {
    // Remove from the active hand
    addSet.delete(midi);
    if (
      rootMID === midi &&
      !selectedMIDIs.has(midi) &&
      !selectedLeftMIDIs.has(midi)
    ) {
      rootMID = null;
    }
  } else {
    // Overwrite rule: ensure membership is exclusive between hands
    otherSet.delete(midi);
    addSet.add(midi);
  }

  renderCustomPiano();
  updateSuggestions();
}

addCustomChordBtn.addEventListener("click", () => {
  if (selectedMIDIs.size === 0 && selectedLeftMIDIs.size === 0) return;

  let name = customChordNameInput.value.trim();
  if (!name) {
    name =
      suggestedEl.textContent.split(":")[1]?.split(",")[0]?.trim() ||
      "CustomChord";
  }

  const midiArray = Array.from(selectedMIDIs).sort((a, b) => a - b);
  const leftArray = Array.from(selectedLeftMIDIs).sort((a, b) => a - b);

  // Ensure chosen root is first
  if (rootMID !== null) {
    const idx = midiArray.indexOf(rootMID);
    if (idx > 0) {
      midiArray.splice(idx, 1);
      midiArray.unshift(rootMID);
    }
  }

  let sections = JSON.parse(boardsEl.dataset.sections || "[]");
  if (sections.length === 0) {
    sections.push({ name: "Default", chords: [] });
  }

  const chordObj = {
    sym: name,
    inversion: 0,
    octave: false,
    customMIDIs: midiArray,
    rootMidi: rootMID,
    leftHandMIDIs: leftArray,
  };

  if (editingContext.active) {
    const sIdx = editingContext.sectionIndex;
    const cIdx = editingContext.chordIndex;
    if (
      sIdx != null &&
      cIdx != null &&
      sections[sIdx] &&
      sections[sIdx].chords[cIdx]
    ) {
      sections[sIdx].chords[cIdx] = chordObj;
    }
  } else {
    const targetIdx =
      typeof activeSectionIndex === "number" &&
      activeSectionIndex >= 0 &&
      activeSectionIndex < sections.length
        ? activeSectionIndex
        : sections.length - 1;
    sections[targetIdx].chords.push(chordObj);
  }

  boardsEl.dataset.sections = JSON.stringify(sections);
  renderSections();

  // Close and reset modal state
  customModal.style.display = "none";
  resetCustomChordModal();
  editingContext = { active: false, sectionIndex: null, chordIndex: null };
});

// Handle root toggling dynamically
function toggleRoot(midi, labelEl) {
  if (prevRootEl) prevRootEl.classList.remove("active");

  if (rootMID === midi) {
    rootMID = null;
    prevRootEl = null;
  } else {
    rootMID = midi;
    prevRootEl = labelEl;
    labelEl.classList.add("active");
  }
}

// Removed legacy add-to-list handler; unified above

function applyInversionToMIDIs(midiArray, inversion) {
  if (!midiArray || midiArray.length === 0) return [];
  const notes = midiArray.slice(); // copy array
  for (let i = 0; i < inversion; i++) {
    notes.push(notes.shift() + 12); // move lowest note up an octave
  }
  return notes; // keep order to preserve inversion
}

function updatePreviewChord(card, chord) {
  // Remove old piano
  const oldPiano = card.querySelector(".piano");
  if (oldPiano) oldPiano.remove();

  let chordData;

  if (chord.customMIDIs) {
    // Apply inversion for custom chords
    const notes = applyInversionToMIDIs(chord.customMIDIs, chord.inversion);
    chordData = {
      notes,
      rootMidi: notes[0], // choose lowest note as root
    };
  } else {
    // Standard chord
    const { main } = splitChordParts(chord.sym);
    const parsed = parseChordSymbol(main);
    chordData = parsed
      ? buildChordNotes(
          parsed.root,
          parsed.quality,
          chord.inversion,
          chord.octave
        )
      : null;
  }

  if (!chordData) return;

  let leftHandInfo = null;
  let options = { twoHands: twoHandsMode };
  if (Array.isArray(chord.leftHandMIDIs) && chord.leftHandMIDIs.length) {
    options.leftHandMIDIs = chord.leftHandMIDIs.slice();
  } else {
    leftHandInfo = computeLeftHandInfo(chord, chordData, twoHandsMode);
    if (leftHandInfo && Array.isArray(leftHandInfo.leftHandMIDIs)) {
      options.leftHandMIDIs = leftHandInfo.leftHandMIDIs.slice();
    } else {
      options.leftHandMidi = leftHandInfo ? leftHandInfo.midi : null;
      options.leftHandLabel = leftHandInfo ? leftHandInfo.label : "";
    }
  }

  const newPiano = makePiano(chordData, options);

  // Insert new piano into the lh-piano wrapper (to the right of LH control)
  const container = card.querySelector(".lh-piano-wrap");
  if (container) {
    // remove any existing piano inside container
    const oldInner = container.querySelector(".piano");
    if (oldInner) oldInner.remove();
    container.appendChild(newPiano);
  } else {
    // Fallback: place above inversion controls
    const invWrap = card.querySelector(".inversion-control");
    card.insertBefore(newPiano, invWrap);
  }

  // Update LH label if present
  const lhLabel = card.querySelector(".lh-control .lh-label");
  if (lhLabel) {
    const mode = chord.lhVoicing || "root";
    lhLabel.textContent = ` ${
      mode === "root" ? "Root" : mode === "fifth" ? "5th" : "7th"
    }`;
  }
}

// Open custom chord modal prefilled with an existing chord for editing
function openCustomChordModalForEdit(sectionIndex, chordIndex) {
  const sections = JSON.parse(boardsEl.dataset.sections || "[]");
  const section = sections[sectionIndex];
  if (!section || !section.chords || !section.chords[chordIndex]) return;

  const ch = section.chords[chordIndex];
  let chordData = null;

  if (ch.customMIDIs) {
    const notes = applyInversionToMIDIs(ch.customMIDIs, ch.inversion || 0);
    chordData = {
      notes,
      rootMidi: ch.rootMidi != null ? ch.rootMidi : notes[0],
    };
  } else {
    const { main } = splitChordParts(ch.sym);
    const parsed = parseChordSymbol(main);
    chordData = parsed
      ? buildChordNotes(
          parsed.root,
          parsed.quality,
          ch.inversion || 0,
          ch.octave
        )
      : null;
  }

  if (!chordData) return;

  selectedMIDIs = new Set(chordData.notes);
  selectedLeftMIDIs = new Set(
    Array.isArray(ch.leftHandMIDIs) ? ch.leftHandMIDIs : []
  );
  rootMID = chordData.rootMidi;
  customChordNameInput.value = ch.sym || "";
  editingContext = { active: true, sectionIndex, chordIndex };
  suggestedEl.innerHTML = "";

  customModal.style.display = "block";
  customMarkingHand = "right";
  // if toggle buttons exist, reflect current state
  try {
    const mr = document.getElementById("markRight");
    const ml = document.getElementById("markLeft");
    if (mr && ml) {
      mr.setAttribute("aria-pressed", "true");
      ml.setAttribute("aria-pressed", "false");
    }
    addCustomChordBtn.textContent = "Update Chord";
  } catch (_) {}
  renderCustomPiano();
  updateSuggestions();
}

function renderSections() {
  boardsEl.classList.toggle("two-hands-mode", twoHandsMode);
  boardsEl.innerHTML = "";
  const sections = JSON.parse(boardsEl.dataset.sections || "[]");

  // Persist and toggle empty state
  try {
    localStorage.setItem("cv-sections", boardsEl.dataset.sections || "[]");
  } catch (_) {}
  const emptyEl = document.getElementById("emptyState");
  if (emptyEl) emptyEl.hidden = sections.length > 0;

  if (!sections.length) {
    boardsEl.innerHTML = "<p>No sections yet</p>";
    return;
  }

  // Clamp active index to available range
  if (sections.length) {
    if (
      typeof activeSectionIndex !== "number" ||
      activeSectionIndex < 0 ||
      activeSectionIndex >= sections.length
    ) {
      activeSectionIndex = sections.length - 1; // default to last
    }
  }

  sections.forEach((section, sectionIndex) => {
    // --- Section wrapper ---
    const sectionEl = document.createElement("div");
    sectionEl.className = "section";
    sectionEl.dataset.sectionIndex = sectionIndex;
    sectionEl.tabIndex = 0;
    if (sectionIndex === activeSectionIndex) sectionEl.classList.add("active");

    // --- Section header ---
    const headerWrap = document.createElement("div");
    headerWrap.className = "section-header";

    const header = document.createElement("h2");
    header.className = "editable-section-name";
    header.contentEditable = "false"; // only editable on explicit activate
    header.spellcheck = false;
    header.textContent = section.name;

    // Activate editing with double-click or Enter while focused via keyboard
    let prevHeaderText = header.textContent;
    const startEditing = () => {
      prevHeaderText = header.textContent;
      header.contentEditable = "true";
      header.focus();
      // place caret at end
      try {
        const range = document.createRange();
        range.selectNodeContents(header);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) {}
    };
    header.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startEditing();
    });
    header.addEventListener("keydown", (e) => {
      if (header.contentEditable !== "true") return;
      if (e.key === "Enter") {
        e.preventDefault();
        header.blur();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        header.textContent = prevHeaderText;
        header.blur();
      }
    });
    header.addEventListener("focus", (e) => {
      // Allow keyboard users to press Enter to start editing
      if (header.contentEditable !== "true") {
        // do not automatically edit on focus
      }
    });
    // Save changes on blur and end editing
    header.addEventListener("blur", () => {
      if (header.contentEditable === "true") {
        const secs = JSON.parse(boardsEl.dataset.sections || "[]");
        secs[sectionIndex].name =
          header.textContent.trim() ||
          `Part ${String.fromCharCode(64 + sectionIndex + 1)}`;
        boardsEl.dataset.sections = JSON.stringify(secs);
      }
      header.contentEditable = "false";
    });

    // Remove section button
    const removeSectionBtn = document.createElement("button");
    removeSectionBtn.className = "remove-section no-drag";
    removeSectionBtn.textContent = "×";
    removeSectionBtn.addEventListener("click", () => {
      sections.splice(sectionIndex, 1);
      boardsEl.dataset.sections = JSON.stringify(sections);
      // adjust active index
      if (activeSectionIndex !== null) {
        if (sectionIndex === activeSectionIndex) {
          activeSectionIndex = Math.max(0, Math.min(activeSectionIndex, sections.length - 1));
        } else if (sectionIndex < activeSectionIndex) {
          activeSectionIndex -= 1;
        }
        try { localStorage.setItem("cv-active-section", String(activeSectionIndex)); } catch (_) {}
      }
      renderSections();
    });

    headerWrap.appendChild(header);
    headerWrap.appendChild(removeSectionBtn);
    sectionEl.appendChild(headerWrap);

    // --- Chords container ---
    const chordsContainer = document.createElement("div");
    chordsContainer.className = "chords-container";
    chordsContainer.dataset.sectionIndex = sectionIndex;

    section.chords.forEach((chord, chordIndex) => {
      const card = document.createElement("div");
      card.className = "card preview";
      card.dataset.chordIndex = chordIndex;
      card.innerHTML = `<h3>${formatChordSymbol(chord.sym)}</h3>`;

      // --- Build chord piano ---
      let chordData;
      if (chord.customMIDIs) {
        const notes = applyInversionToMIDIs(chord.customMIDIs, chord.inversion);
        chordData = {
          notes,
          rootMidi: notes[0],
        };
      } else {
        const { main } = splitChordParts(chord.sym);
        const parsed = parseChordSymbol(main);
        chordData = parsed
          ? buildChordNotes(
              parsed.root,
              parsed.quality,
              chord.inversion,
              chord.octave
            )
          : null;
      }

      let builtPiano = null;
      if (chordData) {
        let pianoOptions = { twoHands: twoHandsMode };
        if (Array.isArray(chord.leftHandMIDIs) && chord.leftHandMIDIs.length) {
          pianoOptions.leftHandMIDIs = chord.leftHandMIDIs.slice();
        } else {
          const leftHandInfo = computeLeftHandInfo(
            chord,
            chordData,
            twoHandsMode
          );
          if (leftHandInfo && Array.isArray(leftHandInfo.leftHandMIDIs)) {
            pianoOptions.leftHandMIDIs = leftHandInfo.leftHandMIDIs.slice();
          } else {
            pianoOptions.leftHandMidi = leftHandInfo ? leftHandInfo.midi : null;
            pianoOptions.leftHandLabel = leftHandInfo ? leftHandInfo.label : "";
          }
        }
        builtPiano = makePiano(chordData, pianoOptions);
      }

      // --- Inversion controls ---
      const invWrap = document.createElement("div");
      invWrap.className = "inversion-control";

      const leftBtn = document.createElement("button");
      leftBtn.className = "no-drag";
      leftBtn.innerHTML = "&#8592;";
      leftBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const totalNotes = chord.customMIDIs
          ? chord.customMIDIs.length
          : chordData.notes.length;
        chord.inversion = (chord.inversion - 1 + totalNotes) % totalNotes;
        updatePreviewChord(card, chord);
      });

      const rightBtn = document.createElement("button");
      rightBtn.className = "no-drag";
      rightBtn.innerHTML = "&#8594;";
      rightBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const totalNotes = chord.customMIDIs
          ? chord.customMIDIs.length
          : chordData.notes.length;
        chord.inversion = (chord.inversion + 1) % totalNotes;
        updatePreviewChord(card, chord);
      });

      const label = document.createElement("span");
      label.className = "inv-label";
      label.textContent = "inv.";

      invWrap.appendChild(leftBtn);
      invWrap.appendChild(label);
      invWrap.appendChild(rightBtn);
      card.appendChild(invWrap);

      // --- Left-hand voicing control ---
      const lhWrap = document.createElement("div");
      lhWrap.className = "lh-control";

      const lhModes = ["root", "fifth", "seventh"];
      const setLHLabel = () => {
        const mode = chord.lhVoicing || "root";
        lhLabel.textContent = `${
          mode === "root" ? "Root" : mode === "fifth" ? "5th" : "7th"
        }`;
      };

      const lhLeft = document.createElement("button");
      lhLeft.className = "no-drag";
      lhLeft.innerHTML = "&#8593;";
      lhLeft.addEventListener("click", (e) => {
        e.stopPropagation();
        const cur = chord.lhVoicing || "root";
        let idx = lhModes.indexOf(cur);
        if (idx === -1) idx = 0;
        // Up arrow cycles forward: root -> 5th -> 7th
        idx = (idx + 1) % lhModes.length;
        chord.lhVoicing = lhModes[idx];
        setLHLabel();
        updatePreviewChord(card, chord);
        boardsEl.dataset.sections = JSON.stringify(sections);
      });

      const lhLabel = document.createElement("span");
      lhLabel.className = "lh-label";
      setLHLabel();

      const lhRight = document.createElement("button");
      lhRight.className = "no-drag";
      lhRight.innerHTML = "&#8595;";
      lhRight.addEventListener("click", (e) => {
        e.stopPropagation();
        const cur = chord.lhVoicing || "root";
        let idx = lhModes.indexOf(cur);
        if (idx === -1) idx = 0;
        // Down arrow cycles backward: 7th -> 5th -> root
        idx = (idx - 1 + lhModes.length) % lhModes.length;
        chord.lhVoicing = lhModes[idx];
        setLHLabel();
        updatePreviewChord(card, chord);
        boardsEl.dataset.sections = JSON.stringify(sections);
      });

      lhWrap.appendChild(lhLeft);
      lhWrap.appendChild(lhLabel);
      lhWrap.appendChild(lhRight);
      // Insert LH control to the left of the piano
      const lpw = document.createElement("div");
      lpw.className = "lh-piano-wrap";
      lpw.appendChild(lhWrap);
      // Wrap the piano in a horizontal scroller for two-hands layouts
      const scroller = document.createElement("div");
      scroller.className = "piano-scroll";
      if (builtPiano) scroller.appendChild(builtPiano);
      lpw.appendChild(scroller);
      // Place wrapper above inversion controls
      card.insertBefore(lpw, invWrap);

      // --- Edit chord button ---
      const editBtn = document.createElement("button");
      editBtn.className = "edit-chord-section no-drag";
      editBtn.textContent = "Edit";
      editBtn.title = "Edit chord";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openCustomChordModalForEdit(sectionIndex, chordIndex);
      });

      // --- Remove chord button ---
      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-chord-section no-drag";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        section.chords.splice(chordIndex, 1);
        boardsEl.dataset.sections = JSON.stringify(sections);
        renderSections();
      });

      card.appendChild(editBtn);
      card.appendChild(removeBtn);

      chordsContainer.appendChild(card);
    });

    sectionEl.appendChild(chordsContainer);

    // Clicking anywhere in the section (except interactive controls) sets it active
    sectionEl.addEventListener("click", (e) => {
      // ignore clicks on remove/edit buttons and sortable handles
      const t = e.target;
      if (t && (t.closest && (t.closest(".no-drag") || t.closest(".remove-section")))) return;
      activeSectionIndex = sectionIndex;
      try { localStorage.setItem("cv-active-section", String(activeSectionIndex)); } catch (_) {}
      // update classes without full re-render
      document.querySelectorAll("#boards .section").forEach((el, i) => {
        if (i === activeSectionIndex) el.classList.add("active");
        else el.classList.remove("active");
      });
    });
    boardsEl.appendChild(sectionEl);
  });

  // --- Make sections draggable ---
  Sortable.create(boardsEl, {
    animation: 150,
    handle: ".section-header", // only drag by header
    onEnd: (evt) => {
      const secs = JSON.parse(boardsEl.dataset.sections || "[]");
      if (evt.oldIndex < 0 || evt.newIndex < 0) return;
      const moved = secs.splice(evt.oldIndex, 1)[0];
      secs.splice(evt.newIndex, 0, moved);
      boardsEl.dataset.sections = JSON.stringify(secs);
      // update active index to follow the moved section
      if (typeof activeSectionIndex === "number") {
        if (evt.oldIndex === activeSectionIndex) {
          activeSectionIndex = evt.newIndex;
        } else if (
          evt.oldIndex < activeSectionIndex &&
          evt.newIndex >= activeSectionIndex
        ) {
          activeSectionIndex -= 1;
        } else if (
          evt.oldIndex > activeSectionIndex &&
          evt.newIndex <= activeSectionIndex
        ) {
          activeSectionIndex += 1;
        }
        try { localStorage.setItem("cv-active-section", String(activeSectionIndex)); } catch (_) {}
      }
      renderSections();
    },
  });

  // --- Enable drag for chords inside sections ---
  document.querySelectorAll(".chords-container").forEach((container) => {
    const idx = Number(container.dataset.sectionIndex);
    Sortable.create(container, {
      group: "sections",
      animation: 150,
      handle: ".card", // drag by card itself
      filter: ".no-drag", // ignore buttons
      onEnd: (evt) => {
        const secs = JSON.parse(boardsEl.dataset.sections || "[]");
        const fromSec = idx;
        const toSec = Number(evt.to.dataset.sectionIndex);
        const movedChord = secs[fromSec].chords.splice(evt.oldIndex, 1)[0];
        secs[toSec].chords.splice(evt.newIndex, 0, movedChord);
        boardsEl.dataset.sections = JSON.stringify(secs);
        renderSections();
      },
    });
  });
}

function addSection() {
  sectionCounter++;
  const name = `Part ${String.fromCharCode(64 + sectionCounter)}`; // 1 → A, 2 → B, etc.

  const sections = JSON.parse(boardsEl.dataset.sections || "[]");
  sections.push({ name, chords: [] });
  boardsEl.dataset.sections = JSON.stringify(sections);
  activeSectionIndex = sections.length - 1; // newly added becomes active
  try { localStorage.setItem("cv-active-section", String(activeSectionIndex)); } catch (_) {}
  renderSections();
}

function addChordToSection(sym, sectionIndex = 0) {
  const sections = JSON.parse(boardsEl.dataset.sections || "[]");
  if (!sections[sectionIndex]) return;

  sections[sectionIndex].chords.push({ sym: sym.trim(), inversion: 0 });
  boardsEl.dataset.sections = JSON.stringify(sections);
  renderSections();
}

// keep track of created Sortable instances so we can destroy them before recreating
let sortableInstances = [];

function enableDragAndDrop() {
  // destroy previous instances (if any)
  sortableInstances.forEach((inst) => {
    try {
      inst.destroy();
    } catch (e) {
      /* ignore */
    }
  });
  sortableInstances = [];

  const containers = document.querySelectorAll(".chords-container");
  containers.forEach((container) => {
    // ensure sectionIndex exists
    if (typeof container.dataset.sectionIndex === "undefined") {
      // try to find parent section index if not directly set
      const sec = container.closest(".section");
      if (sec && typeof sec.dataset.sectionIndex !== "undefined")
        container.dataset.sectionIndex = sec.dataset.sectionIndex;
    }

    const s = Sortable.create(container, {
      group: "sections", // allows dragging between sections
      animation: 150,
      onEnd: (evt) => {
        // guard: ensure sections exist
        const sections = JSON.parse(boardsEl.dataset.sections || "[]");
        const fromSec = Number(evt.from.dataset.sectionIndex || 0);
        const toSec = Number(evt.to.dataset.sectionIndex || 0);

        // defensive checks
        if (!sections[fromSec] || !sections[toSec]) return;

        const movedChord = sections[fromSec].chords.splice(evt.oldIndex, 1)[0];
        sections[toSec].chords.splice(evt.newIndex, 0, movedChord);

        boardsEl.dataset.sections = JSON.stringify(sections);
        renderSections(); // re-render to update indexes + UI
      },
    });

    sortableInstances.push(s);
  });
}

document.getElementById("addChord").addEventListener("click", () => {
  const rawValue = chordInput.value;
  if (!rawValue.trim()) return;

  addChordsFromInput(rawValue);
  chordInput.value = "";
  suggestionsEl.innerHTML = "";
});

document.getElementById("clearAll").addEventListener("click", () => {
  // Clear all sections and chords, reset counter, persist
  boardsEl.dataset.sections = JSON.stringify([]);
  sectionCounter = 0;
  activeSectionIndex = null;
  try {
    localStorage.setItem("cv-sections", "[]");
    localStorage.removeItem("cv-active-section");
  } catch (_) {}
  renderSections();
});

// SVG icons (fill uses currentColor)
const ICONS = {
  sun: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.8 1.42-1.42zM1 13h3v-2H1v2zm10-9h2V1h-2v3zm7.45 2.45l1.79-1.8-1.41-1.41-1.8 1.79 1.42 1.42zM20 11v2h3v-2h-3zM12 6a6 6 0 100 12 6 6 0 000-12zM4.24 19.16l1.8 1.79 1.41-1.41-1.79-1.8-1.42 1.42zM17.66 19.16l1.42-1.42-1.79-1.8-1.41 1.41 1.78 1.81zM11 23h2v-3h-2v3z"/>
  </svg>`,
  moon: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M21.75 15.45A9 9 0 0 1 8.55 2.25 9 9 0 1 0 21.75 15.45z"/>
  </svg>`,
};

// Instrument icons: Material piano + inline SVG guitar
const INSTRUMENT_ICONS = {
  piano: `<span class="material-symbols-outlined" aria-hidden="true">piano</span>`,
  // Lucide 'guitar' (MIT) for a cleaner silhouette
  guitar: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m11.9 12.1 4.514-4.514" />
    <path d="M20.1 2.3a1 1 0 0 0-1.4 0l-1.114 1.114A2 2 0 0 0 17 4.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 17.828 7h1.344a2 2 0 0 0 1.414-.586L21.7 5.3a1 1 0 0 0 0-1.4z" />
    <path d="m6 16 2 2" />
    <path d="M8.23 9.85A3 3 0 0 1 11 8a5 5 0 0 1 5 5 3 3 0 0 1-1.85 2.77l-.92.38A2 2 0 0 0 12 18a4 4 0 0 1-4 4 6 6 0 0 1-6-6 4 4 0 0 1 4-4 2 2 0 0 0 1.85-1.23z" />
  </svg>`,
};

// Helper: set icon + tooltip
function setThemeIcon(button, mode) {
  if (!button) return;
  if (mode === "light") {
    button.innerHTML = ICONS.sun;
    button.setAttribute("title", "Switch to dark mode");
    button.setAttribute("aria-pressed", "false");
  } else {
    button.innerHTML = ICONS.moon;
    button.setAttribute("title", "Switch to light mode");
    button.setAttribute("aria-pressed", "true");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const themeToggleBtn = document.getElementById("themeToggle");
  if (!themeToggleBtn) return;

  const saved = localStorage.getItem("cv-theme");
  const prefersLight =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  let themeMode = saved || (prefersLight ? "light" : "dark");

  // Apply initial mode
  document.body.classList.toggle("light-mode", themeMode === "light");

  // Helper: set icon using SVG files
  function setThemeIconSVG(mode) {
    if (!themeToggleBtn) return;
    if (mode === "light") {
      themeToggleBtn.innerHTML = `<img src="SVG/light_mode.svg" alt="Light Mode" />`;
      themeToggleBtn.setAttribute("title", "Switch to dark mode");
      themeToggleBtn.setAttribute("aria-pressed", "false");
    } else {
      themeToggleBtn.innerHTML = `<img src="SVG/dark_mode.svg" alt="Dark Mode" />`;
      themeToggleBtn.setAttribute("title", "Switch to light mode");
      themeToggleBtn.setAttribute("aria-pressed", "true");
    }
  }

  // Set initial icon
  setThemeIconSVG(themeMode);

  // Toggle on click
  themeToggleBtn.addEventListener("click", () => {
    const isLight = document.body.classList.toggle("light-mode");
    themeMode = isLight ? "light" : "dark";
    setThemeIconSVG(themeMode);
    localStorage.setItem("cv-theme", themeMode);
  });
});

document.getElementById("downloadPdf").addEventListener("click", async () => {
  // Clone the boards container into an off-screen div
  const boards = document.querySelector(".boards.preview");
  const clone = boards.cloneNode(true);

  // Apply light-mode for PDF capture
  clone.classList.add("pdf-capture");

  // Create hidden off-screen container
  const hiddenContainer = document.createElement("div");
  hiddenContainer.style.position = "fixed";
  hiddenContainer.style.top = "-9999px";
  hiddenContainer.style.left = "-9999px";
  hiddenContainer.style.opacity = "0"; // invisible
  hiddenContainer.appendChild(clone);
  document.body.appendChild(hiddenContainer);

  // Capture with html2canvas
  const canvas = await html2canvas(clone, {
    scale: 2,
    useCORS: true,
  });

  const imgData = canvas.toDataURL("image/png");
  const pdf = new jspdf.jsPDF("p", "mm", "a4");

  const pageWidth = pdf.internal.pageSize.getWidth();
  const imgWidth = pageWidth - 20; // padding
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  pdf.addImage(imgData, "PNG", 10, 10, imgWidth, imgHeight);
  pdf.save("chords.pdf");

  // Clean up
  document.body.removeChild(hiddenContainer);
});

// Help modal controls
document.addEventListener("DOMContentLoaded", () => {
  const helpBtn = document.getElementById("openHelpModal");
  const helpModal = document.getElementById("helpModal");
  const closeHelp = document.getElementById("closeHelpModal");
  if (!helpBtn || !helpModal || !closeHelp) return;
  const close = () => (helpModal.style.display = "none");
  helpBtn.addEventListener("click", () => (helpModal.style.display = "block"));
  closeHelp.addEventListener("click", close);
  window.addEventListener("click", (e) => {
    if (e.target === helpModal) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const mod = isMac ? e.metaKey : e.ctrlKey;
  // Focus input: Ctrl/Cmd+K
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    const input = document.getElementById("chordInput");
    if (input) input.focus();
  }
  // Export PDF: Ctrl/Cmd+Shift+P
  if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    const btn = document.getElementById("downloadPdf");
    if (btn) btn.click();
  }
  // Toggle two-hands: H
  if (!mod && e.key.toLowerCase() === "h") {
    const btn = document.getElementById("handModeToggle");
    if (btn) btn.click();
  }
  // Cycle instruments: G
  if (!mod && e.key.toLowerCase() === "g") {
    cycleInstrument();
  }
  // Toggle theme: T
  if (!mod && e.key.toLowerCase() === "t") {
    const btn = document.getElementById("themeToggle");
    if (btn) btn.click();
  }
});

// Instrument + Sub-tab state and UI
let currentInstrument = "piano";
let currentSubtab = { piano: "chord", guitar: "scale", drums: "beat" };

function loadInstrumentState() {
  try {
    const savedInst = localStorage.getItem("cv-instrument");
    if (savedInst) currentInstrument = savedInst;
    const savedSub = localStorage.getItem("cv-subtabs");
    if (savedSub) {
      const parsed = JSON.parse(savedSub);
      currentSubtab = { ...currentSubtab, ...parsed };
    }
  } catch (_) {}
}

function saveInstrumentState() {
  try {
    localStorage.setItem("cv-instrument", currentInstrument);
    localStorage.setItem("cv-subtabs", JSON.stringify(currentSubtab));
  } catch (_) {}
}

function setInstrument(inst) {
  currentInstrument = inst;
  saveInstrumentState();
  updateTabsUI({ animateSubTabs: false });
}

function setSubtab(inst, sub) {
  currentSubtab[inst] = sub;
  saveInstrumentState();
  updateTabsUI({ animateSubTabs: true });
}

function cycleInstrument() {
  const order = ["piano", "guitar", "drums"];
  const idx = order.indexOf(currentInstrument);
  const next = order[(idx + 1) % order.length];
  setInstrument(next);
}

function updateTabsUI(opts = {}) {
  const { animateSubTabs = true } = opts;
  // Instrument tabs aria-selected
  const instTabs = document.querySelectorAll('.instrument-tabs .tab');
  instTabs.forEach(btn => {
    const inst = btn.getAttribute('data-instrument');
    btn.setAttribute('aria-selected', String(inst === currentInstrument));
  });

  // Sub-tabs: show only those matching instrument
  const allSubTabs = document.querySelectorAll('#instrumentSubTabs .tab');
  allSubTabs.forEach(btn => {
    const inst = btn.getAttribute('data-instrument');
    const sub = btn.getAttribute('data-subtab');
    const isVisible = inst === currentInstrument;
    btn.style.display = isVisible ? 'inline-flex' : 'none';
    const selected = currentSubtab[currentInstrument] === sub && isVisible;
    btn.setAttribute('aria-selected', String(selected));
  });

  // Content + control visibility
  const boardsEl = document.getElementById('boards');
  const guitarEl = document.getElementById('guitar');
  const guitarControls = document.getElementById('guitarControls');
  const pianoControls = document.getElementById('pianoChordControls');
  const pianoScaleControls = document.getElementById('pianoScaleControls');
  const drumsControls = document.getElementById('drumsControls');
  const addSectionCta = document.getElementById('addSectionCta');
  const pianoScaleEl = document.getElementById('pianoScale');

  // defaults
  if (boardsEl) boardsEl.style.display = 'none';
  if (guitarEl) guitarEl.style.display = 'none';
  if (guitarControls) guitarControls.style.display = 'none';
  if (pianoControls) pianoControls.style.display = 'none';
  if (pianoScaleControls) pianoScaleControls.style.display = 'none';
  if (drumsControls) drumsControls.style.display = 'none';
  if (handModeToggle) handModeToggle.style.display = 'none';
  if (addSectionCta) addSectionCta.style.display = 'none';
  if (pianoScaleEl) pianoScaleEl.style.display = 'none';

  if (currentInstrument === 'piano') {
    const sub = currentSubtab.piano;
    if (sub === 'chord') {
      if (boardsEl) boardsEl.style.display = 'block';
      if (pianoControls) pianoControls.style.display = 'inline-flex';
      if (handModeToggle) handModeToggle.style.display = 'inline-flex';
      if (addSectionCta) addSectionCta.style.display = 'block';
    } else {
      // Piano → Scales
      if (pianoScaleControls) pianoScaleControls.style.display = 'inline-flex';
      if (pianoScaleEl) {
        pianoScaleEl.style.display = 'block';
        drawPianoScale();
      }
    }
  } else if (currentInstrument === 'guitar') {
    const sub = currentSubtab.guitar;
    if (sub === 'scale') {
      if (guitarControls) guitarControls.style.display = 'inline-flex';
      if (guitarEl) guitarEl.style.display = 'block';
    } else {
      // Guitar → Chord (placeholder)
      if (guitarEl) guitarEl.style.display = 'none';
    }
  } else if (currentInstrument === 'drums') {
    if (drumsControls) drumsControls.style.display = 'inline-flex';
  }

  // Move the animated highlights
  positionSegmentedHighlight(document.querySelector('.instrument-tabs.segmented'), true);
  positionSegmentedHighlight(document.getElementById('instrumentSubTabs'), animateSubTabs);
}

document.addEventListener('DOMContentLoaded', () => {
  loadInstrumentState();

  // Click handlers: instrument tabs
  document.querySelectorAll('.instrument-tabs .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      setInstrument(btn.getAttribute('data-instrument'));
    });
  });

  // Click handlers: sub-tabs
  document.querySelectorAll('#instrumentSubTabs .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const inst = btn.getAttribute('data-instrument');
      const sub = btn.getAttribute('data-subtab');
      setInstrument(inst); // ensure instrument context
      setSubtab(inst, sub);
    });
  });

  // Keyboard support for tabs (Left/Right)
  const instContainer = document.querySelector('.instrument-tabs');
  if (instContainer) {
    instContainer.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const order = ['piano','guitar','drums'];
      const idx = order.indexOf(currentInstrument);
      const next = e.key === 'ArrowRight' ? (idx + 1) % order.length : (idx - 1 + order.length) % order.length;
      setInstrument(order[next]);
      const btn = document.querySelector(`.instrument-tabs .tab[data-instrument="${order[next]}"]`);
      if (btn) btn.focus();
    });
  }
  const subContainer = document.getElementById('instrumentSubTabs');
  if (subContainer) {
    subContainer.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const visible = Array.from(subContainer.querySelectorAll('.tab'))
        .filter(b => b.style.display !== 'none' && b.getAttribute('data-instrument') === currentInstrument);
      const idx = visible.findIndex(b => b.getAttribute('aria-selected') === 'true');
      if (idx === -1) return;
      const next = e.key === 'ArrowRight' ? (idx + 1) % visible.length : (idx - 1 + visible.length) % visible.length;
      const nextBtn = visible[next];
      setSubtab(currentInstrument, nextBtn.getAttribute('data-subtab'));
      nextBtn.focus();
    });
  }

  updateTabsUI({ animateSubTabs: false });
  // Initial highlight positioning after layout/paint
  setTimeout(() => {
    positionSegmentedHighlight(document.querySelector('.instrument-tabs.segmented'), false);
    positionSegmentedHighlight(document.getElementById('instrumentSubTabs'), false);
  }, 0);
  window.addEventListener('resize', () => {
    positionSegmentedHighlight(document.querySelector('.instrument-tabs.segmented'), false);
    positionSegmentedHighlight(document.getElementById('instrumentSubTabs'), false);
  });
  const instTabsEl = document.querySelector('.instrument-tabs.segmented');
  const subTabsEl = document.getElementById('instrumentSubTabs');
  if (instTabsEl) instTabsEl.addEventListener('scroll', () => positionSegmentedHighlight(instTabsEl, false));
  if (subTabsEl) subTabsEl.addEventListener('scroll', () => positionSegmentedHighlight(subTabsEl, false));

  // Piano scale controls
  const pianoKeySel = document.getElementById('pianoScaleKey');
  const pianoModeSel = document.getElementById('pianoScaleMode');
  const pianoUpdateBtn = document.getElementById('updatePianoScale');
  if (pianoKeySel && pianoModeSel) {
    pianoKeySel.addEventListener('change', () => drawPianoScale());
    pianoModeSel.addEventListener('change', () => drawPianoScale());
  }
  if (pianoUpdateBtn) pianoUpdateBtn.addEventListener('click', () => drawPianoScale());
});

// Highlight animation helper for segmented tabs
function positionSegmentedHighlight(container, animate = true) {
  if (!container) return;
  const highlight = container.querySelector('.segmented-highlight');
  if (!highlight) return;
  const tabs = Array.from(container.querySelectorAll('.tab'));
  // pick visible tab with aria-selected = true
  const target = tabs.find(btn => btn.getAttribute('aria-selected') === 'true' && btn.style.display !== 'none');
  if (!target) { highlight.style.width = '0px'; return; }
  const left = target.offsetLeft - container.scrollLeft; // absolute pos inside container
  const width = target.offsetWidth;
  // toggle transition
  if (!animate) {
    const prev = highlight.style.transition;
    highlight.style.transition = 'none';
    // set position
    highlight.style.width = width + 'px';
    highlight.style.left = left + 'px';
    // force reflow then restore transition for future animations
    void highlight.offsetWidth;
    highlight.style.transition = prev || '';
  } else {
    highlight.style.width = width + 'px';
    highlight.style.left = left + 'px';
  }
}

// Initialize transpose display
updateTransposeUI();

// Initial load: restore sections then render
loadSections();
// render sections layout (not the old single-card render)
renderSections();

// Drums placeholder controls
document.addEventListener('DOMContentLoaded', () => {
  const playBtn = document.getElementById('drumsPlayStop');
  const clearBtn = document.getElementById('drumsClear');
  const tempoDown = document.getElementById('tempoDown');
  const tempoUp = document.getElementById('tempoUp');
  const tempoVal = document.getElementById('tempoValue');
  let tempo = 120;
  if (tempoVal) tempo = Number(tempoVal.textContent || '120') || 120;

  if (playBtn) playBtn.addEventListener('click', () => {
    const pressed = playBtn.getAttribute('aria-pressed') === 'true';
    const next = !pressed;
    playBtn.setAttribute('aria-pressed', String(next));
    playBtn.textContent = next ? 'Stop' : 'Play';
  });
  if (clearBtn) clearBtn.addEventListener('click', () => {
    // Placeholder – integrate with drum grid when available
    console.log('Drums cleared');
  });
  if (tempoDown) tempoDown.addEventListener('click', () => {
    tempo = Math.max(20, tempo - 5);
    if (tempoVal) tempoVal.textContent = String(tempo);
  });
  if (tempoUp) tempoUp.addEventListener('click', () => {
    tempo = Math.min(260, tempo + 5);
    if (tempoVal) tempoVal.textContent = String(tempo);
  });
});

// Draw a two-octave piano with scale tones highlighted (one-hand)
function drawPianoScale() {
  const el = document.getElementById('pianoScale');
  const keySel = document.getElementById('pianoScaleKey');
  const modeSel = document.getElementById('pianoScaleMode');
  if (!el || !keySel || !modeSel) return;

  const root = keySel.value;
  const mode = modeSel.value;
  const intervals = SCALE_FORMULAS_PIANO[mode] || SCALE_FORMULAS_PIANO.major;

  const { low: LOW, high: HIGH } = getPianoRange(false); // 2 octaves
  const rootIdx = nameToIndex(root);
  if (rootIdx < 0) return;

  // Find the lowest root within range
  let rootMidiInRange = null;
  for (let m = LOW; m <= HIGH; m++) {
    if (m % 12 === rootIdx) { rootMidiInRange = m; break; }
  }
  if (rootMidiInRange === null) rootMidiInRange = 60 + rootIdx; // fallback

  const inScale = new Set(intervals.map(x => ((x % 12) + 12) % 12));
  const midis = [];
  for (let m = LOW; m <= HIGH; m++) {
    const deg = (m % 12 - rootIdx + 12) % 12;
    if (inScale.has(deg)) midis.push(m);
  }

  const chordLike = { notes: midis, rootMidi: rootMidiInRange };
  el.innerHTML = '';
  el.appendChild(makePiano(chordLike, { twoHands: false }));
}
