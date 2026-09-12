// Melody: the note model and its pure arithmetic. No DOM — this is the
// counterpart of layout-model.js, and melody-render.js is the only thing that
// draws it.
//
// String indexing for tab follows guitar-chords.js's OPEN_MIDI (low string to
// high), not guitar.js's GUITAR_TUNING (high to low) — tab relates to chord
// shapes, and this keeps melody and chord code agreeing about which index
// means which string.
import { OPEN_MIDI } from "./guitar-chords.js";

export const CLEFS = ["treble", "bass", "grand", "guitar", "drums"];
export const DURATION_DENOMS = [1, 2, 4, 8, 16];

// A whole note is 64 ticks. Every supported duration — down to a
// double-dotted 16th — divides evenly into an integer at this resolution,
// which is what keeps bar arithmetic exact integer math with no drift.
export const TICKS_PER_WHOLE = 64;

export function durationTicks(den, dots = 0) {
  const base = TICKS_PER_WHOLE / den;
  // dots=0 -> *1, dots=1 -> *1.5, dots=2 -> *1.75
  return base * (2 - 2 ** -Math.max(0, dots));
}

export function barCapacityTicks(timeSig) {
  const num = Number(timeSig && timeSig.num) || 4;
  const den = Number(timeSig && timeSig.den) || 4;
  return num * (TICKS_PER_WHOLE / den);
}

function mintId() {
  try {
    return `m_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  } catch (_) {
    return `m_${Math.random().toString(36).slice(2, 12)}`;
  }
}

export function createMelody(opts = {}) {
  const clef = CLEFS.includes(opts.clef) ? opts.clef : "treble";
  const timeSig =
    opts.timeSig &&
    Number.isFinite(Number(opts.timeSig.num)) &&
    Number.isFinite(Number(opts.timeSig.den))
      ? { num: Number(opts.timeSig.num), den: Number(opts.timeSig.den) }
      : { num: 4, den: 4 };
  return {
    id: opts.id || mintId(),
    // Melodies are named board content — the melody list shows the name and
    // the layout library places blocks by it, the way sections are named.
    name: typeof opts.name === "string" ? opts.name : "Melody",
    clef,
    timeSig,
    keyRoot: typeof opts.keyRoot === "string" ? opts.keyRoot : "C",
    tempo: Number.isFinite(Number(opts.tempo)) ? Number(opts.tempo) : 96,
    events: Array.isArray(opts.events) ? opts.events : [],
  };
}

// Never throws: a corrupt or half-written melody degrades to something
// renderable rather than taking a layout block down with it.
export function normalizeMelody(raw) {
  if (!raw || typeof raw !== "object") return createMelody();

  const events = (Array.isArray(raw.events) ? raw.events : [])
    .filter((e) => e && typeof e === "object")
    .map((e) => {
      const rest = !!e.rest;
      const notes = rest
        ? []
        : (Array.isArray(e.notes) ? e.notes : [])
            .filter((n) => n && Number.isFinite(Number(n.midi)))
            .map((n) => ({
              midi: Math.max(0, Math.min(127, Math.round(Number(n.midi)))),
              ...(Number.isInteger(n.stringIdx) ? { stringIdx: n.stringIdx } : {}),
              ...(Number.isInteger(n.fret) ? { fret: n.fret } : {}),
              ...(n.manualTab ? { manualTab: true } : {}),
            }));
      return {
        den: DURATION_DENOMS.includes(e.den) ? e.den : 4,
        dots: [0, 1, 2].includes(e.dots) ? e.dots : 0,
        rest,
        notes,
      };
    })
    // An event with no sound and no rest marker is neither a note nor a rest —
    // drop it rather than render something meaningless.
    .filter((e) => e.rest || e.notes.length);

  return createMelody({ ...raw, events });
}

export function totalTicks(melody) {
  return (melody.events || []).reduce(
    (sum, e) => sum + durationTicks(e.den, e.dots || 0),
    0
  );
}

// ---- Splitting a duration across a barline ----
//
// A note that crosses a barline (or, occasionally, a note that lands on an
// off-grid position within a bar) has to be redrawn as two or more tied
// notes, each a legal single-notehead duration. `decomposeTicks` finds the
// SHORTEST such list — a small dynamic program over "ticks still to place",
// not a greedy take-the-largest-first pass.
//
// Greedy genuinely is not good enough here, and it isn't a rare-edge-case
// gap: decomposing 10 ticks greedily takes 8 first (the largest that fits)
// and is left with 2, which has no representation on its own — even though
// 6+4=10 is an exact, valid split. Measured across 1..256 ticks, greedy
// needed a fallback for 147 of them; the DP below needs one for exactly the
// five values that are truly impossible.
//
// Those five are real, not a bug to chase further: our duration vocabulary's
// tick values (4,6,7,8,12,14,16,24,28,32,48,56,64) have a greatest common
// divisor of 1, so by the coin-problem (Frobenius) result, ticks counts of
// 1, 2, 3, 5 and 9 have no exact representation as a sum of them, full stop —
// no algorithm finds a split that does not exist. The fallback folds such a
// leftover into the nearest duration instead of dropping it, so the piece
// never drifts out of rhythm. The one thing sacrificed in that rare case is
// the prettiest possible tie — never correctness of the total duration,
// which the tests hold to exactly.
const DURATION_VALUES = DURATION_DENOMS.flatMap((den) =>
  [2, 1, 0].map((dots) => ({ den, dots, ticks: durationTicks(den, dots) }))
).sort((a, b) => b.ticks - a.ticks);

// dp[t] = the shortest list of {den,dots,ticks} summing to exactly t, or
// undefined if t cannot be built at all. Rebuilt per call rather than cached
// across calls: targets are at most a few bars' worth of ticks, so even a few
// hundred entries costs nothing, and a fresh table means no shared mutable
// state to reason about between calls.
function shortestDecomposition(target) {
  const dp = new Array(target + 1);
  dp[0] = [];
  for (let t = 1; t <= target; t += 1) {
    let best = null;
    for (const d of DURATION_VALUES) {
      if (d.ticks > t) continue;
      const prev = dp[t - d.ticks];
      if (!prev) continue;
      if (!best || prev.length + 1 < best.length) best = [...prev, d];
    }
    dp[t] = best;
  }
  return dp[target];
}

export function decomposeTicks(ticks) {
  // A caller passing 0 (or less) gets nothing back, not a part with 0 ticks —
  // a 0-tick notehead would be silently invisible progress to anything walking
  // ticks in a loop. layoutBars used to hit exactly this after a bar filled
  // exactly and forgot to reset its cursor; that bug is fixed, but this stays
  // as the second line of defence.
  const target = Math.round(ticks);
  if (!(target > 0)) return [];

  const exact = shortestDecomposition(target);
  if (exact) return exact.map((d) => ({ den: d.den, dots: d.dots, ticks: d.ticks }));

  // One of the five genuinely unrepresentable remainders. Represent it as the
  // single closest legal duration, ticks overridden to the true value so the
  // sum stays exact — see the file header for why no split can do better.
  const closest =
    DURATION_VALUES.find((d) => d.ticks <= target) ||
    DURATION_VALUES[DURATION_VALUES.length - 1];
  return [{ den: closest.den, dots: closest.dots, ticks: target }];
}

// ---- Bars ----
//
// Bars are computed, never stored: this walks the event list once, and every
// tied fragment — whether split by a barline or by decomposeTicks finding an
// off-grid remainder — becomes one entry with tie flags relative to the
// whole event, not just its neighbouring fragment.
//
// Returns [{ index, capacityTicks, items }], items = [{
//   event, eventIndex, den, dots, startTicks, ticks, tiedFrom, tiedTo
// }]. Rests carry the same shape for bookkeeping, but are never tied in
// notation — melody-render.js simply does not draw a tie curve for them.
export function layoutBars(melody) {
  // A degenerate time signature (num <= 0, or a den that divides out to <= 0
  // ticks) would give every bar zero room, and a while-loop walking ticks
  // against a zero-width bar never finishes. barCapacityTicks trusts its
  // input, so this is the one place that has to distrust it back.
  const rawCapacity = barCapacityTicks(melody.timeSig);
  const capacity = rawCapacity > 0 ? rawCapacity : TICKS_PER_WHOLE;
  const bars = [];
  let bar;
  const newBar = () => {
    bar = { index: bars.length, capacityTicks: capacity, items: [] };
    bars.push(bar);
    return bar;
  };
  newBar();
  let cursor = 0; // ticks consumed in the current bar

  (melody.events || []).forEach((event, eventIndex) => {
    let remaining = durationTicks(event.den, event.dots || 0);
    let isFirstPieceOfEvent = true;

    while (remaining > 0) {
      if (cursor >= capacity) {
        newBar();
        cursor = 0;
      }
      const spaceLeft = capacity - cursor;
      const pieceTicks = Math.min(remaining, spaceLeft);
      const parts = decomposeTicks(pieceTicks);

      parts.forEach((part, partIndex) => {
        const isLastPartOfPiece = partIndex === parts.length - 1;
        bar.items.push({
          event,
          eventIndex,
          den: part.den,
          dots: part.dots,
          startTicks: cursor,
          ticks: part.ticks,
          tiedFrom: !(isFirstPieceOfEvent && partIndex === 0),
          tiedTo: !(isLastPartOfPiece && pieceTicks === remaining),
        });
        cursor += part.ticks;
      });

      remaining -= pieceTicks;
      isFirstPieceOfEvent = false;
    }
  });

  return bars;
}

// ---- Drums ----
//
// A beat is a melody with `clef: "drums"`. It is NOT a fifth notation system:
// the events, the tick arithmetic, the bar splitting, the layout blocks and the
// song file all work on it unchanged — which is the whole reason the plan put
// drums on this model rather than inventing a grid format of its own.
//
// A voice is identified by its **General MIDI percussion note**, so `notes:
// [{midi}]` keeps its existing meaning (something that sounds at that pitch)
// and nothing downstream needs a drum-shaped special case. The staff position
// and notehead are presentation, and live here only because the renderer and
// the grid editor must agree on them.
//
// Positions are the standard drum-set mapping read against a treble clef:
// kick in the bottom space, snare in the third space, cymbals at and above the
// top line, cymbals with a cross notehead.
export const DRUM_VOICES = [
  { id: "crash", label: "Crash", midi: 49, key: "a/5", head: "x2" },
  { id: "hihat", label: "Hi-hat", midi: 42, key: "g/5", head: "x2" },
  { id: "ride", label: "Ride", midi: 51, key: "f/5", head: "x2" },
  { id: "snare", label: "Snare", midi: 38, key: "c/5", head: null },
  { id: "kick", label: "Kick", midi: 36, key: "f/4", head: null },
];

const DRUM_BY_MIDI = new Map(DRUM_VOICES.map((v) => [v.midi, v]));

export function drumVoiceForMidi(midi) {
  return DRUM_BY_MIDI.get(Math.round(midi)) || null;
}

export function isDrumMelody(melody) {
  return !!melody && melody.clef === "drums";
}

// The grid's resolution. 16th notes is what a beat grid means in practice —
// finer than that and the grid stops being readable, coarser and you cannot
// write a straight 16th hat pattern.
export const BEAT_STEP_DEN = 16;
const STEP_TICKS = TICKS_PER_WHOLE / BEAT_STEP_DEN;

export function stepsPerBar(timeSig) {
  return Math.max(1, Math.round(barCapacityTicks(timeSig) / STEP_TICKS));
}

// How many grid columns a beat occupies: always whole bars, and at least one,
// so an empty beat still presents a bar to click in.
export function beatStepCount(melody) {
  const per = stepsPerBar(melody.timeSig);
  const ticks = totalTicks(melody);
  const bars = Math.max(1, Math.ceil(ticks / (per * STEP_TICKS)));
  return bars * per;
}

// events -> grid. Returns a Map of "voiceId" -> Set(stepIndex).
//
// Built by walking ticks rather than by counting events, because an event is
// not necessarily one step: rests are merged into the longest legal durations
// on the way out (see melodyFromGrid), so the event list and the grid columns
// deliberately do not correspond one-to-one.
export function gridFromMelody(melody) {
  const grid = new Map(DRUM_VOICES.map((v) => [v.id, new Set()]));
  let atTicks = 0;
  (melody.events || []).forEach((event) => {
    const step = Math.round(atTicks / STEP_TICKS);
    if (!event.rest) {
      (event.notes || []).forEach((n) => {
        const voice = drumVoiceForMidi(n.midi);
        if (voice) grid.get(voice.id).add(step);
      });
    }
    atTicks += durationTicks(event.den, event.dots || 0);
  });
  return grid;
}

// grid -> events. The inverse, and the one that has real work to do: a run of
// empty steps becomes the FEWEST legal rests rather than one rest per step,
// which is the difference between a readable chart and a wall of 16th rests.
//
// Runs are clipped to the bar so a merged rest never crosses a barline — not
// for correctness (layoutBars would split it anyway) but because the split
// would come back as a *tied* pair, and a tied rest is not a thing.
function hitsAt(grid, step) {
  return DRUM_VOICES.filter((v) => {
    const set = grid.get(v.id);
    return set && set.has(step);
  });
}

export function melodyFromGrid(melody, grid, totalSteps) {
  const per = stepsPerBar(melody.timeSig);
  const steps = Math.max(per, Math.round(totalSteps) || beatStepCount(melody));
  const events = [];

  let step = 0;
  while (step < steps) {
    const hits = hitsAt(grid, step);

    // How far this column runs before the next hit, clipped to the end of its
    // bar. Runs are clipped so nothing produced here crosses a barline: not for
    // correctness (layoutBars would split it anyway) but because that split
    // comes back as a *tied* pair, and neither a tied rest nor a tied drum hit
    // is a thing — a tie across a barline would read as a second strike.
    const barEnd = (Math.floor(step / per) + 1) * per;
    let run = step + 1;
    while (run < barEnd && run < steps && !hitsAt(grid, run).length) run += 1;
    const parts = decomposeTicks((run - step) * STEP_TICKS);

    if (hits.length) {
      // A drum hit's written value is the gap to the next hit — that is what
      // makes a hat on every off-8th read as a row of beamed 8ths instead of
      // 16ths alternating with 16th rests. Where the gap needs more than one
      // duration to express, the hit takes the first and the remainder becomes
      // rests: percussion does not sustain, so it cannot be tied.
      const [first, ...tail] = parts.length ? parts : [{ den: BEAT_STEP_DEN, dots: 0 }];
      events.push({
        den: first.den,
        dots: first.dots,
        rest: false,
        notes: hits.map((v) => ({ midi: v.midi })),
      });
      tail.forEach((part) => {
        events.push({ den: part.den, dots: part.dots, rest: true, notes: [] });
      });
    } else {
      parts.forEach((part) => {
        events.push({ den: part.den, dots: part.dots, rest: true, notes: [] });
      });
    }
    step = run;
  }

  return { ...melody, events };
}

// ---- Pitch spelling ----
//
// Not full key-signature-aware engraving (that is real, solved complexity —
// see the VexFlow note in the plan). This is a sharp-keys/flat-keys
// heuristic: good enough to print a sensible-looking accidental, not a
// substitute for a music theory engine.
const SHARP_KEYS = new Set(["C", "G", "D", "A", "E", "B", "F#", "C#"]);
const FLAT_KEYS = new Set(["F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"]);
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const LETTER_STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

// staffStep is a diatonic count (one per letter name, ignoring accidentals)
// from C in octave 0 — the vertical unit the renderer places noteheads with,
// so a C# and a Db at the same pitch still sit on the same line or space.
export function spellNote(midi, keyRoot = "C") {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  const useFlats = FLAT_KEYS.has(keyRoot) && !SHARP_KEYS.has(keyRoot);
  const name = useFlats ? FLAT_NAMES[pc] : SHARP_NAMES[pc];
  const letter = name[0];
  const accidental = name.length > 1 ? name[1] : "";
  const octave = Math.floor(midi / 12) - 1;
  return { letter, accidental, octave, name: `${letter}${octave}`, staffStep: octave * 7 + LETTER_STEP[letter] };
}

// The inverse of spellNote's staffStep: which pitch sits on a given line or
// space. The editor needs this to turn a click on the staff into a note —
// a staff position is diatonic, so this always lands on the natural of that
// letter, and altering it to a sharp/flat is a separate step (arrow keys).
const LETTER_SEMITONE = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B

export function midiFromStaffStep(staffStep) {
  const step = Math.round(staffStep);
  const octave = Math.floor(step / 7);
  const letterIndex = step - octave * 7;
  return Math.max(0, Math.min(127, (octave + 1) * 12 + LETTER_SEMITONE[letterIndex]));
}

// ---- Guitar tab ----

const MAX_FRET = 15;

// Prefers the fret closest to the previous hand position, then the lowest
// fret, then the lowest (thickest) string — least movement first, which is
// the same thing a player reading a line actually does.
export function autoTabPosition(midi, prevFret = null) {
  let best = null;
  for (let stringIdx = 0; stringIdx < OPEN_MIDI.length; stringIdx += 1) {
    const fret = midi - OPEN_MIDI[stringIdx];
    if (fret < 0 || fret > MAX_FRET) continue;
    const distance = prevFret === null ? fret : Math.abs(fret - prevFret);
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && fret < best.fret) ||
      (distance === best.distance && fret === best.fret && stringIdx < best.stringIdx)
    ) {
      best = { stringIdx, fret, distance };
    }
  }
  return best ? { stringIdx: best.stringIdx, fret: best.fret } : null;
}

// Mutates notes in place, filling in string/fret where the note has none —
// a manually-set position (dragged in the editor) is left untouched, exactly
// like `validBarres` leaves a played barre alone until its frets change.
export function assignTab(melody) {
  let prevFret = null;
  (melody.events || []).forEach((event) => {
    if (event.rest) return;
    (event.notes || []).forEach((note) => {
      if (note.manualTab && Number.isInteger(note.fret) && Number.isInteger(note.stringIdx)) {
        prevFret = note.fret;
        return;
      }
      const pos = autoTabPosition(note.midi, prevFret);
      if (pos) {
        note.stringIdx = pos.stringIdx;
        note.fret = pos.fret;
        prevFret = pos.fret;
      }
    });
  });
  return melody;
}

// ---- Playback ----
//
// tempo is quarter notes per minute, so a quarter (TICKS_PER_WHOLE/4 ticks)
// takes 60000/tempo ms.
export function melodyPlaybackSchedule(melody) {
  const tempo = Number(melody.tempo) > 0 ? Number(melody.tempo) : 96;
  const msPerTick = 60000 / tempo / (TICKS_PER_WHOLE / 4);
  const schedule = [];
  let atMs = 0;
  (melody.events || []).forEach((event) => {
    const durationMs = durationTicks(event.den, event.dots || 0) * msPerTick;
    if (!event.rest && event.notes && event.notes.length) {
      schedule.push({ atMs, midis: event.notes.map((n) => n.midi), durationMs });
    }
    atMs += durationMs;
  });
  return schedule;
}
