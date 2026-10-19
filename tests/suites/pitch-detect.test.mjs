// pitch-detect.js is pure, so it is tested against synthetic buffers with
// known answers — no microphone, no browser.
//
// The failure that matters for a singer is not a few cents of error but an
// octave jump, so the harmonic-rich case (a fundamental quieter than its
// overtones, which is what a sung vowel looks like) is the important one.
import {
  detectPitch,
  freqToMidi,
  centsOff,
  noteName,
  createSmoother,
} from "../../pitch-detect.js";

export const name = "Pitch detection";
export const needsBrowser = false;

const WINDOW = 2048;

function wave(freq, sampleRate, partials = [1], amp = 0.5) {
  const out = new Float32Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) {
    let v = 0;
    partials.forEach((a, k) => {
      v += a * Math.sin((2 * Math.PI * freq * (k + 1) * i) / sampleRate + k);
    });
    out[i] = amp * v;
  }
  return out;
}

const cents = (f, ref) => 1200 * Math.log2(f / ref);

// Deterministic noise: a test that fails one run in fifty is worse than none.
function noise(seed, amp = 0.3) {
  let s = seed;
  const out = new Float32Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = amp * (s / 2 ** 32 - 0.5) * 2;
  }
  return out;
}

export default async function run({ t }) {
  for (const sr of [44100, 48000]) {
    for (const f of [82.41, 110, 220, 261.63, 440, 440 * 2 ** (23 / 1200), 987.77]) {
      const r = detectPitch(wave(f, sr), sr);
      t.ok(`sine ${f.toFixed(2)} Hz @ ${sr} is voiced`, r, "null");
      if (r) t.near(`sine ${f.toFixed(2)} Hz @ ${sr} within 2 cents`, cents(r.freq, f), 0, 2, "¢");
    }
  }

  // Overtones louder than the fundamental: the period still is the
  // fundamental's, and naive autocorrelation reports an octave up here.
  for (const f of [110, 196, 330]) {
    const r = detectPitch(wave(f, 48000, [0.3, 1, 0.8, 0.6, 0.3]), 48000);
    t.ok(`weak fundamental ${f} Hz is voiced`, r, "null");
    if (r) t.near(`weak fundamental ${f} Hz is not an octave out`, cents(r.freq, f), 0, 5, "¢");
  }

  t.ok("silence is unvoiced", detectPitch(new Float32Array(WINDOW), 48000) === null);
  t.ok("a whisper under the gate is unvoiced", detectPitch(wave(220, 48000, [1], 0.002), 48000) === null);
  for (const seed of [1, 2, 3]) {
    const r = detectPitch(noise(seed), 48000);
    t.ok(`white noise (seed ${seed}) is unvoiced`, r === null, r && `${r.freq} Hz clarity ${r.clarity}`);
  }
  // A real laptop microphone with auto-gain off: singing arrives this quiet.
  const quiet = detectPitch(wave(220, 48000, [0.6, 1, 0.5], 0.006), 48000);
  t.ok("a voice at -45 dBFS is still tracked", quiet && Math.abs(cents(quiet.freq, 220)) < 5, quiet && quiet.freq);
  for (const seed of [4, 5]) {
    const r = detectPitch(noise(seed, 0.01), 48000);
    t.ok(`quiet room noise (seed ${seed}) is unvoiced`, r === null, r && `${r.freq} Hz clarity ${r.clarity}`);
  }
  t.ok(
    "a pitch above the range is rejected",
    detectPitch(wave(2000, 48000), 48000) === null
  );

  // --- note arithmetic ---
  t.near("A4 is MIDI 69", freqToMidi(440), 69, 1e-9);
  t.near("middle C is MIDI 60", freqToMidi(261.6256), 60, 1e-4);
  t.near("a quarter-tone sharp of A is +50 cents", centsOff(69.5 - 1e-9), 50, 1e-6);
  t.near("slightly flat of A is negative", centsOff(68.8), -20, 1e-9);
  t.ok("60 is C4", JSON.stringify(noteName(60)) === '{"name":"C","octave":4}');
  t.ok("57 is A3", noteName(57).name === "A" && noteName(57).octave === 3);
  t.ok("70 spells as A# or Bb", noteName(70).name === "A#" && noteName(70, true).name === "Bb");
  t.ok("59 is B3, not B4", noteName(59).octave === 3);

  // --- smoother ---
  const s = createSmoother(3);
  s.push(57);
  s.push(57.1);
  t.ok("a one-frame octave spike is dropped", s.push(69) === 57.1);
  t.ok("an unvoiced frame breaks the line", s.push(null) === null);
  t.ok("history restarts after a gap", s.push(60) === 60);
}
