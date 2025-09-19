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
  "": [0, 4, 7],
  m: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  6: [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  add9: [0, 4, 7, 14],
  9: [0, 4, 7, 10, 14],
  m9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
};
const CHORD_TYPES = Object.keys(CHORD_PATTERNS).filter((k) => k !== "");
const typesSorted = CHORD_TYPES.slice().sort((a, b) => b.length - a.length);
const TYPE_RE = typesSorted.join("|");
const CHORD_RE = new RegExp(
  "^[ ]*([A-Ga-g])([#b]?)(?:(" + TYPE_RE + "))?[ ]*$"
);

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

  // keep interval metadata so we can correctly label 9 (14 semitones) etc
  let notes = pattern.map((interval) => ({
    midi: origRootMidi + interval,
    interval,
  }));

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

const boardsEl = document.getElementById("boards");

function makePiano(chord) {
  const midiNotes = chord.notes;
  const rootMidi = chord.rootMidi; // always the original root
  const LOW = 60,
    HIGH = 83;

  // Map intervals relative to original root
  const intervals = midiNotes.map((m) => {
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

  const whiteMIDIs = [];
  for (let m = LOW; m <= HIGH; m++) {
    if (!N_SHARP[m % 12].includes("#")) whiteMIDIs.push(m);
  }

  const pianoWrap = document.createElement("div");
  pianoWrap.className = "piano";

  const whiteGrid = document.createElement("div");
  whiteGrid.className = "white-keys";

  whiteMIDIs.forEach((midi) => {
    const wk = document.createElement("div");
    wk.className = "white-key";
    wk.dataset.midi = midi;

    // Highlight only the original root
    if (midi === rootMidi) wk.classList.add("root");

    const nm = N_SHARP[midi % 12];
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = nm.replace("#", "♯");
    wk.appendChild(label);

    const idx = midiNotes.indexOf(midi);
    if (idx >= 0) {
      const interval = document.createElement("div");
      interval.className = "interval";
      interval.textContent = intervals[idx];
      wk.appendChild(interval);
      wk.classList.add("pressed");
    }

    whiteGrid.appendChild(wk);
  });

  pianoWrap.appendChild(whiteGrid);

  requestAnimationFrame(() => {
    const whiteEls = whiteGrid.querySelectorAll(".white-key");
    whiteEls.forEach((wk) => {
      const midi = parseInt(wk.dataset.midi);
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

      // Highlight only the original root
      if (blackMidi === rootMidi) bk.classList.add("root");

      const idx = midiNotes.indexOf(blackMidi);
      if (idx >= 0) {
        const interval = document.createElement("div");
        interval.className = "interval";
        interval.textContent = intervals[idx];
        bk.appendChild(interval);
        bk.classList.add("pressed");
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

function render() {
  boardsEl.innerHTML = "";
  const chordsList = boardsEl.dataset.chordsList
    ? JSON.parse(boardsEl.dataset.chordsList)
    : [];

  if (!chordsList.length) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      '<h3>No chords added</h3><div class="note-list">Type a chord above and click "Add chord".</div>';
    boardsEl.appendChild(card);
    return;
  }

  chordsList.forEach((chord) => {
    const { sym, inversion = 0, octave = false, customMIDIs } = chord;
    const parsed = parseChordSymbol(sym);

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = "<h3>" + sym + "</h3>";

    let chordData;
    let maxInv = 0;
    let currentInv = inversion;

    // Handle custom chords
    if (customMIDIs) {
      const rootMidi = chord.rootMidi ?? customMIDIs[0];
      chordData = {
        notes: customMIDIs.slice(), // preserve user order
        rootMidi,
      };
    }
    // Handle normal chords
    else if (parsed) {
      chordData = buildChordNotes(
        parsed.root,
        parsed.quality,
        inversion,
        octave
      );
      if (!chordData) {
        card.innerHTML +=
          '<div class="note-list">Unsupported chord quality.</div>';
        boardsEl.appendChild(card);
        return;
      }
      maxInv = Math.max(0, chordData.notes.length - 1);
      currentInv = inversion;
    } else {
      card.innerHTML +=
        '<div class="note-list">Unrecognized chord symbol.</div>';
      boardsEl.appendChild(card);
      return;
    }

    // Display note names
    const midiNotes = chordData.notes;
    const noteNames = midiNotes.map((m) => getName(m)).join(" · ");
    let labelText = "Notes (inversion " + currentInv + ")";
    if (octave) labelText += ", Octave +1";
    card.innerHTML +=
      '<div class="note-list">' + labelText + ": " + noteNames + "</div>";

    // Render piano
    const piano = makePiano(chordData);
    card.appendChild(piano);

    // Only add inversion controls for non-custom chords
    if (!customMIDIs) {
      const invWrap = document.createElement("div");
      invWrap.className = "inversion-control";

      const minusBtn = document.createElement("button");
      minusBtn.textContent = "-";
      minusBtn.style.width = "24px";
      minusBtn.style.marginRight = "4px";

      const invLabel = document.createElement("span");
      invLabel.textContent = "Inv " + currentInv;
      invLabel.style.margin = "0 6px";

      const plusBtn = document.createElement("button");
      plusBtn.textContent = "+";
      plusBtn.style.width = "24px";
      plusBtn.style.marginLeft = "4px";

      minusBtn.addEventListener("click", () => {
        let newInv = currentInv - 1;
        if (newInv < 0) newInv = maxInv;
        chord.inversion = newInv;
        chord.octave = false;
        boardsEl.dataset.chordsList = JSON.stringify(chordsList);
        render();
      });

      plusBtn.addEventListener("click", () => {
        let newInv = currentInv + 1;
        if (newInv > maxInv) newInv = 0;
        chord.inversion = newInv;
        chord.octave = false;
        boardsEl.dataset.chordsList = JSON.stringify(chordsList);
        render();
      });

      invWrap.appendChild(minusBtn);
      invWrap.appendChild(invLabel);
      invWrap.appendChild(plusBtn);
      card.appendChild(invWrap);
    }

    boardsEl.appendChild(card);
  });
}

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
  chords.forEach((c) => addChordToList(c));
}

const chordInput = document.getElementById("chordInput");
const suggestionsEl = document.getElementById("suggestions");

chordInput.addEventListener("input", () => {
  const val = chordInput.value.trim().toUpperCase();
  suggestionsEl.innerHTML = "";
  if (!val) return;

  const matches = [];
  N_SHARP.forEach((note) => {
    CHORD_TYPES.forEach((type) => {
      const chord = note + type;
      if (chord.toUpperCase().startsWith(val)) matches.push(chord);
    });
  });

  matches.slice(0, 10).forEach((chord) => {
    const option = document.createElement("option");
    option.value = chord;
    suggestionsEl.appendChild(option);
  });
});

function transposeChords(amount) {
  const chords = boardsEl.dataset.chordsList
    ? JSON.parse(boardsEl.dataset.chordsList)
    : [];
  chords.forEach((ch) => {
    const parsed = parseChordSymbol(ch.sym);
    if (!parsed) return;

    let rootIdx = nameToIndex(parsed.root);
    if (rootIdx < 0) return;

    rootIdx = (rootIdx + amount + 12) % 12;
    const newRoot = N_SHARP[rootIdx];
    ch.sym = newRoot + (parsed.quality || "");
  });
  boardsEl.dataset.chordsList = JSON.stringify(chords);
  render();
}

document
  .getElementById("transposeUp")
  .addEventListener("click", () => transposeChords(1));
document
  .getElementById("transposeDown")
  .addEventListener("click", () => transposeChords(-1));

chordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    addChordsFromInput(chordInput.value);
    chordInput.value = "";
    suggestionsEl.innerHTML = "";
  }
});

function updateSuggestions() {
  suggestedEl.innerHTML = "";

  if (selectedMIDIs.size < 2) return; // need at least 2 notes for a suggestion

  // Convert selected MIDIs to pitch classes
  const pcs = Array.from(selectedMIDIs)
    .map((m) => m % 12)
    .sort((a, b) => a - b);

  // Find matching chords
  const matches = [];
  for (const [type, pattern] of Object.entries(CHORD_PATTERNS)) {
    for (let root = 0; root < 12; root++) {
      const chordPCs = pattern
        .map((interval) => (root + interval) % 12)
        .sort((a, b) => a - b);
      if (pcs.every((pc) => chordPCs.includes(pc))) {
        matches.push(N_SHARP[root] + (type || ""));
      }
    }
  }

  if (matches.length === 0) {
    suggestedEl.textContent = "No matching chord found";
    suggestedEl.classList.remove("clickable-suggestion");
  } else {
    matches.forEach((match) => {
      const btn = document.createElement("div");
      btn.className = "clickable-suggestion";
      btn.textContent = match;
      btn.addEventListener("click", () => {
        customChordNameInput.value = match; // put text into input
      });
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

let selectedMIDIs = new Set();

// Open modal
openModalBtn.addEventListener("click", () => {
  customModal.style.display = "block";
  renderCustomPiano();
  selectedMIDIs.clear();
  customChordNameInput.value = "";
  suggestedEl.innerHTML = "";
});

// Close modal
closeModalBtn.addEventListener(
  "click",
  () => (customModal.style.display = "none")
);
window.addEventListener("click", (e) => {
  if (e.target === customModal) customModal.style.display = "none";
});

// Tracks the current root and previous root element
let rootMID = null; // tracks the chosen root

function renderCustomPiano() {
  customPianoEl.innerHTML = "";
  const LOW = 60,
    HIGH = 83;
  const whiteMIDIs = [];
  for (let m = LOW; m <= HIGH; m++)
    if (!N_SHARP[m % 12].includes("#")) whiteMIDIs.push(m);

  const pianoWrap = document.createElement("div");
  pianoWrap.className = "piano";
  const whiteGrid = document.createElement("div");
  whiteGrid.className = "white-keys";

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
    if (selectedMIDIs.has(midi)) wk.classList.add("pressed");
    if (rootMID === midi) wk.classList.add("root");

    // Only show "R" on marked keys (selected or root)
    if (selectedMIDIs.has(midi) || rootMID === midi) {
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

      if (selectedMIDIs.has(blackMidi)) bk.classList.add("pressed");
      if (rootMID === blackMidi) bk.classList.add("root");

      if (selectedMIDIs.has(blackMidi) || rootMID === blackMidi) {
        const rootLabel = document.createElement("div");
        rootLabel.className = "root-label";
        rootLabel.textContent = "R";

        if (rootMID === blackMidi) rootLabel.classList.add("active");

        rootLabel.addEventListener("click", (e) => {
          e.stopPropagation();
          rootMID = blackMidi;
          renderCustomPiano();
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

function toggleKey(midi, el) {
  if (selectedMIDIs.has(midi)) {
    selectedMIDIs.delete(midi);
    if (rootMID === midi) rootMID = null;
    el.classList.remove("selected");
  } else {
    selectedMIDIs.add(midi);
    el.classList.add("selected");
  }
  renderCustomPiano();
  updateSuggestions();
}

addCustomChordBtn.addEventListener("click", () => {
  if (selectedMIDIs.size === 0) return;

  let name = customChordNameInput.value.trim();
  if (!name)
    name =
      suggestedEl.textContent.split(":")[1]?.split(",")[0]?.trim() ||
      "CustomChord";

  const midiArray = Array.from(selectedMIDIs).sort((a, b) => a - b);

  // Ensure chosen root is first
  if (rootMID !== null) {
    const idx = midiArray.indexOf(rootMID);
    if (idx > 0) {
      midiArray.splice(idx, 1);
      midiArray.unshift(rootMID);
    }
  }

  const chordObj = {
    sym: name,
    inversion: 0,
    octave: false,
    customMIDIs: midiArray,
    rootMidi: rootMID,
  };

  const list = boardsEl.dataset.chordsList
    ? JSON.parse(boardsEl.dataset.chordsList)
    : [];
  list.push(chordObj);
  boardsEl.dataset.chordsList = JSON.stringify(list);

  render();
  customModal.style.display = "none";
  selectedMIDIs.clear();
  rootMID = null;
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

addCustomChordBtn.addEventListener("click", () => {
  if (selectedMIDIs.size === 0) return; // nothing selected

  // Get a name from the input or generate one from suggestions
  let name = customChordNameInput.value.trim();
  if (!name) {
    name =
      suggestedEl.textContent.split(":")[1]?.split(",")[0]?.trim() ||
      "CustomChord";
  }

  // Convert selected MIDIs to a sorted array
  const midiArray = Array.from(selectedMIDIs).sort((a, b) => a - b);

  // Build a chord object compatible with your boardsEl list
  const chordObj = {
    sym: name,
    inversion: 0,
    octave: false,
    customMIDIs: midiArray, // store the actual MIDI notes for this custom chord
  };

  // Add to the existing chords list
  const list = boardsEl.dataset.chordsList
    ? JSON.parse(boardsEl.dataset.chordsList)
    : [];
  list.push(chordObj);
  boardsEl.dataset.chordsList = JSON.stringify(list);

  // Re-render
  render();

  // Close modal
  customModal.style.display = "none";
});

function applyInversionToMIDIs(midiArray, inversion) {
  if (!midiArray || midiArray.length === 0) return [];
  const notes = midiArray.slice(); // copy array
  for (let i = 0; i < inversion; i++) {
    notes.push(notes.shift() + 12); // move lowest note up an octave
  }
  return notes; // keep ascending order destroyed to preserve inversion
}

document.getElementById("addChord").addEventListener("click", () => {
  addChordsFromInput(chordInput.value);
  chordInput.value = "";
});

document.getElementById("clearAll").addEventListener("click", () => {
  boardsEl.dataset.chordsList = JSON.stringify([]);
  render();
});

render();
