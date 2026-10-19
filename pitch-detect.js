// pitch-detect.js — monophonic pitch detection for the Voice tab.
//
// Pure: takes samples, returns numbers. No DOM, no Web Audio, so it is tested
// directly in Node against synthetic buffers (tests/suites/pitch-detect).
//
// The detector is the McLeod Pitch Method (McLeod & Wyvill, "A smarter way to
// find pitch", 2005). Plain autocorrelation is the obvious choice and the wrong
// one for a voice: it has a peak at every multiple of the period, and when a
// harmonic is louder than the fundamental — normal for a sung vowel — it picks
// the wrong one and the trace jumps an octave. MPM normalises the correlation
// (NSDF, values in -1..1) and takes the *first* peak that comes close to the
// highest, which is the fundamental rather than whichever multiple happens to
// correlate best.

import { NOTES } from "./theory.js";

export const DEFAULT_OPTIONS = {
  // C2..D6 — beyond the range of any singer, with room to spare.
  minFreq: 60,
  maxFreq: 1200,
  // Below this RMS (≈ -50 dBFS) the frame is silence. Deliberately low: with
  // the browser's auto-gain turned off, a laptop microphone delivers ordinary
  // singing at -45..-30 dBFS, and a gate at -40 swallowed real voices whole.
  // Noise that gets past it is still rejected by the clarity gate.
  rmsGate: 0.003,
  // NSDF peak height required to call a frame voiced. Breath and consonants
  // correlate weakly, so they fall under it and the trace breaks there.
  clarityGate: 0.75,
  // A peak within this fraction of the highest one counts. The fundamental's
  // peak is often slightly lower than a later multiple's, so "the highest" is
  // the octave error MPM exists to avoid.
  peakThreshold: 0.9,
};

// Returns { freq, clarity } or null for an unvoiced / silent frame.
export function detectPitch(samples, sampleRate, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const n = samples.length;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i] - mean;
    energy += v * v;
  }
  if (Math.sqrt(energy / n) < o.rmsGate) return null;

  // Peaks are picked at every lag, including periods shorter than maxFreq
  // allows, and the range is checked on the answer. Searching only from the
  // shortest allowed lag would land on a *multiple* of a too-short period and
  // report a pitch above the range as one an octave or two lower, in range.
  // Half the window at most: past that the overlap is too short to trust.
  const maxLag = Math.min(Math.ceil(sampleRate / o.minFreq), Math.floor(n / 2));
  if (maxLag < 4) return null;

  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = samples[i] - mean;

  // NSDF over lags 0..maxLag+1 (one extra so the last peak can be interpolated).
  //
  // The autocorrelation comes from an FFT (Wiener–Khinchin) and the
  // normalising energy term is updated incrementally. The direct double loop
  // is about 2M multiply-adds a frame — 4ms, a quarter of a core at 60fps —
  // where this is a fraction of a millisecond.
  const top = Math.min(maxLag + 1, n - 1);
  const acf = autocorrelation(x);
  const nsdf = new Float32Array(top + 1);
  let m = 2 * acf[0];
  for (let tau = 0; tau <= top; tau++) {
    if (tau > 0) m -= x[tau - 1] * x[tau - 1] + x[n - tau] * x[n - tau];
    nsdf[tau] = m > 1e-12 ? (2 * acf[tau]) / m : 0;
  }

  // Key maxima: the highest point of each positive lobe after the first
  // negative-going zero crossing (the lobe around lag 0 is the signal matching
  // itself and says nothing about the period).
  const peaks = [];
  let tau = 1;
  while (tau <= top && nsdf[tau] > 0) tau++;
  while (tau <= top) {
    while (tau <= top && nsdf[tau] <= 0) tau++;
    let best = -1;
    while (tau <= top && nsdf[tau] > 0) {
      if (best < 0 || nsdf[tau] > nsdf[best]) best = tau;
      tau++;
    }
    if (best > 0 && best < top) peaks.push(best);
  }
  if (!peaks.length) return null;

  let highest = 0;
  for (const p of peaks) highest = Math.max(highest, nsdf[p]);
  const chosen = peaks.find((p) => nsdf[p] >= o.peakThreshold * highest);

  // Parabolic interpolation through the peak and its neighbours: the period
  // is rarely a whole number of samples, and rounding it would quantise the
  // pitch to steps of several cents in the upper range.
  const y0 = nsdf[chosen - 1];
  const y1 = nsdf[chosen];
  const y2 = nsdf[chosen + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  const period = chosen + shift;
  const clarity = y1 - 0.25 * (y0 - y2) * shift;

  if (clarity < o.clarityGate) return null;
  const freq = sampleRate / period;
  if (freq < o.minFreq || freq > o.maxFreq) return null;
  return { freq, clarity };
}

// Linear (not circular) autocorrelation of `x` for every lag, via a
// zero-padded FFT: |FFT(x)|² inverse-transformed is the autocorrelation, and
// padding to at least twice the length keeps the wrap-around out of it.
function autocorrelation(x) {
  const n = x.length;
  let size = 1;
  while (size < 2 * n) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(x);
  fft(re, im, false);
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft(re, im, true);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = re[i] / size;
  return out;
}

const twiddles = new Map();

// In-place iterative radix-2 FFT. `size` is a power of two. The inverse is
// unscaled; the caller divides.
function fft(re, im, inverse) {
  const size = re.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  let tw = twiddles.get(size);
  if (!tw) {
    tw = { cos: new Float64Array(size / 2), sin: new Float64Array(size / 2) };
    for (let i = 0; i < size / 2; i++) {
      tw.cos[i] = Math.cos((2 * Math.PI * i) / size);
      tw.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
    twiddles.set(size, tw);
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= size; len <<= 1) {
    const half = len >> 1;
    const step = size / len;
    for (let start = 0; start < size; start += len) {
      for (let k = 0; k < half; k++) {
        const c = tw.cos[k * step];
        const s = sign * tw.sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

export function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

// Cents from the nearest equal-tempered note, -50..+50.
export function centsOff(midi) {
  return (midi - Math.round(midi)) * 100;
}

const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

// { name, octave } for an integer MIDI note. `flats` picks the spelling of the
// five black keys; scientific octave numbering, so 60 is C4.
export function noteName(midi, flats = false) {
  const pc = ((midi % 12) + 12) % 12;
  return { name: (flats ? FLAT_NAMES : NOTES)[pc], octave: Math.floor(midi / 12) - 1 };
}

// A short running median over voiced frames. One frame in a sung note is
// occasionally an octave out (a consonant, a crack); a median of three drops
// it without the lag of a longer window, which would also iron out vibrato —
// and vibrato is something a singer wants to see. An unvoiced frame clears the
// history, so the line breaks at a gap instead of bridging two notes.
export function createSmoother(size = 3) {
  let history = [];
  return {
    push(value) {
      if (value == null) {
        history = [];
        return null;
      }
      history.push(value);
      if (history.length > size) history.shift();
      const sorted = [...history].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    },
    reset() {
      history = [];
    },
  };
}
