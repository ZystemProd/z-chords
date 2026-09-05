// theory.js — music theory constants and helpers shared by every script world.
//
// script.js (piano/chords), main.js + guitar.js (guitar scales) all import from
// here. Previously each file carried its own copy of the note names, the
// enharmonic map and the scale formulas; a change to one silently left the
// others behind. Add theory data here, once.

export const NOTES = [
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

export const ENHARMONIC = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#" };

export const CHORD_PATTERNS = {
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

export const SCALE_FORMULAS = {
  // Minor pentatonic (legacy key 'pentatonic') and blues (minor)
  pentatonic: [0, 3, 5, 7, 10],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  minorBlues: [0, 3, 5, 6, 7, 10],
  // Major pentatonic
  majorPentatonic: [0, 2, 4, 7, 9],
  // Major blues (hexatonic): 1 2 b3 3 5 6
  majorBlues: [0, 2, 3, 4, 7, 9],
  // Heptatonic modes
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  // Symmetric
  wholeTone: [0, 2, 4, 6, 8, 10],
  // Harmonic minor (Aeolian with raised 7th)
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  // Melodic minor (ascending)
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  // Harmonic major (major with b6)
  harmonicMajor: [0, 2, 4, 5, 7, 8, 11],
  // Diminished (octatonic)
  diminishedHalfWhole: [0, 1, 3, 4, 6, 7, 9, 10],
  diminishedWholeHalf: [0, 2, 3, 5, 6, 8, 9, 11],
};

// Quality suffixes, longest first, so "maj7" wins over "maj" in the alternation.
export const CHORD_TYPES = Object.keys(CHORD_PATTERNS).filter((k) => k !== "");

const typesSorted = CHORD_TYPES.slice().sort((a, b) => b.length - a.length);

// Quality keys are literal text, but some contain regex metacharacters —
// "m(maj7)" most notably. Escape them or the alternation silently reinterprets
// them as grouping and the chord becomes unparseable.
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TYPE_RE = typesSorted.map(escapeRe).join("|");

export const CHORD_RE = new RegExp(
  "^[ ]*([A-Ga-g])([#b]?)(?:(" + TYPE_RE + "))?[ ]*$"
);

// "bb" -> "Bb": strip spaces, upper-case the letter, keep the accidental as-is.
export function normalizeRoot(r) {
  if (!r) return r;
  r = r.split(" ").join("");
  return r[0].toUpperCase() + (r[1] || "");
}

// Pitch class 0-11 for a note name, or -1 if it isn't one. Accepts flats.
export function noteIndex(name) {
  if (!name) return -1;
  if (ENHARMONIC[name]) name = ENHARMONIC[name];
  return NOTES.indexOf(name);
}
