import {
  NOTES,
  CHORD_PATTERNS,
  CHORD_TYPES,
  CHORD_RE,
  SCALE_FORMULAS,
  normalizeRoot,
  noteIndex,
} from "./theory.js";
import { playNotes, getAudioContext } from "./audio.js";
import {
  getVoicingsForChord,
  getVoicingsForPitchClasses,
  renderChordDiagram,
  voicingChart,
  voicingFromFrets,
  createChordEditor,
  OPEN_MIDI,
} from "./guitar-chords.js";
import {
  initLayout,
  refreshLayout,
  layoutForSongFile,
  applyLayoutFromSongFile,
} from "./layout.js";
import {
  initMelodyPanel,
  showMelodyPanel,
  hideMelodyPanel,
} from "./melody-panel.js";

let sectionCounter = 0; // track part number
let activeSectionIndex = null; // which section receives new chords
let twoHandsMode = localStorage.getItem("cv-twohands") === "true"; // track hand mode, persisted
let transposeOffset = 0; // current transpose amount shown in UI
// Each instrument's board is transposed on its own, so the readout is too.
const transposeOffsets = { piano: 0, guitar: 0 };
// Capo position for the guitar chord tab, persisted. It is a label only: the
// diagrams stay at concert pitch, and the value is printed on the PDF export.
const MAX_CAPO_FRET = 12;
let capoFret = (() => {
  const n = parseInt(localStorage.getItem("cv-capo") || "0", 10);
  return Number.isFinite(n) ? Math.min(MAX_CAPO_FRET, Math.max(0, n)) : 0;
})();

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
        saveActiveSection();
        document
          .querySelectorAll("#boards .section.active")
          .forEach((el) => el.classList.remove("active"));
      }
    },
    true
  );
});

function parseChordSymbol(sym) {
  const m = sym.match(CHORD_RE);
  if (!m) return null;
  return {
    root: normalizeRoot(m[1].toUpperCase() + (m[2] || "")),
    quality: m[3] || "",
  };
}
function buildChordNotes(rootName, quality, inversion = 0, octave = false) {
  const rootIdx = noteIndex(rootName);
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
  return NOTES[midi % 12].replace("#", "♯");
}

// Black key geometry, as fractions of a white key's width. Both are the former
// hardcoded pixel values over the former fixed 36px white key, so a keyboard at
// the default size is pixel-identical to before — but now it scales.
const BLACK_KEY_WIDTH_RATIO = 20 / 36;
const BLACK_KEY_OFFSET_RATIO = 4 / 36;

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
  const bassIdx = noteIndex(bassName);
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
const songTitleEl = document.getElementById("songTitle");
const songSubtitleEl = document.getElementById("songSubtitle");

// Persistence helpers
//
// Piano→chord and guitar→chord draw the same kind of board but hold *separate*
// songs: editing a chord, its inversion, or a guitar shape on one tab must not
// reach across to the other. So `boardsEl.dataset.sections` is only ever the
// board of whichever instrument is on screen, and each instrument's copy is
// stored under its own key. `setInstrument` flushes the outgoing board and
// swaps the incoming one in.
const BOARD_INSTRUMENTS = ["piano", "guitar"];

// Drums has no board; it keeps the piano copy loaded so switching back is a
// no-op and nothing can be saved to a board that isn't there.
function boardInstrument() {
  return currentInstrument === "guitar" ? "guitar" : "piano";
}

function sectionsKey(inst) {
  return `cv-sections-${inst}`;
}

function activeSectionKey(inst) {
  return `cv-active-section-${inst}`;
}

// The song's title and subtitle belong to the board, not to the app: the piano
// and guitar tabs hold separate songs, so they hold separate titles too. They
// live in their own keys rather than inside the sections JSON, which is an
// array of sections with nowhere to put them.
function titleKey(inst) {
  return `cv-title-${inst}`;
}

function subtitleKey(inst) {
  return `cv-subtitle-${inst}`;
}

// Melodies are board content, like sections: written on the instrument's own
// melody sub-tab, referenced by the layout sheet, and carried into song files
// by readBoardState/writeBoardState the same way everything else on a board is.
//
// They get their own key rather than a slot in the sections JSON, for the same
// reason the title does — that JSON is an array of sections with nowhere to put
// anything else. And unlike sections they are NOT mirrored into
// `boardsEl.dataset`, because `#boards` is the chord board; the melody panel is
// a separate view with its own state.
function melodiesKey(inst) {
  return `cv-melodies-${inst}`;
}

function readMelodies(inst) {
  let parsed = [];
  try {
    parsed = JSON.parse(localStorage.getItem(melodiesKey(inst)) || "[]");
  } catch (_) {}
  return Array.isArray(parsed) ? parsed : [];
}

function writeMelodies(inst, list) {
  try {
    localStorage.setItem(
      melodiesKey(inst),
      JSON.stringify(Array.isArray(list) ? list : [])
    );
  } catch (_) {}
}

function saveSongMeta() {
  const inst = boardInstrument();
  try {
    localStorage.setItem(titleKey(inst), songTitleEl ? songTitleEl.value : "");
    localStorage.setItem(
      subtitleKey(inst),
      songSubtitleEl ? songSubtitleEl.value : ""
    );
  } catch (_) {}
}

function loadSongMeta() {
  const inst = boardInstrument();
  let title = "";
  let subtitle = "";
  try {
    title = localStorage.getItem(titleKey(inst)) || "";
    subtitle = localStorage.getItem(subtitleKey(inst)) || "";
  } catch (_) {}
  if (songTitleEl) songTitleEl.value = title;
  if (songSubtitleEl) songSubtitleEl.value = subtitle;
}

// Typing a title mutates no section, so it never reaches saveSections().
if (songTitleEl) songTitleEl.addEventListener("input", saveSongMeta);
if (songSubtitleEl) songSubtitleEl.addEventListener("input", saveSongMeta);

// Songs saved before the split were one shared board — seed both copies from it
// so neither tab loses its chords, then drop the old keys.
function migrateSharedSections() {
  try {
    const legacy = localStorage.getItem("cv-sections");
    if (legacy === null) return;
    const legacyActive = localStorage.getItem("cv-active-section");
    BOARD_INSTRUMENTS.forEach((inst) => {
      if (localStorage.getItem(sectionsKey(inst)) === null) {
        localStorage.setItem(sectionsKey(inst), legacy);
        if (legacyActive !== null)
          localStorage.setItem(activeSectionKey(inst), legacyActive);
      }
    });
    localStorage.removeItem("cv-sections");
    localStorage.removeItem("cv-active-section");
  } catch (_) {}
}

// ---- Stable ids for sections and chords ----
//
// Sections and chords have always been addressed by array index, which is fine
// while the board is the only consumer: it re-renders from scratch every time.
// Anything that wants to *point at* a chord from outside the board — the layout
// sheet does — cannot use an index, because dragging a section reorders them all
// and every reference would silently repoint at different music.
//
// So each section and chord carries an `id`, minted lazily. This is additive:
// nothing else reads the field, the PDF path never sees it, and a board saved by
// an older build simply gets ids the first time this build loads it.
function mintId(prefix) {
  let rand = "";
  try {
    rand = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  } catch (_) {
    // Older browsers, and any non-secure context, have no randomUUID.
    rand = Math.random().toString(36).slice(2, 12);
  }
  return `${prefix}_${rand}`;
}

// Returns true when it actually stamped something, so callers know whether the
// dataset needs re-stringifying. Mutates in place.
function ensureIds(sections) {
  let changed = false;
  if (!Array.isArray(sections)) return false;
  sections.forEach((section) => {
    if (!section || typeof section !== "object") return;
    if (!section.id) {
      section.id = mintId("s");
      changed = true;
    }
    if (!Array.isArray(section.chords)) return;
    section.chords.forEach((chord) => {
      if (!chord || typeof chord !== "object") return;
      if (!chord.id) {
        chord.id = mintId("c");
        changed = true;
      }
    });
  });
  return changed;
}

function saveActiveSection() {
  const key = activeSectionKey(boardInstrument());
  try {
    if (activeSectionIndex === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(activeSectionIndex));
  } catch (_) {}
}

function saveSections() {
  try {
    localStorage.setItem(
      sectionsKey(boardInstrument()),
      boardsEl.dataset.sections || "[]"
    );
  } catch (_) {}
  saveActiveSection();
  saveSongMeta();
}

function loadSections() {
  migrateSharedSections();
  loadSongMeta();
  const inst = boardInstrument();
  let saved = null;
  let savedActive = null;
  try {
    saved = localStorage.getItem(sectionsKey(inst));
    savedActive = localStorage.getItem(activeSectionKey(inst));
  } catch (_) {}

  boardsEl.dataset.sections = saved || "[]";
  const idx = savedActive === null ? NaN : Number(savedActive);
  activeSectionIndex = Number.isNaN(idx) ? null : idx;

  // Section names run Part A, Part B, … so the counter has to pick up where
  // this board left off rather than restarting at A.
  let count = 0;
  try {
    const parsed = JSON.parse(boardsEl.dataset.sections || "[]");
    // Stamp ids on anything saved before ids existed, before any consumer can
    // read the board and find a section it cannot name.
    if (ensureIds(parsed)) boardsEl.dataset.sections = JSON.stringify(parsed);
    count = parsed.length;
  } catch (_) {
    boardsEl.dataset.sections = "[]";
  }
  sectionCounter = count;
  transposeOffset = transposeOffsets[inst] || 0;
  updateTransposeUI();
}

// Song files
//
// A song is both boards at once: the piano tab and the guitar tab hold separate
// chords, titles and transpose offsets, and a file that carried only the tab you
// happened to be looking at would quietly lose the other half. So the file is
// the whole app state that belongs to the song — every board, plus the capo
// label, which is a property of the arrangement rather than of the view.
//
// Everything lives in localStorage under per-instrument keys, so save flushes
// the on-screen board first and then reads the same keys `loadSections` reads;
// load writes those keys and re-enters `loadSections`. Nothing here knows the
// shape of a section or a chord, which is what keeps it working when they change.
const SONG_FILE_FORMAT = "z-chords-song";
// v2 adds the layout sheet. Both directions stay compatible: a v1 file simply
// has no `layout` key, and a v2 file opened by an older build drops the sheet
// but keeps every chord — which is why the sheet is a sibling of `boards`
// rather than something buried inside one of them.
const SONG_FILE_VERSION = 2;

function readBoardState(inst) {
  let sections = "[]";
  let active = null;
  let title = "";
  let subtitle = "";
  try {
    sections = localStorage.getItem(sectionsKey(inst)) || "[]";
    active = localStorage.getItem(activeSectionKey(inst));
    title = localStorage.getItem(titleKey(inst)) || "";
    subtitle = localStorage.getItem(subtitleKey(inst)) || "";
  } catch (_) {}
  let parsed = [];
  try {
    parsed = JSON.parse(sections);
  } catch (_) {}
  const activeIdx = active === null ? null : Number(active);
  return {
    title,
    subtitle,
    sections: Array.isArray(parsed) ? parsed : [],
    melodies: readMelodies(inst),
    activeSection: Number.isFinite(activeIdx) ? activeIdx : null,
    transpose: transposeOffsets[inst] || 0,
  };
}

function writeBoardState(inst, board) {
  const data = board && typeof board === "object" ? board : {};
  const sections = Array.isArray(data.sections) ? data.sections : [];
  try {
    localStorage.setItem(sectionsKey(inst), JSON.stringify(sections));
    const active = Number(data.activeSection);
    if (data.activeSection === null || !Number.isFinite(active))
      localStorage.removeItem(activeSectionKey(inst));
    else localStorage.setItem(activeSectionKey(inst), String(active));
    localStorage.setItem(titleKey(inst), String(data.title || ""));
    localStorage.setItem(subtitleKey(inst), String(data.subtitle || ""));
  } catch (_) {}
  // A v1 song file has no melodies at all. Writing `[]` for it would wipe the
  // melodies already on the board, so absence means "leave them alone" — the
  // same rule applyLayoutFromSongFile uses for a missing sheet.
  if (Array.isArray(data.melodies)) writeMelodies(inst, data.melodies);
  const transpose = Number(data.transpose);
  transposeOffsets[inst] = Number.isFinite(transpose) ? transpose : 0;
}

function buildSongFile() {
  // Flush the board on screen: its edits live in the dataset until saved.
  saveSections();
  const boards = {};
  BOARD_INSTRUMENTS.forEach((inst) => {
    boards[inst] = readBoardState(inst);
  });
  // The drums board holds beats and nothing else — no chords, no title, no
  // transpose — so it is written as a melodies-only board rather than pushed
  // through BOARD_INSTRUMENTS, which would also seed it with chord-board keys
  // (and hand `migrateSharedSections` a third board to copy legacy chords into).
  boards.drums = { melodies: readMelodies("drums") };
  const song = {
    format: SONG_FILE_FORMAT,
    version: SONG_FILE_VERSION,
    savedAt: new Date().toISOString(),
    capo: capoFret,
    boards,
  };
  const layout = layoutForSongFile();
  if (layout) song.layout = layout;
  return song;
}

// A filename from the song's own title, falling back so a save never fails for
// want of a name. Windows and POSIX both choke on the same handful of chars.
function songFileName(song) {
  const title =
    (song.boards.piano && song.boards.piano.title) ||
    (song.boards.guitar && song.boards.guitar.title) ||
    "";
  const safe = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `${safe || "chord-viewer-song"}.json`;
}

function saveSongToFile() {
  const song = buildSongFile();
  const blob = new Blob([JSON.stringify(song, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = songFileName(song);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can beat the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function songHasChords(song) {
  return BOARD_INSTRUMENTS.some((inst) => {
    const board = song.boards && song.boards[inst];
    return (
      board &&
      Array.isArray(board.sections) &&
      board.sections.some((s) => s && Array.isArray(s.chords) && s.chords.length)
    );
  });
}

function applySongFile(song) {
  if (!song || typeof song !== "object" || !song.boards)
    throw new Error("Not a Chord Viewer song file.");
  if (song.format && song.format !== SONG_FILE_FORMAT)
    throw new Error("Not a Chord Viewer song file.");

  BOARD_INSTRUMENTS.forEach((inst) => writeBoardState(inst, song.boards[inst]));
  // Same rule as melodies inside a chord board: a file without drums leaves the
  // beats alone rather than clearing them, so loading a song saved before beats
  // existed does not wipe them.
  const drums = song.boards.drums;
  if (drums && Array.isArray(drums.melodies)) writeMelodies("drums", drums.melodies);
  const capo = Number(song.capo);
  if (Number.isFinite(capo)) setCapo(capo);

  // Re-enter the normal load path so the on-screen board, its title, its
  // transpose readout and the section counter all come from the same place
  // they always do.
  loadSections();
  renderSections();

  // After the boards, so the sheet's references resolve against the chords the
  // file just brought in rather than the ones that were there before.
  applyLayoutFromSongFile(song.layout);
}

function loadSongFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let song;
    try {
      song = JSON.parse(String(reader.result));
    } catch (_) {
      alert("That file isn't valid JSON.");
      return;
    }
    try {
      if (songHasChords(buildSongFile())) {
        const ok = confirm(
          "Loading this song replaces the chords on both the piano and guitar tabs. Continue?"
        );
        if (!ok) return;
      }
      applySongFile(song);
    } catch (err) {
      alert(err && err.message ? err.message : "Could not load that song.");
    }
  };
  reader.onerror = () => alert("Could not read that file.");
  reader.readAsText(file);
}

const saveSongBtn = document.getElementById("saveSong");
const loadSongBtn = document.getElementById("loadSong");
const loadSongInput = document.getElementById("loadSongInput");
if (saveSongBtn) saveSongBtn.addEventListener("click", saveSongToFile);
if (loadSongBtn && loadSongInput) {
  loadSongBtn.addEventListener("click", () => loadSongInput.click());
  loadSongInput.addEventListener("change", () => {
    const file = loadSongInput.files && loadSongInput.files[0];
    // Clear it either way, so picking the same file twice still fires `change`.
    if (file) loadSongFromFile(file);
    loadSongInput.value = "";
  });
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
    if (!NOTES[m % 12].includes("#")) whiteMIDIs.push(m);
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

    const nm = NOTES[midi % 12];
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
    // Black keys are absolutely positioned, and their containing block is the
    // piano's padding box — not the keybed. Percentages must resolve against
    // that same box, or every key is displaced by the ratio between the two and
    // the error grows across the keyboard.
    const basisPx = pianoWrap.clientWidth;

    whiteEls.forEach((wk) => {
      const midi = parseInt(wk.dataset.midi, 10);
      const note = NOTES[midi % 12];
      if (note === "E" || note === "B") return;

      const blackMidi = midi + 1;
      const bk = document.createElement("div");
      bk.className = "black-key";
      bk.dataset.midi = blackMidi;

      const whiteWidthPx = wk.offsetWidth;
      // Which white key this one hangs off, recorded so the geometry can be
      // recomputed later against a different layout — see positionBlackKeys.
      bk.dataset.anchorMidi = String(midi);
      // A black key's size and position are proportions of a white key, not
      // fixed pixels. They used to be: the width came from CSS as a flat 20px
      // and never changed, so once a keybed was narrower than the default the
      // black keys were wider than the white keys between them. The ratios here
      // are the old constants divided by the old 36px white key, so a keyboard
      // at the default width renders exactly as it always did.
      //
      // (The old code also read `bk.offsetWidth` before the element was in the
      // DOM, so the centring term was always 0 — that is folded into the
      // offset ratio below rather than "fixed", to keep the look unchanged.)
      const blackWidthPx = whiteWidthPx * BLACK_KEY_WIDTH_RATIO;
      const leftPx =
        wk.offsetLeft + whiteWidthPx + whiteWidthPx * BLACK_KEY_OFFSET_RATIO;

      if (basisPx > 0) {
        // Percentages rather than pixels, so a keyboard stays correct if its
        // container is resized without being rebuilt.
        bk.style.left = `${(leftPx / basisPx) * 100}%`;
        bk.style.width = `${(blackWidthPx / basisPx) * 100}%`;
      } else {
        // Bed not laid out (a board built while its tab is hidden). Fall back to
        // pixels; whatever renders it will be rebuilt when the tab is shown.
        bk.style.left = `${leftPx}px`;
      }

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

// Re-place the black keys of an already-built piano against its CURRENT layout.
//
// makePiano measures white keys inside a requestAnimationFrame, which reports
// zero for a board built while its tab is hidden — every black key then lands at
// left:0, stacked at the edge of the keybed. makePiano tolerates that because a
// hidden board is rebuilt when its tab is shown, but the PDF export clones the
// board WITHOUT it ever being shown, so that assumption does not hold there and
// the sheet printed a row of collapsed keyboards. Splitting the geometry out
// means the export can fix the clone once it has a real width, rather than
// makePiano having to guess one.
function positionBlackKeys(pianoWrap) {
  if (!pianoWrap) return;
  const basisPx = pianoWrap.clientWidth;
  if (!(basisPx > 0)) return;

  pianoWrap.querySelectorAll(".black-key").forEach((bk) => {
    const anchorMidi = bk.dataset.anchorMidi;
    if (anchorMidi == null) return;
    const wk = pianoWrap.querySelector(`.white-key[data-midi="${anchorMidi}"]`);
    if (!wk) return;
    const whiteWidthPx = wk.offsetWidth;
    if (!(whiteWidthPx > 0)) return;

    const blackWidthPx = whiteWidthPx * BLACK_KEY_WIDTH_RATIO;
    const leftPx =
      wk.offsetLeft + whiteWidthPx + whiteWidthPx * BLACK_KEY_OFFSET_RATIO;
    bk.style.left = `${(leftPx / basisPx) * 100}%`;
    bk.style.width = `${(blackWidthPx / basisPx) * 100}%`;
  });
}

function getName(midi) {
  const note = NOTES[midi % 12];
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
  const inputWrap = document.querySelector(".input-with-action");
  if (!inputWrap) return;

  const RADIUS = 140; // px
  let rafId = 0;
  let pendingX = 0;
  let pendingY = 0;

  function setGlowVisible(visible) {
    // keep size constant for smoother fade; only animate opacity
    inputWrap.style.setProperty("--glow-opacity", visible ? "1" : "0");
  }

  const flushGlowPosition = () => {
    rafId = 0;
    inputWrap.style.setProperty("--glow-x", `${pendingX}px`);
    inputWrap.style.setProperty("--glow-y", `${pendingY}px`);
  };

  inputWrap.addEventListener("pointerenter", () => setGlowVisible(true));
  inputWrap.addEventListener("pointerleave", () => {
    setGlowVisible(false);
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  });
  inputWrap.addEventListener("pointermove", (e) => {
    const rect = inputWrap.getBoundingClientRect();
    pendingX = e.clientX - rect.left;
    pendingY = e.clientY - rect.top;
    if (!rafId) rafId = requestAnimationFrame(flushGlowPosition);
  });

  // initialize hidden and set base size/color
  inputWrap.style.setProperty("--glow-size", `${RADIUS}px`);
  if (!getComputedStyle(inputWrap).getPropertyValue("--glow-color")) {
    inputWrap.style.setProperty("--glow-color", "rgba(30,110,240,0.55)");
  }
  setGlowVisible(false);
})();
const suggestionsEl = document.getElementById("suggestions"); // legacy datalist (unused for UI)
const inputSuggestions = document.getElementById("inputSuggestions");
const handModeToggle = document.getElementById("handModeToggle");
const transposeValueEl = document.getElementById("transposeValue");

const capoValueEl = document.getElementById("capoValue");

function updateTransposeUI() {
  if (transposeValueEl) transposeValueEl.textContent = String(transposeOffset);
}

// "None" rather than "0" so the control reads as a capo position and not as
// another offset sitting next to Transpose.
function updateCapoUI() {
  if (capoValueEl) capoValueEl.textContent = capoFret > 0 ? String(capoFret) : "None";
}

function setCapo(fret) {
  capoFret = Math.min(MAX_CAPO_FRET, Math.max(0, fret));
  try {
    localStorage.setItem("cv-capo", String(capoFret));
  } catch (_) {}
  updateCapoUI();
}

// The label the export prints, and the empty string when there is nothing to say.
function capoLabel() {
  return capoFret > 0 ? `Capo ${capoFret}` : "";
}

function buildInputMatches(val) {
  const matches = [];
  if (!val) return matches;
  const u = val.toUpperCase();
  NOTES.forEach((note) => {
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
          let rootIdx = noteIndex(parsed.root);
          if (rootIdx >= 0) {
            rootIdx = (rootIdx + amount + 12) % 12;
            const newRoot = NOTES[rootIdx];
            let updated = newRoot + (parsed.quality || "");

            if (bass) {
              const bassIdxOrig = noteIndex(normalizeRoot(bass));
              if (bassIdxOrig >= 0) {
                const bassIdx = (bassIdxOrig + amount + 12) % 12;
                const newBass = NOTES[bassIdx];
                updated += `/${newBass}`;
              }
            }

            ch.sym = updated;
          }
        }
      }

      // Custom chords
      if (Array.isArray(ch.guitarFrets)) {
        // Every string's pitch is open + fret, so adding the same amount to
        // each fret transposes the shape, open strings included. Shapes that
        // would fall off either end of the neck lose the override and go back
        // to the library instead of being silently mangled.
        const moved = ch.guitarFrets.map((f) => (f === null ? null : f + amount));
        const played = moved.filter((f) => f !== null);
        if (played.length && played.every((f) => f >= 0 && f <= 22)) {
          ch.guitarFrets = moved;
          if (Array.isArray(ch.guitarBarres)) {
            // A bar sits at a fret, so it moves with the shape or it ends up
            // drawn across a row that no longer holds those notes.
            ch.guitarBarres = ch.guitarBarres.map((b) => ({
              ...b,
              fret: b.fret + amount,
            }));
          }
        } else {
          delete ch.guitarFrets;
          delete ch.guitarBarres;
        }
      }

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

function bumpTranspose(amount) {
  transposeOffset += amount;
  transposeOffsets[boardInstrument()] = transposeOffset;
  updateTransposeUI();
  transposeChords(amount);
}

document.getElementById("transposeUp").addEventListener("click", () => {
  bumpTranspose(1);
});
document.getElementById("transposeDown").addEventListener("click", () => {
  bumpTranspose(-1);
});

document.getElementById("capoUp").addEventListener("click", () => setCapo(capoFret + 1));
document.getElementById("capoDown").addEventListener("click", () => setCapo(capoFret - 1));
updateCapoUI();

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
    renderSections(); // owns the two-hands-mode class, piano only
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
          const rootName = NOTES[rootPC];
          matches.push(rootName + (type || ""));
        }
      } else {
        // Partial match if no root is selected (don't multiply suggestions)
        if (selectedPCs.every((pc) => chordPCs.includes(pc))) {
          const rootName = NOTES[rootPC];
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

// --- Guitar chord editor (the modal's fretboard, in place of the piano) -----

const customGuitarEl = document.getElementById("customGuitar");
const customGuitarBoxEl = document.getElementById("customGuitarBox");
const guitarEditorPosEl = document.getElementById("guitarEditorPos");
let guitarEditor = null; // handle from createChordEditor while the modal is open

function editingGuitar() {
  return currentInstrument === "guitar";
}

// Sensible starting window: low enough to show the nut unless the shape lives
// up the neck, matching how the read-only diagrams choose theirs.
function baseFretFor(frets) {
  const fretted = frets.filter((f) => typeof f === "number" && f > 0);
  if (!fretted.length) return 1;
  if (frets.some((f) => f === 0) || Math.max(...fretted) <= 4) return 1;
  return Math.min(...fretted);
}

function syncGuitarEditorPos() {
  if (guitarEditorPosEl && guitarEditor) {
    guitarEditorPosEl.textContent = String(guitarEditor.getBaseFret());
  }
}

// Mounts the fretboard editor for `frets` and keeps the name suggestions in
// step with whatever is currently fretted.
function mountGuitarEditor(frets, barres) {
  if (!customGuitarBoxEl) return;
  customGuitarBoxEl.innerHTML = "";
  guitarEditor = createChordEditor({
    frets: frets,
    barres: barres,
    baseFret: baseFretFor(frets),
    onChange: (next) => {
      // Suggestions read the same selection the piano path uses, so the
      // "Chord Name" hints work identically on both instruments.
      selectedMIDIs = new Set(guitarEditorMidis(next));
      rootMID = selectedMIDIs.size ? Math.min(...selectedMIDIs) : null;
      updateSuggestions();
    },
  });
  customGuitarBoxEl.appendChild(guitarEditor.svg);
  syncGuitarEditorPos();
  selectedMIDIs = new Set(guitarEditorMidis(frets));
  rootMID = selectedMIDIs.size ? Math.min(...selectedMIDIs) : null;
}

function guitarEditorMidis(frets) {
  const out = [];
  frets.forEach((f, s) => {
    if (typeof f === "number") out.push(OPEN_MIDI[s] + f);
  });
  return out.sort((a, b) => a - b);
}

// Position stepper and Clear, which only exist for the fretboard.
document.addEventListener("DOMContentLoaded", () => {
  const down = document.getElementById("guitarEditorPosDown");
  const up = document.getElementById("guitarEditorPosUp");
  const clear = document.getElementById("guitarEditorClear");

  const move = (delta) => () => {
    if (!guitarEditor) return;
    guitarEditor.setBaseFret(guitarEditor.getBaseFret() + delta);
    syncGuitarEditorPos();
  };
  if (down) down.addEventListener("click", move(-1));
  if (up) up.addEventListener("click", move(1));

  if (clear) {
    clear.addEventListener("click", () => {
      if (!guitarEditor) return;
      guitarEditor.setFrets([null, null, null, null, null, null], []);
      selectedMIDIs = new Set();
      rootMID = null;
      updateSuggestions();
    });
  }
});

// Swaps the modal between the piano and the fretboard.
function showModalInstrument() {
  const guitar = editingGuitar();
  if (customPianoEl) customPianoEl.style.display = guitar ? "none" : "";
  if (customGuitarEl) customGuitarEl.style.display = guitar ? "block" : "none";
  const handToggle = document.getElementById("handToggle");
  if (handToggle) handToggle.style.display = guitar ? "none" : "";
}

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
  showModalInstrument();
  if (editingGuitar()) {
    mountGuitarEditor([null, null, null, null, null, null]);
  } else {
    renderCustomPiano();
  }
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
let prevRootEl = null; // label element of the currently marked root

function renderCustomPiano() {
  customPianoEl.innerHTML = "";
  // Use 3-octave range and two-hands layout for custom modal
  const { low: LOW, high: HIGH } = getPianoRange(true);
  const whiteMIDIs = [];
  for (let m = LOW; m <= HIGH; m++)
    if (!NOTES[m % 12].includes("#")) whiteMIDIs.push(m);

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
    label.textContent = NOTES[midi % 12].replace("#", "♯");
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
      if (["E", "B"].includes(NOTES[midi % 12])) return;

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
  if (customGuitarBoxEl) customGuitarBoxEl.innerHTML = "";
  guitarEditor = null;
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
  // On the guitar tab the notes come from the fretboard rather than the piano.
  const drawnFrets = editingGuitar() && guitarEditor ? guitarEditor.getFrets() : null;
  if (drawnFrets) {
    selectedMIDIs = new Set(guitarEditorMidis(drawnFrets));
    selectedLeftMIDIs = new Set();
    rootMID = selectedMIDIs.size ? Math.min(...selectedMIDIs) : null;
  }

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

  // Keep the exact fingering, not just the notes. Two shapes can sound the
  // same set of pitches and only one of them is the one that was drawn.
  if (drawnFrets) {
    chordObj.guitarFrets = drawnFrets;
    // Which dots are one barred finger cannot be read back off the frets, so
    // the bars the player drew are stored rather than re-guessed.
    chordObj.guitarBarres = guitarEditor.getBarres();
  }

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

// Resolve a stored chord into its sounding notes. A chord is either a parsed
// symbol or a fully custom voicing; `customMIDIs` means "use these verbatim".
// Rendering and playback both go through here so what you hear cannot drift
// from what is drawn.
function computeChordData(chord) {
  if (chord.customMIDIs) {
    // Apply inversion for custom chords
    const notes = applyInversionToMIDIs(chord.customMIDIs, chord.inversion);
    return {
      notes,
      rootMidi: notes[0], // choose lowest note as root
    };
  }
  // Standard chord
  const { main } = splitChordParts(chord.sym);
  const parsed = parseChordSymbol(main);
  return parsed
    ? buildChordNotes(parsed.root, parsed.quality, chord.inversion, chord.octave)
    : null;
}

// Every MIDI note a card is currently showing, left hand included when
// two-hands mode is on. Recomputed at call time rather than captured, so
// changing the inversion is reflected on the next play.
function getChordPlaybackMIDIs(chord) {
  // On the guitar tab, play the shape actually being shown - a barre chord in
  // its real register, not an abstract root-position voicing.
  if (currentInstrument === "guitar") {
    const voicing = getActiveVoicing(chord);
    return voicing ? voicing.midis.slice() : [];
  }

  const chordData = computeChordData(chord);
  if (!chordData || !Array.isArray(chordData.notes)) return [];

  const midis = chordData.notes.slice();

  if (twoHandsMode) {
    if (Array.isArray(chord.leftHandMIDIs) && chord.leftHandMIDIs.length) {
      midis.push(...chord.leftHandMIDIs);
    } else {
      const lh = computeLeftHandInfo(chord, chordData, twoHandsMode);
      if (lh && Array.isArray(lh.leftHandMIDIs)) midis.push(...lh.leftHandMIDIs);
      else if (lh && typeof lh.midi === "number") midis.push(lh.midi);
    }
  }

  // Sorted low to high: playNotes staggers voices by a few ms in array order,
  // so this makes the chord roll up from the bass the way a hand strikes it.
  return Array.from(new Set(midis.filter((m) => typeof m === "number"))).sort(
    (a, b) => a - b
  );
}

function updatePreviewChord(card, chord) {
  // Remove old piano
  const oldPiano = card.querySelector(".piano");
  if (oldPiano) oldPiano.remove();

  const chordData = computeChordData(chord);

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
  showModalInstrument();
  if (editingGuitar()) {
    // Seed from the shape the card is showing, so editing starts from what
    // the player is looking at rather than from an empty board.
    const shown = getActiveVoicing(ch);
    mountGuitarEditor(
      shown ? shown.frets : [null, null, null, null, null, null],
      shown ? shown.barres : []
    );
  } else {
    renderCustomPiano();
  }
  updateSuggestions();
}

// --- Guitar chord cards ----------------------------------------------------

// Playable shapes for a stored chord. Custom chords carry raw MIDI rather than
// a parseable symbol, so they go through the pitch-class search instead.
function getGuitarVoicings(chord) {
  // A hand-drawn shape is exactly what the player asked for, so it is shown
  // verbatim rather than re-derived from its pitch classes -- the search would
  // otherwise be free to return a different fingering of the same notes.
  if (Array.isArray(chord.guitarFrets) && chord.guitarFrets.some((f) => f !== null)) {
    const drawn = voicingFromFrets(chord.guitarFrets, chord.guitarBarres);
    if (drawn) return [drawn];
  }
  if (Array.isArray(chord.customMIDIs) && chord.customMIDIs.length) {
    const bass =
      typeof chord.rootMidi === "number" ? chord.rootMidi : chord.customMIDIs[0];
    return getVoicingsForPitchClasses(bass, chord.customMIDIs);
  }
  const { main } = splitChordParts(chord.sym);
  const parsed = parseChordSymbol(main);
  if (!parsed) return [];
  return getVoicingsForChord(parsed.root, parsed.quality);
}

// Which shape the card is currently showing. Stored on the chord as
// guitarShape so it persists with the rest of the board.
function getActiveVoicing(chord) {
  const voicings = getGuitarVoicings(chord);
  if (!voicings.length) return null;
  const n = voicings.length;
  return voicings[(((chord.guitarShape || 0) % n) + n) % n];
}

// Card body for the guitar tab: a chord box plus a stepper through the other
// playable positions. The section, drag, play, edit and remove machinery is
// shared with the piano tab.
// `interactive: false` builds the same diagram without the shape stepper, for
// consumers that render a chord as a static picture (the layout sheet). The
// stepper is the only part that writes back to the board, so dropping it is
// also what makes such a card read-only by construction.
function buildGuitarCardBody(card, chord, sections, opts = {}) {
  const { interactive = true } = opts;
  const voicings = getGuitarVoicings(chord);

  const body = document.createElement("div");
  body.className = "guitar-chord-body";

  if (!voicings.length) {
    const empty = document.createElement("div");
    empty.className = "gc-empty";
    empty.textContent = "No playable shape";
    body.appendChild(empty);
    card.appendChild(body);
    return;
  }

  const n = voicings.length;
  let idx = (((chord.guitarShape || 0) % n) + n) % n;

  const host = document.createElement("div");
  host.className = "gc-host";

  if (!interactive) {
    const v = voicings[idx];
    host.appendChild(
      renderChordDiagram(v, {
        ariaLabel: `${chord.sym}, ${voicingChart(v.frets)}`,
      })
    );
    body.appendChild(host);
    card.appendChild(body);
    return;
  }

  const stepper = document.createElement("div");
  stepper.className = "inversion-control gc-shape-control";

  const prev = document.createElement("button");
  prev.className = "no-drag";
  prev.type = "button";
  prev.setAttribute("aria-label", "Previous shape");
  prev.innerHTML = "&#8592;";

  const count = document.createElement("span");
  count.className = "inv-label";

  const next = document.createElement("button");
  next.className = "no-drag";
  next.type = "button";
  next.setAttribute("aria-label", "Next shape");
  next.innerHTML = "&#8594;";

  const draw = () => {
    const v = voicings[idx];
    host.innerHTML = "";
    host.appendChild(
      renderChordDiagram(v, {
        ariaLabel: `${chord.sym}, shape ${idx + 1} of ${n}, ${voicingChart(v.frets)}`,
      })
    );
    count.textContent = `${idx + 1}/${n}`;
  };

  const step = (delta) => (e) => {
    e.stopPropagation();
    idx = (((idx + delta) % n) + n) % n;
    chord.guitarShape = idx;
    boardsEl.dataset.sections = JSON.stringify(sections);
    saveSections();
    draw();
  };
  prev.addEventListener("click", step(-1));
  next.addEventListener("click", step(1));

  stepper.appendChild(prev);
  stepper.appendChild(count);
  stepper.appendChild(next);

  body.appendChild(host);
  body.appendChild(stepper);
  card.appendChild(body);
  draw();
}

// Card body for the piano tab: the keyboard, the inversion stepper and the
// left-hand controls. Split out of renderSections so the guitar tab can
// substitute its own body without the two instruments tangling.
function buildPianoCardBody(card, chord, sections, opts = {}) {
  const { interactive = true } = opts;
  // --- Build chord piano ---
  const chordData = computeChordData(chord);

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

  // A static card: the keyboard alone, in the same wrapper the interactive one
  // uses so it inherits identical `.preview` sizing. The inversion and
  // left-hand steppers are omitted rather than hidden — `.card.preview` hides
  // them with `opacity: 0`, which still reserves their height and would leave a
  // gap under every block on a printed sheet.
  if (!interactive) {
    const lpw = document.createElement("div");
    lpw.className = "lh-piano-wrap";
    const scroller = document.createElement("div");
    scroller.className = "piano-scroll";
    if (builtPiano) scroller.appendChild(builtPiano);
    lpw.appendChild(scroller);
    card.appendChild(lpw);
    return;
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
}

// One chord card. `renderSections` builds the interactive version for the
// board; the layout sheet builds the static one, and both go through here so a
// printed card can never drift from the on-screen card it came from.
//
// The interactive path needs the board context its buttons write back into
// (`sections`, `section`, `sectionIndex`, `chordIndex`); the static path needs
// none of it and must not be given any, because a card that cannot reach the
// board cannot corrupt it.
function buildCardElement(chord, opts = {}) {
  const {
    instrument = currentInstrument,
    interactive = true,
    sections = null,
    section = null,
    sectionIndex = 0,
    chordIndex = 0,
  } = opts;

  const card = document.createElement("div");
  card.className = "card preview";
  if (interactive) card.dataset.chordIndex = chordIndex;
  card.innerHTML = `<h3>${formatChordSymbol(chord.sym)}</h3>`;

  // Card body differs per instrument; everything around it (sections,
  // drag and drop, play, edit, remove) is shared.
  if (instrument === "guitar") {
    buildGuitarCardBody(card, chord, sections, { interactive });
  } else {
    buildPianoCardBody(card, chord, sections, { interactive });
  }

  if (!interactive) return card;

  // --- Play chord button ---
  // `no-drag` keeps SortableJS from starting a drag on it (see the
  // filter on the chords-container instance) and stops the section
  // click handler treating a press as a section selection.
  const playBtn = document.createElement("button");
  playBtn.className = "play-chord-section no-drag";
  playBtn.type = "button";
  playBtn.title = "Play this chord";
  // chord.sym, not formatChordSymbol(): the latter returns <sup> markup,
  // which a screen reader would read out as literal tag text.
  playBtn.setAttribute("aria-label", `Play ${chord.sym}`);
  playBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M4 9.5v5h3.6L12 18V6L7.6 9.5H4z" fill="currentColor"/>
      <path d="M15.5 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor"
            stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;
  playBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const midis = getChordPlaybackMIDIs(chord);
    if (!midis.length) return;
    playNotes(midis);
    card.classList.add("playing");
    clearTimeout(card._playPulse);
    card._playPulse = setTimeout(() => card.classList.remove("playing"), 320);
  });

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

  card.appendChild(playBtn);
  card.appendChild(editBtn);
  card.appendChild(removeBtn);
  return card;
}

function renderSections() {
  // Two-hands is a piano-only layout: it widens the cards and drops the chord
  // grid to one column. Guitar cards keep their own columns regardless.
  boardsEl.classList.toggle(
    "two-hands-mode",
    twoHandsMode && currentInstrument === "piano"
  );
  boardsEl.innerHTML = "";
  const sections = JSON.parse(boardsEl.dataset.sections || "[]");

  // Every mutation path funnels through here and then re-persists, so this is
  // the one place that has to mint ids for freshly added sections and chords.
  if (ensureIds(sections)) boardsEl.dataset.sections = JSON.stringify(sections);

  // Persist and toggle empty state
  saveSections();
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

    // Page-break-before-section toggle (PDF export only; default off)
    const pageBreakLabel = document.createElement("label");
    pageBreakLabel.className = "section-page-break no-drag";
    pageBreakLabel.title = "Start this section on a new page when exporting to PDF";
    const pageBreakCheckbox = document.createElement("input");
    pageBreakCheckbox.type = "checkbox";
    pageBreakCheckbox.className = "no-drag";
    pageBreakCheckbox.checked = !!section.pageBreakBefore;
    pageBreakCheckbox.addEventListener("click", (e) => e.stopPropagation());
    pageBreakCheckbox.addEventListener("change", () => {
      const secs = JSON.parse(boardsEl.dataset.sections || "[]");
      secs[sectionIndex].pageBreakBefore = pageBreakCheckbox.checked;
      boardsEl.dataset.sections = JSON.stringify(secs);
      saveSections();
    });
    pageBreakLabel.appendChild(pageBreakCheckbox);
    pageBreakLabel.appendChild(document.createTextNode("Page break"));

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
        saveActiveSection();
      }
      renderSections();
    });

    headerWrap.appendChild(header);
    headerWrap.appendChild(pageBreakLabel);
    headerWrap.appendChild(removeSectionBtn);
    sectionEl.appendChild(headerWrap);

    // --- Chords container ---
    const chordsContainer = document.createElement("div");
    chordsContainer.className = "chords-container" + (currentInstrument === "guitar" ? " guitar-mode" : "");
    chordsContainer.dataset.sectionIndex = sectionIndex;

    section.chords.forEach((chord, chordIndex) => {
      chordsContainer.appendChild(
        buildCardElement(chord, {
          instrument: currentInstrument,
          interactive: true,
          sections,
          section,
          sectionIndex,
          chordIndex,
        })
      );
    });

    sectionEl.appendChild(chordsContainer);

    // Clicking anywhere in the section (except interactive controls) sets it active
    sectionEl.addEventListener("click", (e) => {
      // ignore clicks on remove/edit buttons and sortable handles
      const t = e.target;
      if (t && (t.closest && (t.closest(".no-drag") || t.closest(".remove-section")))) return;
      activeSectionIndex = sectionIndex;
      saveActiveSection();
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
        saveActiveSection();
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
  saveActiveSection();
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
  // Clears the board of the instrument on screen; the other keeps its song.
  saveSections();
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

// ---- PDF export ----
// A4 portrait, in mm. The preview and the saved file share one layout pass, so
// what the modal shows is what lands in the document.
const PDF_PAGE_W = 210;
const PDF_PAGE_H = 297;
const PDF_MARGIN = 10;
const PDF_HEADING_PT = 12;
const PDF_TITLE_PT = 20;
const PDF_SUBTITLE_PT = 13;
const PT_TO_MM = 25.4 / 72;

// The lines printed above the first section: song title, subtitle, then the
// capo label (guitar only). Each is `{ text, sizePt, bold, gapMm }` — gapMm is
// how far the cursor advances, i.e. the line's height plus its trailing space.
function pdfHeadings() {
  const lines = [];
  const title = songTitleEl ? songTitleEl.value.trim() : "";
  const subtitle = songSubtitleEl ? songSubtitleEl.value.trim() : "";

  if (title) {
    lines.push({
      text: title,
      sizePt: PDF_TITLE_PT,
      bold: true,
      gapMm: PDF_TITLE_PT * PT_TO_MM + 2,
    });
  }
  if (subtitle) {
    lines.push({
      text: subtitle,
      sizePt: PDF_SUBTITLE_PT,
      bold: false,
      gapMm: PDF_SUBTITLE_PT * PT_TO_MM + 2,
    });
  }

  // The capo belongs to the guitar arrangement, so it is only printed when
  // that is what is being exported.
  const capo = currentInstrument === "guitar" ? capoLabel() : "";
  if (capo) {
    lines.push({ text: capo, sizePt: PDF_HEADING_PT, bold: false, gapMm: 8 });
  }

  // Breathing room between the last heading line and the first section.
  if (lines.length) lines[lines.length - 1].gapMm += 3;
  return lines;
}

// Rasterize each section once. Changing the scale re-runs only the layout,
// never html2canvas, which is what keeps the slider responsive.
// The width an element WOULD occupy in its parent, usable while the element
// itself is hidden and measures zero.
function parentContentWidth(el) {
  const parent = el.parentElement;
  if (!parent) return 0;
  const cs = getComputedStyle(parent);
  const w =
    parent.clientWidth -
    (parseFloat(cs.paddingLeft) || 0) -
    (parseFloat(cs.paddingRight) || 0);
  return w > 0 ? w : 0;
}

async function capturePdfSections() {
  const boards = document.querySelector(".boards.preview");
  if (!boards) return [];

  const clone = boards.cloneNode(true);
  clone.classList.add("pdf-capture");
  // `updateTabsUI` hides the board with an INLINE `display:none` on every
  // sub-tab that is not a chord tab, and cloneNode copies inline styles — so
  // capturing from Melody or Scales rasterized a zero-sized element. That is
  // not merely an empty PDF: html2canvas computes the `.card` gradient over a
  // zero-length gradient line, and `addColorStop(NaN)` throws, so the preview
  // died with a console error instead of producing anything.
  //
  // The export is "this instrument's chord board", which exists in state
  // whether or not that tab is on screen, so the fix is to lay the clone out
  // rather than to refuse: forcing display here makes the button behave the
  // same from every sub-tab.
  clone.style.display = "block";

  const hiddenContainer = document.createElement("div");
  hiddenContainer.style.position = "fixed";
  hiddenContainer.style.top = "-9999px";
  hiddenContainer.style.left = "-9999px";
  hiddenContainer.style.opacity = "0";
  // A hidden board measures 0, so the clone has nothing to size itself against
  // and would shrink-wrap to its content at a different width than the chord
  // tab captures at — the same song would export differently depending on which
  // tab you happened to be on. Pin the width to the board's own layout slot,
  // which its parent still has even while the board itself is hidden.
  // `clientWidth` INCLUDES the parent's padding, so using it raw made the
  // hidden-tab capture 40px wider than the chord tab's — the same song
  // exporting at two different widths. Take the parent's content box.
  const slot = boards.offsetWidth || parentContentWidth(boards) || 0;
  if (slot) hiddenContainer.style.width = `${slot}px`;
  hiddenContainer.appendChild(clone);
  document.body.appendChild(hiddenContainer);

  // Now that the clone has a real width, re-place any black keys that were
  // positioned against a hidden (zero-width) board. On the chord tab this is a
  // no-op recomputation; off it, it is the difference between a keyboard and a
  // stack of black keys at the left edge.
  clone.querySelectorAll(".piano").forEach(positionBlackKeys);

  try {
    const sectionData = JSON.parse(boardsEl.dataset.sections || "[]");
    const sectionEls = Array.from(clone.querySelectorAll(".section"));
    const targets = sectionEls.length > 0 ? sectionEls : [clone];
    const captures = [];

    for (const target of targets) {
      const canvas = await html2canvas(target, { scale: 2, useCORS: true });
      const targetRect = target.getBoundingClientRect();
      const captureScale = canvas.width / Math.max(1, targetRect.width);
      const sectionIndex = Number(target.dataset.sectionIndex);

      captures.push({
        canvas,
        dataUrl: canvas.toDataURL("image/png"),
        // Prefer page breaks at the top of a chord card so cards aren't cut in half.
        breakpoints: Array.from(target.querySelectorAll(".card.preview"))
          .map((card) =>
            Math.round(
              (card.getBoundingClientRect().top - targetRect.top) * captureScale
            )
          )
          .filter((y) => y > 0 && y < canvas.height)
          .sort((a, b) => a - b),
        pageBreakBefore: !!(
          sectionData[sectionIndex] && sectionData[sectionIndex].pageBreakBefore
        ),
      });
    }
    return captures;
  } finally {
    document.body.removeChild(hiddenContainer);
  }
}

// Place captures onto pages at `scale` (1 = full content width). Returns pages
// of placements in mm; each is either a text heading or one horizontal band of
// a capture.
function layoutPdfPages(captures, scale, headings) {
  const renderWidth = (PDF_PAGE_W - PDF_MARGIN * 2) * scale;
  const x = (PDF_PAGE_W - renderWidth) / 2;
  const bottom = PDF_PAGE_H - PDF_MARGIN;
  const fullHeight = bottom - PDF_MARGIN;

  const pages = [[]];
  let cursorY = PDF_MARGIN;
  let hasContent = false;

  const newPage = () => {
    pages.push([]);
    cursorY = PDF_MARGIN;
  };

  // Headings are not sections: hasContent stays false, so a first section that
  // forces a break still starts here rather than pushing itself to page two.
  (headings || []).forEach((line) => {
    pages[0].push({
      type: "text",
      text: line.text,
      sizePt: line.sizePt,
      bold: !!line.bold,
      x,
      baselineY: cursorY + line.sizePt * PT_TO_MM,
    });
    cursorY += line.gapMm;
  });

  for (const capture of captures) {
    const { canvas } = capture;
    const pxPerMm = canvas.width / renderWidth;
    const sectionHeight = canvas.height / pxPerMm;

    if (hasContent && capture.pageBreakBefore) newPage();

    // A section that would be split only because of what precedes it moves to
    // the next page whole. Splitting is for sections taller than a page.
    if (
      hasContent &&
      sectionHeight > bottom - cursorY &&
      sectionHeight <= fullHeight
    ) {
      newPage();
    }

    let rendered = 0;
    while (rendered < canvas.height) {
      let availablePx = Math.floor((bottom - cursorY) * pxPerMm);
      if (availablePx <= 0) {
        newPage();
        availablePx = Math.max(1, Math.floor(fullHeight * pxPerMm));
      }

      const remaining = canvas.height - rendered;
      let sliceHeight = Math.min(availablePx, remaining);

      if (remaining > availablePx) {
        const maxBreakY = rendered + availablePx;
        const minBreakY = rendered + Math.max(1, Math.floor(availablePx * 0.4));
        for (let i = capture.breakpoints.length - 1; i >= 0; i -= 1) {
          const y = capture.breakpoints[i];
          if (y <= maxBreakY && y >= minBreakY && y > rendered) {
            sliceHeight = y - rendered;
            break;
          }
        }
      }

      const heightMm = sliceHeight / pxPerMm;
      pages[pages.length - 1].push({
        type: "image",
        capture,
        sourceY: rendered,
        sourceHeight: sliceHeight,
        x,
        y: cursorY,
        width: renderWidth,
        height: heightMm,
      });

      cursorY += heightMm;
      rendered += sliceHeight;
      hasContent = true;

      if (rendered < canvas.height) newPage();
    }
  }

  return pages.filter((page) => page.length > 0);
}

function renderPdfPreview(pages, host) {
  host.innerHTML = "";
  if (!pages.length) {
    host.innerHTML = '<p class="pdf-preview-status">Nothing to export yet.</p>';
    return;
  }

  const pct = (mm, total) => `${(mm / total) * 100}%`;

  pages.forEach((placements, pageIndex) => {
    const wrap = document.createElement("div");
    wrap.className = "pdf-preview-page-wrap";

    const page = document.createElement("div");
    page.className = "pdf-preview-page";

    placements.forEach((p) => {
      if (p.type === "text") {
        const text = document.createElement("div");
        text.className = "pdf-preview-text";
        text.textContent = p.text;
        text.style.left = pct(p.x, PDF_PAGE_W);
        text.style.top = pct(p.baselineY - p.sizePt * PT_TO_MM, PDF_PAGE_H);
        // cqw is a percentage of the page's own width, so the heading keeps its
        // real proportions whatever size the preview page is rendered at.
        text.style.fontSize = `${((p.sizePt * PT_TO_MM) / PDF_PAGE_W) * 100}cqw`;
        text.style.fontWeight = p.bold ? "700" : "400";
        page.appendChild(text);
        return;
      }

      const slice = document.createElement("div");
      slice.className = "pdf-preview-slice";
      slice.style.left = pct(p.x, PDF_PAGE_W);
      slice.style.top = pct(p.y, PDF_PAGE_H);
      slice.style.width = pct(p.width, PDF_PAGE_W);
      slice.style.height = pct(p.height, PDF_PAGE_H);

      // The image spans the slice's width, so shifting it by a fraction of its
      // own height exposes exactly the band this placement covers.
      const img = document.createElement("img");
      img.src = p.capture.dataUrl;
      img.alt = "";
      img.style.transform = `translateY(${
        -(p.sourceY / p.capture.canvas.height) * 100
      }%)`;

      slice.appendChild(img);
      page.appendChild(slice);
    });

    const label = document.createElement("div");
    label.className = "pdf-preview-page-label";
    label.textContent = `Page ${pageIndex + 1}`;

    wrap.appendChild(page);
    wrap.appendChild(label);
    host.appendChild(wrap);
  });
}

function savePdfFromLayout(pages, fileName = "chords.pdf") {
  const pdf = new jspdf.jsPDF("p", "mm", "a4");

  pages.forEach((placements, pageIndex) => {
    if (pageIndex > 0) pdf.addPage();

    placements.forEach((p) => {
      if (p.type === "text") {
        pdf.setFont("helvetica", p.bold ? "bold" : "normal");
        pdf.setFontSize(p.sizePt);
        pdf.text(p.text, p.x, p.baselineY);
        return;
      }

      const { canvas } = p.capture;
      let data = p.capture.dataUrl;

      if (p.sourceY !== 0 || p.sourceHeight !== canvas.height) {
        const sliceCanvas = document.createElement("canvas");
        sliceCanvas.width = canvas.width;
        sliceCanvas.height = p.sourceHeight;
        sliceCanvas
          .getContext("2d")
          .drawImage(
            canvas,
            0,
            p.sourceY,
            canvas.width,
            p.sourceHeight,
            0,
            0,
            canvas.width,
            p.sourceHeight
          );
        data = sliceCanvas.toDataURL("image/png");
      }

      pdf.addImage(data, "PNG", p.x, p.y, p.width, p.height, undefined, "FAST");
    });
  });

  pdf.save(fileName);
}

// ---- PDF preview modal ----
//
// The modal is shared by two producers of pages: the auto-flow export, which
// rasterizes the board and slices it into bands, and the layout sheet, which
// places composed blocks. Both are expressed as the same pair:
//
//   prepare()            -> an opaque context, awaited once per open. The
//                           expensive step (html2canvas) belongs here.
//   layout(ctx, scale)   -> pages of placements. Pure and cheap, so the scale
//                           slider can re-run it on every input event.
//
// That split is the whole reason the slider stays responsive, and keeping it in
// the shared controller means neither producer can accidentally re-rasterize.
let pdfModal = null;

function getPdfPreviewModal() {
  if (pdfModal !== null) return pdfModal || null;

  const modal = document.getElementById("pdfPreviewModal");
  const closeBtn = document.getElementById("closePdfPreview");
  const pagesHost = document.getElementById("pdfPreviewPages");
  const scaleInput = document.getElementById("pdfScale");
  const scaleValue = document.getElementById("pdfScaleValue");
  const scaleReset = document.getElementById("pdfScaleReset");
  const pageCount = document.getElementById("pdfPageCount");
  const exportBtn = document.getElementById("pdfExportConfirm");
  if (!modal || !pagesHost || !scaleInput || !exportBtn) {
    pdfModal = false; // remember the failure; don't re-query on every click
    return null;
  }

  // The session currently on screen. Null when the modal is closed.
  let session = null;
  let token = 0;

  const saveScale = () => {
    if (!session) return;
    try {
      localStorage.setItem(session.scaleKey, scaleInput.value);
    } catch (_) {}
  };

  const relayout = () => {
    const percent = Number(scaleInput.value);
    if (scaleValue) scaleValue.textContent = `${percent}%`;
    if (!session || !session.ctx) return;
    session.pages = session.layout(session.ctx, percent / 100);
    renderPdfPreview(session.pages, pagesHost);
    if (pageCount) {
      pageCount.textContent = `${session.pages.length} page${
        session.pages.length === 1 ? "" : "s"
      }`;
    }
  };

  const close = () => {
    token += 1; // abandon a prepare still in flight
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    pagesHost.innerHTML = "";
    // Drop the captures: each is a full canvas plus a data URL, and a long
    // session would otherwise hold every sheet it ever previewed.
    session = null;
  };

  scaleInput.addEventListener("input", () => {
    saveScale();
    relayout();
  });

  if (scaleReset) {
    scaleReset.addEventListener("click", () => {
      scaleInput.value = "100";
      saveScale();
      relayout();
    });
  }

  exportBtn.addEventListener("click", () => {
    if (session && session.pages && session.pages.length) {
      savePdfFromLayout(session.pages, session.fileName);
    }
  });

  if (closeBtn) closeBtn.addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.style.display === "block") close();
  });

  pdfModal = {
    async open({ prepare, layout, scaleKey, fileName }) {
      session = {
        layout,
        scaleKey: scaleKey || "cv-pdf-scale",
        fileName: fileName || "chords.pdf",
        ctx: null,
        pages: [],
      };

      try {
        const saved = Number(localStorage.getItem(session.scaleKey));
        if (saved >= 40 && saved <= 130) scaleInput.value = String(saved);
      } catch (_) {}

      modal.style.display = "block";
      modal.setAttribute("aria-hidden", "false");
      if (scaleValue) scaleValue.textContent = `${Number(scaleInput.value)}%`;
      if (pageCount) pageCount.textContent = "";
      pagesHost.innerHTML =
        '<p class="pdf-preview-status">Rendering preview…</p>';
      exportBtn.disabled = true;

      const mine = ++token;
      const ctx = await prepare();
      // Closed, or reopened onto a different sheet, while we were rasterizing.
      if (mine !== token || !session) return;

      session.ctx = ctx;
      const empty = !ctx || ctx.isEmpty;
      exportBtn.disabled = empty;
      if (empty) {
        renderPdfPreview([], pagesHost);
        return;
      }
      relayout();
    },
  };
  return pdfModal;
}

function openPdfPreviewModal(opts) {
  const ctl = getPdfPreviewModal();
  if (ctl) ctl.open(opts);
}

// The auto-flow export: capture the board once, then slice it into pages.
function openBoardPdfPreview() {
  openPdfPreviewModal({
    scaleKey: "cv-pdf-scale",
    fileName: "chords.pdf",
    prepare: async () => {
      const headings = pdfHeadings();
      const captures = await capturePdfSections();
      return { captures, headings, isEmpty: captures.length === 0 };
    },
    layout: (ctx, scale) => layoutPdfPages(ctx.captures, scale, ctx.headings),
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const openBtn = document.getElementById("downloadPdf");
  if (openBtn) openBtn.addEventListener("click", openBoardPdfPreview);
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

// Instrument + Sub-tab state and UI
let currentInstrument = "piano";
// Layout has no sub-tabs; the entry is a placeholder so setSubtab and
// saveInstrumentState stay total over every instrument.
let currentSubtab = { piano: "chord", guitar: "scale", drums: "beat", layout: "page" };

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
  if (inst !== currentInstrument) {
    // Flush the board we are leaving, then swap the other instrument's song in
    // so the two never share chords, inversions or guitar shapes.
    saveSections();
    currentInstrument = inst;
    loadSections();
  }
  saveInstrumentState();
  updateTabsUI({ animateSubTabs: false });
}

function setSubtab(inst, sub) {
  currentSubtab[inst] = sub;
  saveInstrumentState();
  updateTabsUI({ animateSubTabs: true });
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
  const capoControls = document.getElementById('guitarCapoControls');
  const metronomeControls = document.getElementById('metronomeControls');
  const metronomePanel = document.getElementById('metronomePanel');
  const addSectionCta = document.getElementById('addSectionCta');
  const pianoScaleEl = document.getElementById('pianoScale');
  const guitarStaffEl = document.getElementById('guitarStaff');
  const songMetaEl = document.getElementById('songMeta');
  const layoutPanel = document.getElementById('layoutPanel');
  const layoutControls = document.getElementById('layoutControls');
  const melodyPanel = document.getElementById('melodyPanel');
  // The empty-board hint belongs to the chord board, but only renderSections
  // ever touched it — so once the board was empty it followed you onto every
  // other tab. It has to be in the hide-all defaults like every other panel.
  const emptyState = document.getElementById('emptyState');

  // defaults
  if (boardsEl) boardsEl.style.display = 'none';
  if (guitarEl) guitarEl.style.display = 'none';
  if (guitarControls) guitarControls.style.display = 'none';
  if (pianoControls) pianoControls.style.display = 'none';
  if (pianoScaleControls) pianoScaleControls.style.display = 'none';
  if (capoControls) capoControls.style.display = 'none';
  if (metronomeControls) metronomeControls.style.display = 'none';
  if (metronomePanel) metronomePanel.style.display = 'none';
  if (handModeToggle) handModeToggle.style.display = 'none';
  if (addSectionCta) addSectionCta.style.display = 'none';
  if (pianoScaleEl) pianoScaleEl.style.display = 'none';
  if (songMetaEl) songMetaEl.style.display = 'none';
  if (layoutPanel) layoutPanel.style.display = 'none';
  if (layoutControls) layoutControls.style.display = 'none';
  if (melodyPanel) melodyPanel.style.display = 'none';
  if (emptyState) emptyState.hidden = true;
  // The staff belongs to the guitar scale tab; main.js still decides whether
  // custom mode wants it, so only add/remove the class and leave display alone.
  if (guitarStaffEl) guitarStaffEl.classList.add('tab-hidden');

  if (currentInstrument === 'piano') {
    const sub = currentSubtab.piano;
    if (sub === 'chord') {
      if (songMetaEl) songMetaEl.style.display = 'flex';
      if (boardsEl) boardsEl.style.display = 'block';
      if (pianoControls) pianoControls.style.display = 'inline-flex';
      if (handModeToggle) handModeToggle.style.display = 'inline-flex';
      if (addSectionCta) addSectionCta.style.display = 'block';
      // Re-render: cards may currently be guitar diagrams from the other tab.
      renderSections();
    } else if (sub === 'melody') {
      if (melodyPanel) melodyPanel.style.display = 'flex';
      showMelodyPanel('piano');
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
      if (guitarStaffEl) guitarStaffEl.classList.remove('tab-hidden');
    } else if (sub === 'melody') {
      if (melodyPanel) melodyPanel.style.display = 'flex';
      showMelodyPanel('guitar');
    } else {
      // Guitar → Chord: the same board as the piano tab, with each card drawn
      // as a fretboard diagram instead of a keyboard. Transpose and Clear are
      // reused from the piano control group; the two-hands toggle stays hidden.
      if (songMetaEl) songMetaEl.style.display = 'flex';
      if (boardsEl) boardsEl.style.display = 'block';
      if (pianoControls) pianoControls.style.display = 'inline-flex';
      if (capoControls) capoControls.style.display = 'inline-flex';
      if (addSectionCta) addSectionCta.style.display = 'block';
      renderSections();
    }
  } else if (currentInstrument === 'drums') {
    const sub = currentSubtab.drums;
    if (sub === 'metronome') {
      if (metronomeControls) metronomeControls.style.display = 'inline-flex';
      if (metronomePanel) metronomePanel.style.display = 'block';
    } else {
      // The Beat tab is the melody panel with a grid editor instead of a staff:
      // a beat is board content on the drums board, stored and referenced
      // exactly like a melody, so it reuses the panel rather than getting a
      // parallel one. The old drumsControls placeholder is gone with it.
      if (melodyPanel) melodyPanel.style.display = 'flex';
      showMelodyPanel('drums');
    }
  } else if (currentInstrument === 'layout') {
    // The sheet reads both boards rather than owning one, so it has to be
    // refreshed every time it comes on screen — chords may have changed on
    // either chord tab since it was last drawn.
    if (layoutPanel) layoutPanel.style.display = 'flex';
    if (layoutControls) layoutControls.style.display = 'inline-flex';
    refreshLayout();
  }

  if (!(currentInstrument === 'drums' && currentSubtab.drums === 'metronome')) {
    stopMetronome();
  }
  // A playing melody has to stop when you leave its tab, for the same reason
  // the metronome does — its notes are scheduled timers that would otherwise
  // keep firing over whatever tab you switched to.
  // The panel is on screen for piano→melody, guitar→melody AND drums→beat, so
  // "not the melody sub-tab" is no longer the right test — on the Beat tab it
  // would stop playback the instant you started it.
  const panelSub =
    currentInstrument === 'drums' ? 'beat' : 'melody';
  if (currentSubtab[currentInstrument] !== panelSub) hideMelodyPanel();

  // Move the animated highlights
  positionSegmentedHighlight(document.querySelector('.instrument-tabs.segmented'), true);
  positionSegmentedHighlight(document.getElementById('instrumentSubTabs'), animateSubTabs);
}

function isMetronomeViewActive() {
  return currentInstrument === 'drums' && currentSubtab.drums === 'metronome';
}

document.addEventListener('DOMContentLoaded', () => {
  loadInstrumentState();

  // The layout sheet is the one place the two script worlds deliberately meet,
  // so the coupling is an explicit hand-off rather than a shared global: it
  // gets exactly these four functions and cannot reach anything else here.
  // Injection rather than import also keeps the module graph one-directional.
  initLayout({
    readBoardState,
    buildCardElement,
    openPdfPreviewModal,
    // Two-hands is a live toggle, not part of a chord, so the sheet has to ask
    // rather than cache it: it decides how wide a piano block starts.
    isTwoHandsMode: () => twoHandsMode,
  });

  initMelodyPanel({
    readMelodies,
    writeMelodies,
    // The layout sheet lists melodies from the boards, so a melody renamed or
    // edited here has to invalidate what the sheet already drew. It only costs
    // anything when the sheet is on screen, which it never is from this tab.
    onChange: () => {},
  });

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
      const order = ['piano','guitar','drums','layout'];
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

// Initial load: restore sections then render. The instrument has to be known
// first — each instrument has its own board, so it decides which one loads.
loadInstrumentState();
loadSections();
// render sections layout (not the old single-card render)
renderSections();

const metronomeState = {
  bpm: 120,
  beatsPerMeasure: 4,
  beatValue: 4,
  currentBeat: 0,
  isRunning: false,
  timerId: null,
  tonality: 1, // 0 = noise click, 1 = pure tone
  noiseBuffer: null,
  tapTimes: [],
};

function clampMetronomeValue(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

// The metronome shares the app-wide context (see audio.js) rather than opening
// a second one. It still connects to the destination directly, so its level and
// timing are unchanged.
function ensureMetronomeAudioCtx() {
  return getAudioContext();
}

function ensureMetronomeNoiseBuffer(audioCtx) {
  if (metronomeState.noiseBuffer) return metronomeState.noiseBuffer;
  const duration = 0.05;
  const sampleRate = audioCtx.sampleRate;
  const buffer = audioCtx.createBuffer(1, Math.floor(sampleRate * duration), sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  metronomeState.noiseBuffer = buffer;
  return buffer;
}

function getMetronomeIntervalMs() {
  const beatDuration = (60 / metronomeState.bpm) * 1000;
  return beatDuration * (4 / metronomeState.beatValue);
}

function updateMetronomeBeatsDisplay() {
  const container = document.getElementById('metronomeBeatsDisplay');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < metronomeState.beatsPerMeasure; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'metronome-led';
    if (i === 0) dot.classList.add('accent-beat');
    dot.setAttribute('aria-label', `Beat ${i + 1}`);
    dot.textContent = String(i + 1);

    // Allow clicking a LED to toggle accent on/off.
    dot.addEventListener('click', () => {
      dot.classList.toggle('accent-beat');
    });

    container.appendChild(dot);
  }
}

function highlightMetronomeBeat(activeIndex) {
  const leds = document.querySelectorAll('#metronomeBeatsDisplay .metronome-led');
  leds.forEach((led, idx) => {
    led.classList.toggle('active', idx === activeIndex);
  });
}

function setMetronomeStatus(text) {
}

function setMetronomeButtonState(isRunning) {
  const toggleBtn = document.getElementById('metronomeToggle');
  if (toggleBtn) {
    toggleBtn.textContent = isRunning ? 'Stop' : 'Start';
    toggleBtn.setAttribute('aria-pressed', String(isRunning));
  }
}

function playMetronomeClick(isAccent) {
  const audioCtx = ensureMetronomeAudioCtx();
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  const tonality = typeof metronomeState.tonality === 'number' ? metronomeState.tonality : 0.6;
  const t = Math.min(Math.max(tonality, 0), 1);

  const masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.00001;
  masterGain.connect(audioCtx.destination);

  // Tonal component (oscillator)
  const osc = audioCtx.createOscillator();
  osc.frequency.value = isAccent ? 1600 : 900;
  const oscGain = audioCtx.createGain();
  oscGain.gain.value = t;
  osc.connect(oscGain);
  oscGain.connect(masterGain);

  // Noise component (percussive, less tonal)
  if (t < 1) {
    const noiseBuffer = ensureMetronomeNoiseBuffer(audioCtx);
    if (noiseBuffer) {
      const noiseSource = audioCtx.createBufferSource();
      noiseSource.buffer = noiseBuffer;
      const noiseGain = audioCtx.createGain();
      noiseGain.gain.value = 1 - t;
      noiseSource.connect(noiseGain);
      noiseGain.connect(masterGain);
      const nowNoise = audioCtx.currentTime;
      noiseSource.start(nowNoise);
      noiseSource.stop(nowNoise + 0.1);
    }
  }

  const now = audioCtx.currentTime;
  const peak = isAccent ? 0.8 : 0.5;
  masterGain.gain.setValueAtTime(0.00001, now);
  masterGain.gain.exponentialRampToValueAtTime(peak, now + 0.002);
  masterGain.gain.exponentialRampToValueAtTime(0.00001, now + 0.2);
  osc.start(now);
  osc.stop(now + 0.25);
}

function metronomeTick() {
  if (!metronomeState.isRunning) return;
  const beatIndex = metronomeState.currentBeat;

  const leds = document.querySelectorAll('#metronomeBeatsDisplay .metronome-led');
  const currentLed = leds[beatIndex];
  const isAccent = currentLed && currentLed.classList.contains('accent-beat');

  playMetronomeClick(isAccent);
  highlightMetronomeBeat(beatIndex);
  setMetronomeStatus(`Beat ${beatIndex + 1} / ${metronomeState.beatsPerMeasure}`);
  metronomeState.currentBeat = (metronomeState.currentBeat + 1) % metronomeState.beatsPerMeasure;
  metronomeState.timerId = window.setTimeout(metronomeTick, getMetronomeIntervalMs());
}

function restartMetronomeClock() {
  if (metronomeState.timerId) {
    clearTimeout(metronomeState.timerId);
    metronomeState.timerId = null;
  }
  if (metronomeState.isRunning) {
    metronomeState.currentBeat = 0;
    highlightMetronomeBeat(-1);
    metronomeTick();
  }
}

function startMetronome() {
  const ctx = ensureMetronomeAudioCtx();
  if (!ctx) {
    setMetronomeStatus('Metronome not supported in this browser');
    return;
  }
  if (ctx.state === 'suspended') ctx.resume();
  if (metronomeState.timerId) {
    clearTimeout(metronomeState.timerId);
    metronomeState.timerId = null;
  }
  metronomeState.isRunning = true;
  metronomeState.currentBeat = 0;
  highlightMetronomeBeat(-1);
  setMetronomeButtonState(true);
  setMetronomeStatus('Starting...');
  metronomeTick();
}

function stopMetronome() {
  if (metronomeState.timerId) {
    clearTimeout(metronomeState.timerId);
    metronomeState.timerId = null;
  }
  if (!metronomeState.isRunning) {
    setMetronomeButtonState(false);
    return;
  }
  metronomeState.isRunning = false;
  highlightMetronomeBeat(-1);
  setMetronomeButtonState(false);
  setMetronomeStatus('Metronome stopped');
}

function updateMetronomeBpm(value) {
  const bpm = clampMetronomeValue(Number(value), 30, 260);
  metronomeState.bpm = bpm;
  const bpmInput = document.getElementById('metronomeBpm');
  if (bpmInput) bpmInput.value = String(bpm);
  const bpmDisplay = document.getElementById('metronomeBpmValue');
  if (bpmDisplay) bpmDisplay.textContent = String(bpm);
  restartMetronomeClock();
}

function updateMetronomeBeats(value) {
  const beats = clampMetronomeValue(parseInt(value, 10), 1, 12);
  metronomeState.beatsPerMeasure = beats;
  const select = document.getElementById('metronomeBeats');
  if (select) select.value = String(beats);
  const beatsDisplay = document.getElementById('metronomeBeatsNumber');
  if (beatsDisplay) beatsDisplay.textContent = String(beats);
  updateMetronomeBeatsDisplay();
  highlightMetronomeBeat(-1);
  restartMetronomeClock();
}

function updateMetronomeBeatValue(value) {
  const allowed = [1, 2, 4, 8, 16];
  let beatValue = parseInt(value, 10);
  if (!allowed.includes(beatValue)) beatValue = 4;
  metronomeState.beatValue = beatValue;
  const select = document.getElementById('metronomeBeatValue');
  if (select) select.value = String(beatValue);
  const beatValueDisplay = document.getElementById('metronomeBeatValueNumber');
  if (beatValueDisplay) beatValueDisplay.textContent = String(beatValue);
  restartMetronomeClock();
}

function updateMetronomeTonality(value) {
  let v = Number(value);
  if (Number.isNaN(v)) v = 100;
  v = Math.min(Math.max(v, 0), 100);
  metronomeState.tonality = v / 100;
  const input = document.getElementById('metronomeTonality');
  if (input) input.value = String(v);
}

function registerMetronomeTap() {
  const now = Date.now();
  const maxGapMs = 2000;
  const maxSamples = 6;
  const taps = metronomeState.tapTimes || [];
  const lastTap = taps[taps.length - 1];
  if (!lastTap || now - lastTap > maxGapMs) {
    metronomeState.tapTimes = [now];
  } else {
    metronomeState.tapTimes = taps.concat(now).slice(-maxSamples);
  }

  const tapValue = document.getElementById('metronomeTapValue');
  const times = metronomeState.tapTimes;
  if (times.length < 2) {
    if (tapValue) tapValue.textContent = 'Tap 2+';
    return;
  }

  let total = 0;
  for (let i = 1; i < times.length; i += 1) {
    total += times[i] - times[i - 1];
  }
  const avgInterval = total / (times.length - 1);
  if (!avgInterval || Number.isNaN(avgInterval)) return;
  const bpm = clampMetronomeValue(Math.round(60000 / avgInterval), 30, 260);
  updateMetronomeBpm(bpm);
  if (tapValue) tapValue.textContent = `${bpm} BPM`;
}

function setupMetronomeUI() {
  const toggleBtn = document.getElementById('metronomeToggle');
  const bpmInput = document.getElementById('metronomeBpm');
  const beatsSelect = document.getElementById('metronomeBeats');
  const beatValueSelect = document.getElementById('metronomeBeatValue');
  const tonalityInput = document.getElementById('metronomeTonality');
  const tapBtn = document.getElementById('metronomeTap');
  if (!toggleBtn || !bpmInput || !beatsSelect || !beatValueSelect) return;

  updateMetronomeBeatsDisplay();
  highlightMetronomeBeat(-1);
  setMetronomeStatus('Metronome ready');
  setMetronomeButtonState(false);
  updateMetronomeBpm(bpmInput.value);
  if (tonalityInput) {
    updateMetronomeTonality(tonalityInput.value);
  }

  const beatsNumber = document.getElementById('metronomeBeatsNumber');
  const beatValueNumber = document.getElementById('metronomeBeatValueNumber');
  const attachTimeSigHover = (selectEl, numberEl) => {
    if (!selectEl || !numberEl) return;
    const add = () => numberEl.classList.add('is-hovered');
    const remove = () => numberEl.classList.remove('is-hovered');
    selectEl.addEventListener('mouseenter', add);
    selectEl.addEventListener('mouseleave', remove);
    selectEl.addEventListener('focus', add);
    selectEl.addEventListener('blur', remove);
  };
  attachTimeSigHover(beatsSelect, beatsNumber);
  attachTimeSigHover(beatValueSelect, beatValueNumber);

  toggleBtn.addEventListener('click', () => {
    if (metronomeState.isRunning) {
      stopMetronome();
    } else {
      startMetronome();
    }
  });
  bpmInput.addEventListener('input', (e) => {
    const display = document.getElementById('metronomeBpmValue');
    if (display) display.textContent = e.target.value;
  });
  bpmInput.addEventListener('change', (e) => {
    updateMetronomeBpm(e.target.value);
  });
  beatsSelect.addEventListener('change', (e) => {
    updateMetronomeBeats(e.target.value);
  });
  beatValueSelect.addEventListener('change', (e) => {
    updateMetronomeBeatValue(e.target.value);
  });
  if (tonalityInput) {
    tonalityInput.addEventListener('input', (e) => {
      updateMetronomeTonality(e.target.value);
    });
  }
  if (tapBtn) {
    tapBtn.addEventListener('click', registerMetronomeTap);
  }

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    if (!isMetronomeViewActive()) return;
    const target = e.target;
    const tag = target && target.tagName ? target.tagName.toUpperCase() : '';
    const interactive = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'];
    if (interactive.includes(tag) && !['metronomeBpm', 'metronomeBeats', 'metronomeBeatValue', 'metronomeToggle', 'metronomeTonality'].includes(target.id)) {
      return;
    }
    e.preventDefault();
    if (metronomeState.isRunning) {
      stopMetronome();
    } else {
      startMetronome();
    }
  });
}

// The drums Play/Clear/Tempo placeholder that used to live here is gone: the
// Beat tab is a real grid editor now and owns those controls itself, against
// the beat it is editing rather than against a number in the DOM.
document.addEventListener('DOMContentLoaded', () => {
  setupMetronomeUI();
});

// Draw a two-octave piano with scale tones highlighted (one-hand)
function drawPianoScale() {
  const el = document.getElementById('pianoScale');
  const keySel = document.getElementById('pianoScaleKey');
  const modeSel = document.getElementById('pianoScaleMode');
  if (!el || !keySel || !modeSel) return;

  const root = keySel.value;
  const mode = modeSel.value;
  const intervals = SCALE_FORMULAS[mode] || SCALE_FORMULAS.major;

  const { low: LOW, high: HIGH } = getPianoRange(false); // 2 octaves
  const rootIdx = noteIndex(root);
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
