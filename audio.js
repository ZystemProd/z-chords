// audio.js — the app's single Web Audio context and note playback.
//
// Browsers cap how many AudioContexts a page may open, so everything that
// makes sound goes through getAudioContext() rather than constructing its own.
// The metronome and chord playback both live off this one context.

let ctx = null;
let master = null;
let activeVoices = [];

// A context created outside a user gesture starts suspended. Every entry point
// that makes sound calls resumeAudio() first; browsers only honour it when a
// real gesture is on the stack, which is why playback is wired to clicks.
export function getAudioContext() {
  if (ctx) return ctx;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  ctx = new AudioCtx();
  return ctx;
}

export function resumeAudio() {
  const audioCtx = getAudioContext();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// Master chain for chord playback: a compressor catches the peaks when six or
// seven voices line up in phase, which a plain gain stage cannot. The metronome
// deliberately does not run through this — it connects straight to the
// destination so its level stays exactly as it was.
function getMaster(audioCtx) {
  if (master) return master;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.9;
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 12;
  comp.ratio.value = 6;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  gain.connect(comp);
  comp.connect(audioCtx.destination);
  master = gain;
  return master;
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Fade out whatever is still ringing. Used when a new chord is triggered so
// clicking through cards stays crisp instead of piling voices on top of a mush.
export function stopAll(fadeSeconds = 0.06) {
  const audioCtx = ctx;
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  activeVoices.forEach(({ osc, gain }) => {
    try {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.00001), now);
      gain.gain.exponentialRampToValueAtTime(0.00001, now + fadeSeconds);
      osc.stop(now + fadeSeconds + 0.01);
    } catch (_) {
      // Voice already stopped; nothing to unwind.
    }
  });
  activeVoices = [];
}

/**
 * Play MIDI note numbers together as one chord.
 *
 * Chord data is MIDI throughout the app — parsed symbols and the custom-chord
 * modal's `customMIDIs` alike — so both feed straight in with no branching.
 */
export function playNotes(midis, options = {}) {
  const notes = (midis || []).filter((m) => typeof m === "number" && isFinite(m));
  if (!notes.length) return;

  const audioCtx = resumeAudio();
  if (!audioCtx) return;

  const {
    duration = 1.4,
    velocity = 0.9,
    type = "triangle", // softer than sawtooth, richer than sine
    retrigger = true,
    brightness = 1, // scales the filter cutoff; < 1 is darker, > 1 brighter
  } = options;

  if (retrigger) stopAll();

  const out = getMaster(audioCtx);
  const now = audioCtx.currentTime;

  // Divide by voice count so a 7-note 13th chord is not seven times louder
  // than a triad. exponentialRamp cannot reach 0, hence the small floor.
  const peak = Math.max((velocity * 0.5) / notes.length, 0.02);
  const FLOOR = 0.00001;

  notes.forEach((midi, i) => {
    const freq = midiToFreq(midi);

    const osc = audioCtx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;

    // Low-pass per voice rather than one across the mix, so the cutoff can
    // track pitch. A fixed cutoff would leave a bass note muddy and a treble
    // note still shrill; tracking keeps the timbre even across the keyboard.
    const filter = audioCtx.createBiquadFilter();
    filter.type = "lowpass";
    // Q stays flat on purpose. Resonance would add a peak at the cutoff, which
    // is extra edge -- the opposite of what softening this is meant to do.
    filter.Q.value = 0.7;

    // Keep roughly the first HARMONICS partials and roll off above. Clamped so
    // low notes keep enough body to be audible and high notes cannot creep
    // back into the harsh region.
    //
    // Three, not the seven this started at. A triangle's harmonics fall off as
    // 1/n^2, so a cutoff up at the 7th partial only attenuated content already
    // sitting near 1% of the fundamental -- measured, it changed the rendered
    // spectrum by well under a percent. Cutting at the 3rd is what actually
    // takes the edge off, because it reaches the 5th and 7th partials in the
    // 1-2 kHz band the ear is most sensitive to.
    const HARMONICS = 3;
    const cutoff = Math.min(
      Math.max(freq * HARMONICS * brightness, 350),
      6000
    );

    const gain = audioCtx.createGain();
    // A few ms of spread top to bottom: a chord struck by a hand is never
    // perfectly simultaneous, and the stagger keeps it from sounding synthetic.
    const start = now + i * 0.004;

    // Filter envelope: a touch brighter during the attack, closing as the note
    // decays. That downward drift is what a struck string does as it damps,
    // and it is most of why this reads as "soft" rather than merely "muffled".
    filter.frequency.setValueAtTime(Math.min(cutoff * 1.6, 8000), start);
    filter.frequency.exponentialRampToValueAtTime(cutoff, start + 0.18);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(cutoff * 0.6, 300),
      start + duration
    );

    gain.gain.setValueAtTime(FLOOR, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.012); // attack
    gain.gain.exponentialRampToValueAtTime(peak * 0.55, start + 0.32); // decay
    gain.gain.exponentialRampToValueAtTime(FLOOR, start + duration); // release

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    osc.start(start);
    osc.stop(start + duration + 0.05);

    const voice = { osc, gain };
    activeVoices.push(voice);
    osc.onended = () => {
      activeVoices = activeVoices.filter((v) => v !== voice);
      try {
        gain.disconnect();
        filter.disconnect();
      } catch (_) {
        // Already torn down.
      }
    };
  });
}
