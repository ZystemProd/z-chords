document.addEventListener("DOMContentLoaded", () => {
  const sectionModal = document.getElementById("sectionModal");
  const closeSectionModal = document.getElementById("closeSectionModal");
  const sectionNameInput = document.getElementById("sectionNameInput");
  const saveSectionBtn = document.getElementById("saveSectionBtn");
  const addSectionBtn = document.getElementById("addSectionBtn");

  addSectionBtn.addEventListener("click", () => {
    sectionModal.style.display = "block";
    sectionNameInput.focus();
  });

  closeSectionModal.addEventListener("click", () => {
    sectionModal.style.display = "none";
  });

  // Click save
  saveSectionBtn.addEventListener("click", () => {
    saveSection();
  });

  // Press Enter inside input
  sectionNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault(); // prevent form submit / accidental line breaks
      saveSection();
    }
  });

  function saveSection() {
    const name = sectionNameInput.value.trim();
    if (name) {
      addSection(name); // your existing function
      sectionModal.style.display = "none";
      sectionNameInput.value = "";
    }
  }
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

// Make preview mode default
boardsEl.classList.add("preview");

function render() {
  boardsEl.innerHTML = "";
  const chordsList = boardsEl.dataset.chordsList
    ? JSON.parse(boardsEl.dataset.chordsList)
    : [];

  if (!chordsList.length) {
    const card = document.createElement("div");
    card.className = "card preview";
    card.innerHTML = "<h3>No chords added</h3>";
    boardsEl.appendChild(card);
    return;
  }

  chordsList.forEach((chord, index) => {
    const { sym, inversion = 0, octave = false, customMIDIs } = chord;
    const parsed = parseChordSymbol(sym);

    const card = document.createElement("div");
    card.className = "card preview";
    card.innerHTML = `<h3>${sym}</h3>`;

    let chordData;
    if (customMIDIs) {
      chordData = {
        notes: applyInversionToMIDIs(customMIDIs, inversion),
        rootMidi: customMIDIs[0],
      };
    } else if (parsed) {
      chordData = buildChordNotes(
        parsed.root,
        parsed.quality,
        inversion,
        octave
      );
      if (!chordData) {
        card.innerHTML += "<div>Unsupported chord</div>";
        boardsEl.appendChild(card);
        return;
      }
    } else {
      card.innerHTML += "<div>Unrecognized chord symbol</div>";
      boardsEl.appendChild(card);
      return;
    }

    // Render piano
    const piano = makePiano(chordData);
    card.appendChild(piano);

    // --- INVERSION CONTROLS ---
    const invWrap = document.createElement("div");
    invWrap.className = "inversion-control";

    const leftBtn = document.createElement("button");
    leftBtn.innerHTML = "&#8592;"; // ←
    const label = document.createElement("span");
    label.className = "inv-label";
    label.textContent = "inv.";
    const rightBtn = document.createElement("button");
    rightBtn.innerHTML = "&#8594;"; // →

    leftBtn.addEventListener("click", () => {
      const totalNotes = chord.customMIDIs
        ? chord.customMIDIs.length
        : chordData.notes.length;
      chord.inversion = (chord.inversion - 1 + totalNotes) % totalNotes;
      updatePreviewChord(card, chord);
    });

    rightBtn.addEventListener("click", () => {
      const totalNotes = chord.customMIDIs
        ? chord.customMIDIs.length
        : chordData.notes.length;
      chord.inversion = (chord.inversion + 1) % totalNotes;
      updatePreviewChord(card, chord);
    });

    invWrap.appendChild(leftBtn);
    invWrap.appendChild(label);
    invWrap.appendChild(rightBtn);
    card.appendChild(invWrap);

    // --- REMOVE BUTTON ---
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "X";
    removeBtn.className = "remove-chord";
    removeBtn.addEventListener("click", () => {
      chordsList.splice(index, 1);
      boardsEl.dataset.chordsList = JSON.stringify(chordsList);
      render();
    });
    card.appendChild(removeBtn);

    boardsEl.appendChild(card);
  });
}

// Always render preview mode
render();

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

  chords.forEach((c) => {
    sections[sections.length - 1].chords.push({ sym: c, inversion: 0 });
  });

  boardsEl.dataset.sections = JSON.stringify(sections);
  renderSections();
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
  let sections = JSON.parse(boardsEl.dataset.sections || "[]");

  sections.forEach((section) => {
    section.chords.forEach((ch) => {
      // Standard chords
      if (!ch.customMIDIs) {
        const parsed = parseChordSymbol(ch.sym);
        if (parsed) {
          let rootIdx = nameToIndex(parsed.root);
          if (rootIdx >= 0) {
            rootIdx = (rootIdx + amount + 12) % 12;
            const newRoot = N_SHARP[rootIdx];
            ch.sym = newRoot + (parsed.quality || "");
          }
        }
      }

      // Custom chords
      if (ch.customMIDIs) {
        ch.customMIDIs = ch.customMIDIs.map((m) => m + amount); // shift MIDI numbers
        if (ch.rootMidi !== undefined && ch.rootMidi !== null) {
          ch.rootMidi += amount;
        }
      }
    });
  });

  boardsEl.dataset.sections = JSON.stringify(sections);
  renderSections();
}

document
  .getElementById("transposeUp")
  .addEventListener("click", () => transposeChords(1));
document
  .getElementById("transposeDown")
  .addEventListener("click", () => transposeChords(-1));

chordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault(); // stop form submission or focus jumps
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

document.addEventListener("DOMContentLoaded", () => {
  const customModal = document.getElementById("customChordModal");
  const openModalBtn = document.getElementById("openCustomChordModal");
  const closeModalBtn = document.getElementById("closeModal");

  if (!openModalBtn) return; // safety check

  openModalBtn.addEventListener("click", () => {
    customModal.style.display = "block";
    renderCustomPiano();
    selectedMIDIs.clear();
    customChordNameInput.value = "";
    suggestedEl.innerHTML = "";
  });

  closeModalBtn.addEventListener("click", () => {
    customModal.style.display = "none";
  });

  window.addEventListener("click", (e) => {
    if (e.target === customModal) customModal.style.display = "none";
  });
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

  // --- ADD TO CURRENT SECTION ---
  let sections = JSON.parse(boardsEl.dataset.sections || "[]");

  // If no sections exist, create one
  if (sections.length === 0) {
    sections.push({ name: "Default", chords: [] });
  }

  // Add to the **last section** (or you can define an active section index)
  sections[sections.length - 1].chords.push(chordObj);

  boardsEl.dataset.sections = JSON.stringify(sections);

  // Re-render
  renderSections();

  // Close modal
  customModal.style.display = "none";
  selectedMIDIs.clear();
  rootMID = null;
  customChordNameInput.value = "";
  suggestedEl.innerHTML = "";
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
    const parsed = parseChordSymbol(chord.sym);
    chordData = buildChordNotes(
      parsed.root,
      parsed.quality,
      chord.inversion,
      chord.octave
    );
  }

  // Rebuild piano
  const newPiano = makePiano(chordData);

  // Insert new piano above inversion controls
  const invWrap = card.querySelector(".inversion-control");
  card.insertBefore(newPiano, invWrap);
}

function renderSections() {
  boardsEl.innerHTML = "";
  const sections = JSON.parse(boardsEl.dataset.sections || "[]");

  if (!sections.length) {
    boardsEl.innerHTML = "<p>No sections yet</p>";
    return;
  }

  sections.forEach((section, sectionIndex) => {
    const sectionEl = document.createElement("div");
    sectionEl.className = "section";

    const header = document.createElement("h2");
    header.textContent = section.name;
    sectionEl.appendChild(header);

    const chordsContainer = document.createElement("div");
    chordsContainer.className = "chords-container";
    chordsContainer.dataset.sectionIndex = sectionIndex;

    section.chords.forEach((chord, chordIndex) => {
      const card = document.createElement("div");
      card.className = "card preview";
      card.dataset.chordIndex = chordIndex;
      card.innerHTML = `<h3>${chord.sym}</h3>`;

      // Build chord data
      let chordData;
      if (chord.customMIDIs) {
        chordData = {
          notes: applyInversionToMIDIs(chord.customMIDIs, chord.inversion),
          rootMidi: chord.rootMidi ?? chord.customMIDIs[0],
        };
      } else {
        const parsed = parseChordSymbol(chord.sym);
        chordData = parsed
          ? buildChordNotes(parsed.root, parsed.quality, chord.inversion)
          : null;
      }

      if (chordData) {
        const piano = makePiano(chordData);
        card.appendChild(piano);
      }

      // --- REMOVE BUTTON ---
      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-chord-section";
      removeBtn.textContent = "×"; // top-right cross
      removeBtn.addEventListener("click", () => {
        sections[sectionIndex].chords.splice(chordIndex, 1);
        boardsEl.dataset.sections = JSON.stringify(sections);
        renderSections();
      });
      card.appendChild(removeBtn);

      // Append first so it can be positioned with CSS
      card.appendChild(removeBtn);

      // --- INVERSION CONTROLS ---
      const invWrap = document.createElement("div");
      invWrap.className = "inversion-control";

      const leftBtn = document.createElement("button");
      leftBtn.innerHTML = "&#8592;"; // ←
      const label = document.createElement("span");
      label.className = "inv-label";
      label.textContent = "inv.";
      const rightBtn = document.createElement("button");
      rightBtn.innerHTML = "&#8594;"; // →

      leftBtn.addEventListener("click", () => {
        const totalNotes = chord.customMIDIs
          ? chord.customMIDIs.length
          : chordData.notes.length;
        chord.inversion = (chord.inversion - 1 + totalNotes) % totalNotes;
        updatePreviewChord(card, chord);
      });

      rightBtn.addEventListener("click", () => {
        const totalNotes = chord.customMIDIs
          ? chord.customMIDIs.length
          : chordData.notes.length;
        chord.inversion = (chord.inversion + 1) % totalNotes;
        updatePreviewChord(card, chord);
      });

      invWrap.appendChild(leftBtn);
      invWrap.appendChild(label);
      invWrap.appendChild(rightBtn);
      card.appendChild(invWrap);

      chordsContainer.appendChild(card);
    });

    sectionEl.appendChild(chordsContainer);
    boardsEl.appendChild(sectionEl);
  });

  enableDragAndDrop();
}

function addSection(name) {
  const sections = JSON.parse(boardsEl.dataset.sections || "[]");
  sections.push({ name: name || `Section ${sections.length + 1}`, chords: [] });
  boardsEl.dataset.sections = JSON.stringify(sections);
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
  const chord = chordInput.value.trim();
  if (!chord) return;

  // Load current sections
  let sections = JSON.parse(boardsEl.dataset.sections || "[]");

  // Create a default section if none exist
  if (!sections.length) {
    addSection("Default");
    sections = JSON.parse(boardsEl.dataset.sections || "[]"); // reload
  }

  // Add chord to first section
  sections[0].chords.push({ sym: chord, inversion: 0 });
  boardsEl.dataset.sections = JSON.stringify(sections);

  renderSections();
  chordInput.value = "";
});

document.getElementById("clearAll").addEventListener("click", () => {
  boardsEl.dataset.chordsList = JSON.stringify([]);
  render();
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

// render sections layout (not the old single-card render)
renderSections();
