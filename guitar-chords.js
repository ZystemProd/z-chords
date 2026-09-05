// guitar-chords.js — guitar chord voicings and diagram rendering.
//
// Pure logic + SVG generation, in the same spirit as guitar.js: it owns no DOM
// state and reads no localStorage. script.js drives it.
//
// Fret arrays are always length 6, ordered LOW to HIGH (string 6 -> string 1,
// i.e. E A D G B e), which is how chord charts are written ("x32010" is C).
// Note this is the reverse of guitar.js's GUITAR_TUNING, which runs high to low
// because it draws a horizontal fretboard with the high E on top. Chord boxes
// are drawn vertically with the low E on the left, so low-to-high is the
// natural order here.
//
// null = muted string, 0 = open string, n = fret n.

import { CHORD_PATTERNS, NOTES, noteIndex } from "./theory.js";

// Open string MIDI, low to high: E2 A2 D3 G3 B3 E4.
export const OPEN_MIDI = [40, 45, 50, 55, 59, 64];

const MAX_SPAN = 3; // highest minus lowest fretted fret, so a 4-fret reach
const MAX_FINGERS = 4;
const OPEN_STRING_WINDOW = 3; // highest window that may still use open strings

// --- Curated shapes --------------------------------------------------------
//
// These are the shapes guitarists actually play. Generated voicings can be
// technically correct yet awkward or unidiomatic, so anything in here wins.
// Every shape is checked against its chord's pitch classes by the test suite.

// Open-position chords, keyed "<root><quality>". Written exactly as charted.
const OPEN_SHAPES = {
  C: [null, 3, 2, 0, 1, 0],
  Cmaj7: [null, 3, 2, 0, 0, 0],
  C7: [null, 3, 2, 3, 1, 0],
  A: [null, 0, 2, 2, 2, 0],
  Am: [null, 0, 2, 2, 1, 0],
  A7: [null, 0, 2, 0, 2, 0],
  Am7: [null, 0, 2, 0, 1, 0],
  Amaj7: [null, 0, 2, 1, 2, 0],
  Asus4: [null, 0, 2, 2, 3, 0],
  G: [3, 2, 0, 0, 0, 3],
  G7: [3, 2, 0, 0, 0, 1],
  Gmaj7: [3, 2, 0, 0, 0, 2],
  E: [0, 2, 2, 1, 0, 0],
  Em: [0, 2, 2, 0, 0, 0],
  E7: [0, 2, 0, 1, 0, 0],
  Em7: [0, 2, 0, 0, 0, 0],
  Emaj7: [0, 2, 1, 1, 0, 0],
  Esus4: [0, 2, 2, 2, 0, 0],
  D: [null, null, 0, 2, 3, 2],
  Dm: [null, null, 0, 2, 3, 1],
  D7: [null, null, 0, 2, 1, 2],
  Dm7: [null, null, 0, 2, 1, 1],
  Dmaj7: [null, null, 0, 2, 2, 2],
  Dsus4: [null, null, 0, 2, 3, 3],
  Dsus2: [null, null, 0, 2, 3, 0],
};

// Movable barre shapes, as fret offsets from the root fret. The root sits on
// string 6 for the E family and string 5 for the A family, which is what makes
// them movable: slide the whole shape and the chord follows the root.
const MOVABLE_SHAPES = [
  // --- E-shape family: root on string 6 ---
  { rootString: 0, quality: "", offsets: [0, 2, 2, 1, 0, 0] },
  { rootString: 0, quality: "m", offsets: [0, 2, 2, 0, 0, 0] },
  { rootString: 0, quality: "7", offsets: [0, 2, 0, 1, 0, 0] },
  { rootString: 0, quality: "m7", offsets: [0, 2, 0, 0, 0, 0] },
  { rootString: 0, quality: "maj7", offsets: [0, 2, 1, 1, 0, 0] },
  { rootString: 0, quality: "sus4", offsets: [0, 2, 2, 2, 0, 0] },
  { rootString: 0, quality: "6", offsets: [0, 2, 2, 1, 2, 0] },
  { rootString: 0, quality: "m6", offsets: [0, 2, 2, 0, 2, 0] },
  { rootString: 0, quality: "m7b5", offsets: [0, 1, 0, 0, null, null] },

  // --- A-shape family: root on string 5 ---
  { rootString: 1, quality: "", offsets: [null, 0, 2, 2, 2, 0] },
  { rootString: 1, quality: "m", offsets: [null, 0, 2, 2, 1, 0] },
  { rootString: 1, quality: "7", offsets: [null, 0, 2, 0, 2, 0] },
  { rootString: 1, quality: "m7", offsets: [null, 0, 2, 0, 1, 0] },
  { rootString: 1, quality: "maj7", offsets: [null, 0, 2, 1, 2, 0] },
  { rootString: 1, quality: "sus4", offsets: [null, 0, 2, 2, 3, 0] },
  { rootString: 1, quality: "6", offsets: [null, 0, 2, 2, 2, 2] },
  { rootString: 1, quality: "m6", offsets: [null, 0, 2, 2, 1, 2] },
  { rootString: 1, quality: "m7b5", offsets: [null, 0, 1, 0, 1, null] },

  // --- D-string family: root on string 4, top four strings only ---
  // The small partial-barre forms, e.g. F as xx3211 rather than the full
  // six-string 133211. Far easier to play and extremely common, so they are
  // listed after the full barres but ahead of anything generated.
  { rootString: 2, quality: "", offsets: [null, null, 0, -1, -2, -2] }, // xx3211
  { rootString: 2, quality: "m", offsets: [null, null, 0, -2, -2, -2] }, // xx3111
  { rootString: 2, quality: "maj7", offsets: [null, null, 0, -1, -2, -3] }, // xx3210
  // The sevenths are the open D7/Dm7 shapes slid up, not variations of the
  // major form above: the b7 will not fit under the root on the top string.
  { rootString: 2, quality: "7", offsets: [null, null, 0, 2, 1, 2] }, // xx3545 for F
  { rootString: 2, quality: "m7", offsets: [null, null, 0, 2, 1, 1] }, // xx3544

  // --- Extended chords, A-shape family (written against C, root fret 3) ---
  // These reach *below* the root fret, which is normal: the 3rd of a 9th chord
  // sits a fret under the root on the next string. Placements that would push
  // an offset below fret 0 are skipped.
  { rootString: 1, quality: "9", offsets: [null, 0, -1, 0, 0, 0] }, // x32333
  { rootString: 1, quality: "m9", offsets: [null, 0, -2, 0, 0, 0] }, // x31333
  { rootString: 1, quality: "maj9", offsets: [null, 0, -1, 1, 0, 0] }, // x32433
  { rootString: 1, quality: "13", offsets: [null, 0, -1, 0, 2, 2] }, // x32355
  { rootString: 1, quality: "6/9", offsets: [null, 0, -1, -1, 0, 0] }, // x32233
  { rootString: 1, quality: "sus2", offsets: [null, 0, 2, 2, 0, null] }, // x35530
  { rootString: 1, quality: "dim", offsets: [null, 0, 1, 2, 1, null] }, // x34540
  { rootString: 1, quality: "dim7", offsets: [null, 0, 1, -1, 1, null] }, // x34240
  { rootString: 1, quality: "aug", offsets: [null, 0, -1, -2, -2, null] }, // x32110

  // --- Extended chords, E-shape family (written against F, root fret 1) ---
  { rootString: 0, quality: "9", offsets: [0, 2, 0, 1, 0, 2] }, // 131213
  { rootString: 0, quality: "m9", offsets: [0, 2, 0, 0, 0, 2] }, // 131113
  { rootString: 0, quality: "maj9", offsets: [0, 2, 1, 1, 0, 2] }, // 132213
  { rootString: 0, quality: "13", offsets: [0, 2, 0, 1, 2, 2] }, // 131233
];

// --- Voicing helpers -------------------------------------------------------

function pitchClassesOf(rootPc, intervals) {
  return new Set(intervals.map((i) => (((rootPc + i) % 12) + 12) % 12));
}

// Which tones the voicing must actually contain.
//
// Cramming every chord tone onto six strings is what a naive search does and
// it is not what anybody plays. The 5th goes first - it adds no colour. The
// 11th is an avoid note against a major 3rd, so it goes too unless the chord
// is named for it. On a 13th the 9th is optional colour. What is left is the
// root, the 3rd (or its sus replacement), the 7th and whichever extension
// gives the chord its name - the standard guide-tones-plus-colour rule.
function essentialTones(intervals) {
  const all = new Set(intervals);
  const essential = new Set(intervals);
  const highest = Math.max(...intervals);

  if (intervals.length >= 4) essential.delete(7); // perfect 5th
  if (essential.has(17) && all.has(4) && highest > 17) essential.delete(17); // 11th
  if (intervals.length >= 6 && highest > 14) essential.delete(14); // 9th

  return essential;
}

// The lowest interval a voicing may span between neighbouring notes.
//
// Close intervals turn to mud in the bass: a whole step between the root and
// the 9th is fine at the top of a chord and unplayable-sounding at C3. Thirds
// down low are fine, which is why open G (G2-B2-D3) works. So: no 2nds below
// G3, no semitones below C4, anything goes above that.
function minIntervalAt(midi) {
  if (midi < 55) return 3; // below G3, nothing tighter than a minor 3rd
  if (midi < 60) return 2; // below C4, no semitones
  return 1;
}

// Reject muddy spacing and unisons between neighbouring sounding strings.
function hasBadSpacing(midis) {
  for (let i = 1; i < midis.length; i++) {
    const gap = midis[i] - midis[i - 1];
    if (gap === 0) return true; // unison doubling on adjacent strings
    if (gap < minIntervalAt(midis[i - 1])) return true;
  }
  return false;
}

function frettedFrets(frets) {
  return frets.filter((f) => typeof f === "number" && f > 0);
}

export function voicingMidis(frets) {
  const out = [];
  frets.forEach((f, s) => {
    if (typeof f === "number") out.push(OPEN_MIDI[s] + f);
  });
  return out;
}

// Can one finger, lying flat at `fret`, cover strings `from` through `to`?
//
// Only if every string it crosses is stopped at that fret or higher. An open
// string underneath is a contradiction -- the finger would stop it -- and a
// muted string means the hand is not lying across it at all. This is the rule
// that keeps a barre from being drawn straight through an open string.
function fingerCanSpan(frets, fret, from, to) {
  for (let s = from; s <= to; s++) {
    const f = frets[s];
    if (f === null || f < fret) return false;
  }
  return true;
}

// The index barre: the lowest fretted fret, spanning the strings it can
// actually reach. If an open string sits between two strings at that fret, the
// finger cannot cross it, so the barre is only the reachable run (and is no
// barre at all if that leaves fewer than two strings).
function detectBarre(frets) {
  const fretted = frettedFrets(frets);
  if (!fretted.length) return null;
  const min = Math.min(...fretted);

  const at = [];
  frets.forEach((f, s) => {
    if (f === min) at.push(s);
  });
  if (at.length < 2) return null;

  // Longest run of strings at this fret that one finger could actually cover.
  let best = null;
  for (let i = 0; i < at.length; i++) {
    for (let j = at.length - 1; j > i; j--) {
      if (!fingerCanSpan(frets, min, at[i], at[j])) continue;
      const width = at[j] - at[i];
      if (!best || width > best.width) {
        best = { width, fromString: at[i], toString: at[j] };
      }
      break;
    }
  }
  if (!best) return null;
  return { fret: min, fromString: best.fromString, toString: best.toString };
}

// How many fingers the shape needs.
//
// Not simply one per fretted string: a finger laid flat covers several. The
// index barre at the lowest fret lies across the whole neck, so strings at that
// fret cost one finger however far apart they are. Above it, a finger can still
// cover a run of *adjacent* strings at the same fret -- that is how x13333
// (Bb6) is played, index at fret 1 and the ring finger flat across fret 3 --
// so each contiguous run at a given fret costs one finger.
function fingerCount(frets) {
  const byFret = new Map();
  frets.forEach((f, s) => {
    if (typeof f === "number" && f > 0) {
      if (!byFret.has(f)) byFret.set(f, []);
      byFret.get(f).push(s);
    }
  });
  if (!byFret.size) return 0;

  const minFret = Math.min(...byFret.keys());
  let fingers = 0;
  for (const [fret, strings] of byFret) {
    strings.sort((a, b) => a - b);
    let runs = 1;
    for (let i = 1; i < strings.length; i++) {
      const prev = strings[i - 1];
      const cur = strings[i];
      // The index finger at the lowest fret lies flat and passes under
      // anything fretted higher, so it can bridge a gap. Every other finger
      // has to cover strictly adjacent strings: extending it further would
      // press the string in between at this fret and kill its lower note.
      const bridged =
        fret === minFret
          ? fingerCanSpan(frets, fret, prev, cur)
          : cur === prev + 1;
      if (!bridged) runs++;
    }
    fingers += runs;
  }
  return fingers;
}

function span(frets) {
  const fretted = frettedFrets(frets);
  if (fretted.length < 2) return 0;
  return Math.max(...fretted) - Math.min(...fretted);
}

// Muting a string between two sounding ones means silencing a string your hand
// is already crossing - awkward and rarely what anyone plays. Muting from the
// bass side (D and A shapes) is completely normal.
function hasInteriorMute(frets) {
  const sounding = frets.map((f) => typeof f === "number");
  const first = sounding.indexOf(true);
  const last = sounding.lastIndexOf(true);
  if (first < 0) return false;
  for (let i = first; i <= last; i++) if (!sounding[i]) return true;
  return false;
}

function makeVoicing(frets, source, rootPc) {
  const midis = voicingMidis(frets);
  if (!midis.length) return null;
  const fretted = frettedFrets(frets);
  const lowFret = fretted.length ? Math.min(...fretted) : 0;
  const bassPc = ((midis[0] % 12) + 12) % 12;
  return {
    frets: frets.slice(),
    midis,
    source,
    barre: detectBarre(frets),
    span: span(frets),
    fingers: fingerCount(frets),
    // Diagram window. Anything sitting inside the first four frets is drawn
    // against the nut, the way charts show first-position chords -- otherwise
    // x32333 would render as a "2fr" box just because its lowest fretted note
    // happens to be fret 2. Higher shapes start at their lowest fretted fret
    // and carry a position label instead.
    baseFret:
      frets.some((f) => f === 0) || !fretted.length || Math.max(...fretted) <= 4
        ? 1
        : lowFret,
    rootInBass: bassPc === rootPc,
    stringCount: midis.length,
  };
}

function signature(frets) {
  return frets.map((f) => (f === null ? "x" : f)).join(",");
}

// --- Generated voicings ----------------------------------------------------

// Score higher = better. Used to rank generated shapes so the most idiomatic
// ones surface first.
function scoreVoicing(v, essential, chordPcs) {
  let s = 0;
  if (v.rootInBass) s += 100;
  s += v.stringCount * 12;
  s -= v.fingers * 8;
  s -= v.span * 6;
  s += v.frets.filter((f) => f === 0).length * 4; // open strings ring
  if (v.barre) s -= 4;
  const covered = new Set(v.midis.map((m) => ((m % 12) + 12) % 12));
  for (const pc of chordPcs) if (covered.has(pc)) s += 5;
  for (const pc of essential) if (!covered.has(pc)) s -= 60;
  s -= Math.max(0, v.baseFret - 1) * 1.5; // prefer lower positions
  return s;
}

function generateVoicings(rootPc, intervals) {
  const chordPcs = pitchClassesOf(rootPc, intervals);
  const essential = new Set(
    [...essentialTones(intervals)].map((i) => (((rootPc + i) % 12) + 12) % 12)
  );

  const results = [];
  const seen = new Set();

  for (let window = 0; window <= 12; window++) {
    // Open strings only count near the nut. A finger-free open string is
    // technically available anywhere, but mixing one into a shape fretted at
    // the 13th is not a voicing anybody plays -- without this the generator
    // happily emits things like 13-0-15-14-13-13.
    const allowOpen = window <= OPEN_STRING_WINDOW;

    // Candidate frets per string: muted, open (if it fits the chord), or a
    // fret inside the window.
    const candidates = OPEN_MIDI.map((open) => {
      const opts = [null];
      if (allowOpen && chordPcs.has(((open % 12) + 12) % 12)) opts.push(0);
      for (let f = Math.max(window, 1); f <= window + MAX_SPAN; f++) {
        if (chordPcs.has((((open + f) % 12) + 12) % 12)) opts.push(f);
      }
      return opts;
    });

    const frets = new Array(6).fill(null);
    const walk = (s) => {
      if (results.length > 4000) return; // safety valve
      if (s === 6) {
        const midis = voicingMidis(frets);
        if (midis.length < 4) return;
        if (hasInteriorMute(frets)) return;
        if (span(frets) > MAX_SPAN) return;
        if (fingerCount(frets) > MAX_FINGERS) return;
        if (hasBadSpacing(midis)) return;

        const covered = new Set(midis.map((m) => ((m % 12) + 12) % 12));
        for (const pc of essential) if (!covered.has(pc)) return;

        const sig = signature(frets);
        if (seen.has(sig)) return;
        seen.add(sig);

        const v = makeVoicing(frets, "generated", rootPc);
        if (v) results.push(v);
        return;
      }
      for (const f of candidates[s]) {
        frets[s] = f;
        walk(s + 1);
      }
      frets[s] = null;
    };
    walk(0);
  }

  results.sort(
    (a, b) => scoreVoicing(b, essential, chordPcs) - scoreVoicing(a, essential, chordPcs)
  );
  return results;
}

// --- Public API ------------------------------------------------------------

const cache = new Map();

/**
 * Playable voicings for a chord, best first: curated shapes ahead of generated
 * ones, then open positions ahead of shapes up the neck.
 */
export function getVoicingsForChord(rootName, quality = "", limit = 6) {
  const rootPc = noteIndex(rootName);
  if (rootPc < 0) return [];
  const intervals = CHORD_PATTERNS[quality || ""];
  if (!intervals) return [];

  const key = rootPc + "|" + quality + "|" + limit;
  if (cache.has(key)) return cache.get(key);

  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (!v) return;
    const sig = signature(v.frets);
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push(v);
  };

  // 1. Open shape, if this exact root+quality has one.
  const openKey = NOTES[rootPc] + (quality || "");
  if (OPEN_SHAPES[openKey]) push(makeVoicing(OPEN_SHAPES[openKey], "curated", rootPc));

  // 2. Movable barre shapes, slid so their root string lands on the root.
  for (const shape of MOVABLE_SHAPES) {
    if (shape.quality !== (quality || "")) continue;
    const openPc = ((OPEN_MIDI[shape.rootString] % 12) + 12) % 12;
    let rootFret = (rootPc - openPc + 12) % 12;
    // A barre at fret 0 is just the open shape; take it an octave up instead.
    if (rootFret === 0) rootFret = 12;
    for (const base of [rootFret, rootFret - 12]) {
      if (base < 1 || base > 12) continue;
      const frets = shape.offsets.map((o) => (o === null ? null : base + o));
      // Extended shapes reach below the root fret, so a low placement can push
      // a string past the nut. That placement simply does not exist.
      if (frets.some((f) => f !== null && f < 0)) continue;
      push(makeVoicing(frets, "curated", rootPc));
    }
  }

  // 3. Generated, to fill out the list and cover qualities no library has.
  for (const v of generateVoicings(rootPc, intervals)) {
    if (out.length >= limit) break;
    push(v);
  }

  const sorted = out.slice(0, limit);
  cache.set(key, sorted);
  return sorted;
}

/**
 * Voicings for an arbitrary set of pitch classes — used for custom chords from
 * the piano modal, which carry MIDI numbers rather than a parseable symbol.
 */
export function getVoicingsForPitchClasses(rootPc, pitchClasses, limit = 6) {
  const pcs = Array.from(new Set(pitchClasses.map((p) => ((p % 12) + 12) % 12)));
  if (!pcs.length) return [];
  const root = ((rootPc % 12) + 12) % 12;
  const intervals = pcs.map((p) => (p - root + 12) % 12).sort((a, b) => a - b);
  const key = "pc|" + root + "|" + intervals.join(",") + "|" + limit;
  if (cache.has(key)) return cache.get(key);
  const out = generateVoicings(root, intervals).slice(0, limit);
  cache.set(key, out);
  return out;
}

// --- Diagram rendering -----------------------------------------------------
//
// Elements carry classes rather than hard-coded colours (which is what
// guitar.js does) so the diagram follows the light/dark theme and the PDF
// export can restyle it. See the .gc-* rules in styles.css.

const SVG_NS = "http://www.w3.org/2000/svg";

const STRING_GAP = 16;
const FRET_GAP = 20;
const FRET_ROWS = 5; // fret spaces visible in the box
const PAD_TOP = 24; // room for the x/o markers above the nut
const PAD_LEFT = 22; // room for the "5fr" position label
const PAD_RIGHT = 10;
const PAD_BOTTOM = 8;

const BOX_W = STRING_GAP * 5;
const BOX_H = FRET_GAP * FRET_ROWS;

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * Draw one voicing as a chord box: strings vertical, low E on the left, which
 * is the standard orientation for chord charts.
 */
export function renderChordDiagram(voicing, opts = {}) {
  const width = PAD_LEFT + BOX_W + PAD_RIGHT;
  const height = PAD_TOP + BOX_H + PAD_BOTTOM;

  const svg = el("svg", {
    class: "gc-diagram",
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
  });
  if (opts.ariaLabel) svg.setAttribute("aria-label", opts.ariaLabel);

  const { frets, baseFret, barre } = voicing;
  const openPosition = baseFret === 1;

  const xOf = (s) => PAD_LEFT + s * STRING_GAP;
  const yOfFretLine = (row) => PAD_TOP + row * FRET_GAP;
  const yOfDot = (row) => PAD_TOP + (row + 0.5) * FRET_GAP;

  // Fret lines. The nut is the thick one, drawn only in open position.
  for (let row = 0; row <= FRET_ROWS; row++) {
    svg.appendChild(
      el("line", {
        class: row === 0 && openPosition ? "gc-nut" : "gc-fret",
        x1: PAD_LEFT,
        y1: yOfFretLine(row),
        x2: PAD_LEFT + BOX_W,
        y2: yOfFretLine(row),
      })
    );
  }

  // Strings.
  for (let s = 0; s < 6; s++) {
    svg.appendChild(
      el("line", {
        class: "gc-string",
        x1: xOf(s),
        y1: PAD_TOP,
        x2: xOf(s),
        y2: PAD_TOP + BOX_H,
      })
    );
  }

  // Position label, so a shape up the neck is not mistaken for open position.
  if (!openPosition) {
    const label = el("text", {
      class: "gc-position",
      x: PAD_LEFT - 6,
      y: yOfDot(0) + 3,
      "text-anchor": "end",
    });
    label.textContent = `${baseFret}fr`;
    svg.appendChild(label);
  }

  // Barre first, so the dots sit on top of it.
  if (barre) {
    const row = barre.fret - baseFret;
    if (row >= 0 && row < FRET_ROWS) {
      svg.appendChild(
        el("rect", {
          class: "gc-barre",
          x: xOf(barre.fromString) - 5,
          y: yOfDot(row) - 5,
          width: xOf(barre.toString) - xOf(barre.fromString) + 10,
          height: 10,
          rx: 5,
        })
      );
    }
  }

  frets.forEach((f, s) => {
    if (f === null) {
      // Muted: an x above the nut.
      const x = xOf(s);
      const y = PAD_TOP - 9;
      svg.appendChild(el("line", { class: "gc-mute", x1: x - 3.5, y1: y - 3.5, x2: x + 3.5, y2: y + 3.5 }));
      svg.appendChild(el("line", { class: "gc-mute", x1: x + 3.5, y1: y - 3.5, x2: x - 3.5, y2: y + 3.5 }));
      return;
    }
    if (f === 0) {
      // Open: a ring above the nut.
      svg.appendChild(el("circle", { class: "gc-open", cx: xOf(s), cy: PAD_TOP - 9, r: 3.5 }));
      return;
    }
    const row = f - baseFret;
    if (row < 0 || row >= FRET_ROWS) return; // outside the visible window
    // Strings already covered by the barre rectangle need no separate dot.
    if (barre && f === barre.fret && s >= barre.fromString && s <= barre.toString) return;
    svg.appendChild(el("circle", { class: "gc-dot", cx: xOf(s), cy: yOfDot(row), r: 5 }));
  });

  return svg;
}

/** "x32010" style chart text, handy for labels and tooltips. */
export function voicingChart(frets) {
  const wide = frets.some((f) => typeof f === "number" && f > 9);
  return frets.map((f) => (f === null ? "x" : f)).join(wide ? "-" : "");
}
