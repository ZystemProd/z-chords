// pitch-monitor.js — the Voice → Pitch tab: a live pitch graph for singers,
// with record / stop / play so a take can be heard back against its line.
//
// Owns #pitchPanel and #pitchControls and nothing else. script.js only shows
// and stops it from updateTabsUI(); the detector is pitch-detect.js, which is
// pure and tested on its own.
//
// Privacy: a take lives in memory only. Nothing is written to storage, the
// cloud or a song file, and the microphone is released on Stop and whenever
// the tab is left — not merely muted, so the browser's recording indicator
// goes off too.

import { getAudioContext, resumeAudio } from "./audio.js";
import {
  detectPitch,
  freqToMidi,
  centsOff,
  noteName,
  createSmoother,
  DEFAULT_OPTIONS,
} from "./pitch-detect.js";
import { SCALE_FORMULAS, noteIndex } from "./theory.js";

const SETTINGS_KEY = "cv-pitch-settings";
const DEFAULT_SETTINGS = { range: "follow", window: 10, key: "C", tolerance: 15 };

// Fixed ranges per voice type, as MIDI [low, high]. Follow tracks the voice.
const RANGES = {
  follow: null,
  bass: [40, 64], // E2–E4
  baritone: [43, 67], // G2–G4
  tenor: [48, 72], // C3–C5
  alto: [53, 77], // F3–F5
  soprano: [60, 84], // C4–C6
};
const FOLLOW_SPAN = 12;
const WINDOWS = [5, 10, 20];
// How close to a note, in cents, counts as in tune. 15 is a common choice for
// singers; 10 is strict, 25 forgiving.
const TOLERANCES = [10, 15, 25];
// Keys whose notes are spelled with flats; everything else uses sharps.
const FLAT_KEYS = new Set(["F", "Bb", "Eb", "Ab", "Db", "Gb"]);
const KEYS = ["C", "G", "D", "A", "E", "B", "F#", "F", "Bb", "Eb", "Ab", "Db"];

// Analysis window: ~43ms at 48kHz. Long enough for two periods of a low E2,
// short enough that a note change shows up within a frame or two.
const FFT_SIZE = 2048;
// A point older than this with nothing after it is a gap, not a held note.
const GAP_S = 0.15;
// Below this for three seconds, the input is treated as dead (≈ -66 dBFS).
const NO_SIGNAL_RMS = 0.0005;

// Canvas layout, in CSS px. A piano-roll: a keyboard down the left edge and
// one lane per semitone across the graph, so a sung note sits in the lane of
// its key. The readout card and the transport are DOM overlays.
const KEYBOARD_W = 78;
const GRAPH_PAD_Y = 8;
// "Now" sits this far in from the right edge, so the head dot is not clipped.
const HEAD_INSET = 18;

let els = null;
let settings = { ...DEFAULT_SETTINGS };
let colors = null;

// "idle" | "recording" | "paused" | "playing"
let state = "idle";
// { points: [{ t, m }], duration, buffer: AudioBuffer | null }
let take = null;
// The right edge of the graph, in seconds into the take.
let playhead = 0;
// Live microphone graph and recorder, while recording or paused.
let mic = null;
// Recording clock: seconds recorded before the last resume, and when it resumed.
let rec = null;
// Playback: { source, startedAt, from }.
let play = null;
let raf = 0;
let view = { lo: 52, hi: 64 };
// The pitch the readout and ruler show: live while recording, from the take
// while playing or scrubbing. The ruler eases toward it so it does not jitter.
let current = null;
// What the note name, cents and ruler show. Deliberately calmer than the
// trace: the trace is the evidence and should show every wobble, but a
// readout that changes every frame cannot be read. Three layers:
//   - the pitch is eased with a time constant (frame-rate independent),
//   - the note name has hysteresis: it only changes once the pitch is more
//     than NOTE_HYSTERESIS semitones from the note shown, so vibrato across a
//     semitone boundary does not flicker between two names,
//   - a short gap (a breath, a consonant) holds the last note, dimmed,
//     instead of blanking it.
const READOUT_TAU = 0.2;
const NOTE_HYSTERESIS = 0.62;
const HOLD_S = 0.6;
let readout = { midi: 57, note: null, cents: null, inTune: false, lastVoiced: -Infinity, lastFrame: 0 };
// Input level (RMS, decaying), shown as a meter while recording.
let level = 0;
let size = { w: 0, h: 0 };
let geometryKey = "";
// The graph rectangle as last drawn, for hit-testing clicks on the keyboard.
let geom = null;
// Target notes the singer is aiming for, picked by clicking keys. View state:
// kept while the page is open, never stored.
const targets = new Set();
// Key geometry, shared by drawing and hit-testing so a click lands on the
// key that is drawn there.
const KEY_X = 10;
const KEY_W_WHITE = KEYBOARD_W - KEY_X - 6;
const KEY_W_BLACK = Math.round(KEY_W_WHITE * 0.6);

export function initPitchMonitor() {
  const panel = document.getElementById("pitchPanel");
  if (!panel) return;
  els = {
    panel,
    display: panel.querySelector(".pitch-display"),
    canvas: document.getElementById("pitchCanvas"),
    note: document.getElementById("pitchNote"),
    status: document.getElementById("pitchStatus"),
    stop: document.getElementById("pitchStop"),
    record: document.getElementById("pitchRecord"),
    play: document.getElementById("pitchPlay"),
    range: document.getElementById("pitchRange"),
    window: document.getElementById("pitchWindow"),
    key: document.getElementById("pitchKey"),
    tolerance: document.getElementById("pitchTolerance"),
    card: document.getElementById("pitchCard"),
    cents: document.getElementById("pitchCents"),
    zone: document.getElementById("pitchZone"),
    marker: document.getElementById("pitchMarker"),
  };

  loadSettings();
  els.range.value = settings.range;
  els.window.value = String(settings.window);
  els.key.value = settings.key;
  els.tolerance.value = String(settings.tolerance);

  els.range.addEventListener("change", () => updateSetting("range", els.range.value));
  els.window.addEventListener("change", () => updateSetting("window", Number(els.window.value)));
  els.key.addEventListener("change", () => updateSetting("key", els.key.value));
  els.tolerance.addEventListener("change", () => updateSetting("tolerance", Number(els.tolerance.value)));

  els.record.addEventListener("click", onRecord);
  els.stop.addEventListener("click", onStop);
  els.play.addEventListener("click", onPlay);

  wireScrubbing();

  // A canvas cannot read CSS, so the theme reaches it by re-reading the
  // custom properties whenever the body's theme class changes.
  new MutationObserver(() => {
    colors = null;
    draw();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  new ResizeObserver(() => {
    resizeCanvas();
    draw();
  }).observe(els.display);

  updateTransport();
  setStatus(idleStatus());
}

// Called by updateTabsUI when the tab comes on screen.
export function showPitchMonitor() {
  if (!els) return;
  resizeCanvas();
  draw();
}

// Called by updateTabsUI whenever Voice → Pitch is not on screen. Releases the
// microphone and stops playback; the take itself is kept, so wandering to
// another tab and back does not lose it.
export function stopPitchMonitor() {
  if (!els) return;
  if (state === "recording" || state === "paused") finishRecording();
  else if (state === "playing") pausePlayback();
}

// --- settings --------------------------------------------------------------

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (saved && typeof saved === "object") {
      if (saved.range in RANGES) settings.range = saved.range;
      if (WINDOWS.includes(saved.window)) settings.window = saved.window;
      if (KEYS.includes(saved.key)) settings.key = saved.key;
      if (TOLERANCES.includes(saved.tolerance)) settings.tolerance = saved.tolerance;
    }
  } catch (_) {}
}

function updateSetting(name, value) {
  settings[name] = value;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {}
  draw();
}

// --- transport -------------------------------------------------------------

async function onRecord() {
  if (state === "recording") return pauseRecording();
  if (state === "paused") return resumeRecording();
  if (state === "playing") pausePlayback();
  await startRecording();
}

function onStop() {
  if (state === "recording" || state === "paused") finishRecording();
  else if (state === "playing") {
    pausePlayback();
    // Stop returns to the overview: the end of the take, with its whole tail
    // on screen. Pause (the play button) is the one that keeps your place.
    playhead = take ? take.duration : 0;
    current = take ? pitchAt(playhead) : null;
    draw();
  }
}

function onPlay() {
  if (!take || state === "recording" || state === "paused") return;
  if (state === "playing") pausePlayback();
  else startPlayback(playhead);
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("The microphone needs a secure page (https or localhost).", true);
    return;
  }
  // Resumed inside the click: iOS Safari only allows it from a gesture.
  const audioCtx = resumeAudio();
  if (!audioCtx) {
    setStatus("This browser has no Web Audio support.", true);
    return;
  }
  let stream;
  try {
    // All three processing stages are on by default and all three are tuned
    // for speech on a call: they reshape the very signal being measured.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    setStatus(micErrorMessage(e), true);
    return;
  }

  // The context may still be starting; a suspended one has a frozen clock and
  // an analyser that reads only zeros, which looks exactly like "no voice".
  try {
    await audioCtx.resume();
  } catch (_) {}

  let graph;
  try {
    graph = buildAnalysis(audioCtx, stream);
  } catch (e) {
    // Firefox refuses to connect a microphone whose sample rate differs from
    // the context's ("NotSupportedError"). Analysing in a context created at
    // the microphone's own rate is the one way round it.
    try {
      const rate = stream.getAudioTracks()[0]?.getSettings?.().sampleRate;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const own = new Ctx(rate ? { sampleRate: rate } : undefined);
      await own.resume();
      graph = buildAnalysis(own, stream);
      graph.ownContext = true;
    } catch (e2) {
      stream.getTracks().forEach((track) => track.stop());
      console.error("pitch monitor: could not analyse the microphone", e, e2);
      setStatus(`The microphone could not be analysed (${e2?.name || e?.name || "error"}).`, true);
      return;
    }
  }
  const { ctx: clock, source, analyser, sink } = graph;

  let recorder = null;
  const chunks = [];
  if (typeof MediaRecorder !== "undefined") {
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
      (t) => MediaRecorder.isTypeSupported?.(t)
    );
    try {
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start();
    } catch (_) {
      recorder = null;
    }
  }

  mic = {
    stream, source, analyser, sink, recorder, chunks,
    ctx: clock,
    ownContext: !!graph.ownContext,
    buf: new Float32Array(FFT_SIZE),
  };
  rec = { offset: 0, startedAt: clock.currentTime, smoother: createSmoother(3), quietSince: clock.currentTime };
  take = { points: [], duration: 0, buffer: null };
  playhead = 0;
  current = null;
  level = 0;
  state = "recording";
  updateTransport();
  setStatus("Recording — sing, and watch the line.");
  startLoop();
}

// Microphone → analyser → silent gain → destination. The analyser is never
// audible (gain 0, so no feedback), but it is connected: Safari only pulls
// audio through nodes that lead to the destination, and an unconnected
// analyser there reads silence forever.
function buildAnalysis(audioCtx, stream) {
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  const sink = audioCtx.createGain();
  sink.gain.value = 0;
  source.connect(analyser);
  analyser.connect(sink);
  sink.connect(audioCtx.destination);
  return { ctx: audioCtx, source, analyser, sink };
}

function recordedSeconds() {
  return rec.offset + (mic.ctx.currentTime - rec.startedAt);
}

function pauseRecording() {
  rec.offset = recordedSeconds();
  // An explicit break, so the line does not join across the pause.
  take.points.push({ t: rec.offset, m: null });
  rec.smoother.reset();
  if (mic.recorder?.state === "recording") mic.recorder.pause();
  state = "paused";
  current = null;
  updateTransport();
  setStatus("Paused. Record continues the take; stop ends it.");
  stopLoop();
  draw();
}

function resumeRecording() {
  rec.startedAt = mic.ctx.currentTime;
  rec.quietSince = mic.ctx.currentTime;
  if (mic.recorder?.state === "paused") mic.recorder.resume();
  state = "recording";
  updateTransport();
  setStatus("Recording — sing, and watch the line.");
  startLoop();
}

function finishRecording() {
  if (state === "recording") rec.offset = recordedSeconds();
  take.duration = rec.offset;
  playhead = take.duration;
  const { recorder, chunks, stream, source, sink, ctx: clock, ownContext } = mic;
  const finished = take;
  if (recorder && recorder.state !== "inactive") {
    recorder.onstop = () => decodeTake(finished, chunks, recorder.mimeType);
    recorder.stop();
  }
  source.disconnect();
  sink.disconnect();
  stream.getTracks().forEach((track) => track.stop());
  if (ownContext) clock.close().catch(() => {});
  mic = null;
  rec = null;
  level = 0;
  state = "idle";
  current = pitchAt(playhead);
  stopLoop();
  updateTransport();
  const voiced = take.points.some((p) => p.m != null);
  setStatus(
    take.duration <= 0.2
      ? idleStatus()
      : voiced
        ? "Take recorded. Press play to hear it, or drag the graph to scrub."
        : "Take recorded, but no pitch was found in it. Check the level meter while you sing.",
    take.duration > 0.2 && !voiced
  );
  draw();
}

// Decoded once into an AudioBuffer rather than played through an <audio>
// element: a MediaRecorder WebM carries no duration or seek index, so seeking
// it is unreliable, while a buffer source starts at any offset exactly and
// shares the clock the trace is drawn against.
async function decodeTake(target, chunks, mimeType) {
  try {
    const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
    const data = await blob.arrayBuffer();
    const buffer = await getAudioContext().decodeAudioData(data);
    if (take === target) target.buffer = buffer;
  } catch (_) {
    if (take === target)
      setStatus("The audio could not be decoded; play replays the line without sound.", true);
  }
}

function startPlayback(from) {
  const audioCtx = resumeAudio();
  if (!audioCtx || !take) return;
  if (from >= take.duration - 0.05) from = 0;
  let source = null;
  if (take.buffer) {
    source = audioCtx.createBufferSource();
    source.buffer = take.buffer;
    source.connect(audioCtx.destination);
    source.start(0, Math.min(from, take.buffer.duration));
  }
  play = { source, startedAt: audioCtx.currentTime, from };
  playhead = from;
  state = "playing";
  updateTransport();
  startLoop();
}

function pausePlayback() {
  if (play) {
    playhead = playbackPosition();
    try {
      play.source?.stop();
    } catch (_) {}
    play.source?.disconnect();
  }
  play = null;
  state = "idle";
  updateTransport();
  stopLoop();
  draw();
}

function playbackPosition() {
  return Math.min(
    take.duration,
    play.from + (getAudioContext().currentTime - play.startedAt)
  );
}

function updateTransport() {
  if (!els) return;
  const recording = state === "recording";
  const paused = state === "paused";
  const playing = state === "playing";
  els.panel.dataset.state = state;

  els.record.classList.toggle("is-recording", recording);
  els.record.setAttribute("aria-pressed", String(recording));
  els.record.setAttribute(
    "aria-label",
    recording ? "Pause recording" : paused ? "Resume recording" : "Record"
  );
  els.record.title = els.record.getAttribute("aria-label");
  setLabel(els.record, recording ? `Recording ${clock(take.duration)}` : paused ? "Resume" : "Record");

  els.stop.disabled = !(recording || paused || playing);

  els.play.disabled = !take || take.duration <= 0 || recording || paused;
  els.play.classList.toggle("is-playing", playing);
  els.play.setAttribute("aria-label", playing ? "Pause playback" : "Play take");
  els.play.title = els.play.getAttribute("aria-label");
  setLabel(els.play, playing ? "Pause" : "Play");
}

function setLabel(button, text) {
  const label = button.querySelector(".pitch-btn-label");
  if (label && label.textContent !== text) label.textContent = text;
}

function clock(seconds) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function setStatus(text, isError = false) {
  if (!els) return;
  els.status.textContent = text;
  els.status.classList.toggle("is-error", isError);
}

function idleStatus() {
  return "Press record and sing. The line shows your pitch against the notes.";
}

function micErrorMessage(e) {
  if (e?.name === "NotAllowedError" || e?.name === "SecurityError")
    return "Microphone access was blocked. Allow it in the browser's site settings and press record again.";
  if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError")
    return "No microphone was found.";
  return `The microphone could not be started (${e?.name || "unknown error"}).`;
}

// --- the frame loop --------------------------------------------------------

function startLoop() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function frame() {
  raf = 0;
  if (state === "recording") {
    sample();
  } else if (state === "playing") {
    playhead = playbackPosition();
    current = pitchAt(playhead);
    if (playhead >= take.duration) {
      pausePlayback();
      return;
    }
  } else {
    return;
  }
  draw(true);
  raf = requestAnimationFrame(frame);
}

function sample() {
  mic.analyser.getFloatTimeDomainData(mic.buf);
  let sum = 0;
  for (let i = 0; i < mic.buf.length; i++) sum += mic.buf[i] * mic.buf[i];
  const rms = Math.sqrt(sum / mic.buf.length);
  // Fast attack, slow release, so the meter is readable rather than flicker.
  level = Math.max(rms, level * 0.92);
  // Sustained near-silence almost always means the wrong input device or a
  // muted microphone, not a quiet singer — say so instead of drawing nothing.
  if (rms > NO_SIGNAL_RMS) rec.quietSince = mic.ctx.currentTime;
  else if (mic.ctx.currentTime - rec.quietSince > 3 && !els.status.classList.contains("is-error"))
    setStatus("No sound is reaching the microphone. Check the input device and that it isn't muted.", true);
  if (rms > NO_SIGNAL_RMS && els.status.classList.contains("is-error"))
    setStatus("Recording — sing, and watch the line.");

  const hit = detectPitch(mic.buf, mic.ctx.sampleRate);
  const m = rec.smoother.push(hit ? freqToMidi(hit.freq) : null);
  const t = recordedSeconds();
  take.points.push({ t, m });
  take.duration = t;
  playhead = t;
  current = m;
  setLabel(els.record, `Recording ${clock(t)}`);
}

// The take's pitch at time `t`, or null in a gap.
function pitchAt(t) {
  const pts = take?.points;
  if (!pts?.length) return null;
  const i = lastIndexAtOrBefore(pts, t);
  if (i < 0) return null;
  const p = pts[i];
  return p.m != null && t - p.t <= GAP_S ? p.m : null;
}

function lastIndexAtOrBefore(pts, t) {
  let lo = 0;
  let hi = pts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// --- scrubbing ---------------------------------------------------------------

// Dragging the graph moves the playhead through a finished take, like
// dragging a strip of tape: drag right to go back in time. Arrow keys step a
// second, Space plays or pauses.
function wireScrubbing() {
  const canvas = els.canvas;
  let drag = null;

  canvas.addEventListener("pointerdown", (e) => {
    // The keyboard picks targets; only the graph scrubs.
    if (e.offsetX < KEYBOARD_W) {
      const m = keyAt(e.offsetX, e.offsetY);
      if (m != null) toggleTarget(m);
      return;
    }
    if (!take || take.duration <= 0 || state === "recording" || state === "paused") return;
    const wasPlaying = state === "playing";
    if (wasPlaying) pausePlayback();
    drag = { x: e.clientX, from: playhead, wasPlaying };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("is-scrubbing");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) {
      canvas.classList.toggle("over-keys", e.offsetX < KEYBOARD_W);
      return;
    }
    const graphW = Math.max(1, size.w - KEYBOARD_W - HEAD_INSET);
    const dt = ((e.clientX - drag.x) / graphW) * settings.window;
    seek(drag.from - dt);
  });
  const end = () => {
    if (!drag) return;
    const resume = drag.wasPlaying;
    drag = null;
    canvas.classList.remove("is-scrubbing");
    if (resume) startPlayback(playhead);
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  canvas.addEventListener("keydown", (e) => {
    if (e.key === " ") {
      e.preventDefault();
      onPlay();
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && take && state !== "recording" && state !== "paused") {
      e.preventDefault();
      const wasPlaying = state === "playing";
      if (wasPlaying) pausePlayback();
      seek(playhead + (e.key === "ArrowRight" ? 1 : -1));
      if (wasPlaying) startPlayback(playhead);
    }
  });
}

// Which key is under (x, y) on the canvas. A black key is narrower than a
// white one, so to the right of a black key the click belongs to whichever
// white neighbour's half of that lane it is in — the same shape the drawing
// gives the white keys.
function keyAt(x, y) {
  if (!geom || x < KEY_X || x > KEY_X + KEY_W_WHITE) return null;
  const step = (geom.bottom - geom.top) / (view.hi - view.lo);
  const exact = view.lo + (geom.bottom - y) / step;
  const m = Math.round(exact);
  if (!isBlackKey(m)) return m;
  if (x <= KEY_X + KEY_W_BLACK) return m;
  return exact >= m ? m + 1 : m - 1;
}

function toggleTarget(m) {
  if (targets.has(m)) targets.delete(m);
  else targets.add(m);
  const key = keyInfo();
  const names = [...targets].sort((a, b) => a - b).map((t) => {
    const n = noteName(t, key.flats);
    return `${n.name}${n.octave}`;
  });
  els.canvas.dataset.targets = [...targets].sort((a, b) => a - b).join(",");
  if (!els.status.classList.contains("is-error")) {
    setStatus(names.length
      ? `Aiming for ${names.join(", ")}. Click a key again to clear it.`
      : "Targets cleared. Click a key to pick a note to aim for.");
  }
  draw();
}

function seek(t) {
  playhead = Math.max(0, Math.min(take.duration, t));
  current = pitchAt(playhead);
  draw();
}

// --- drawing -----------------------------------------------------------------

function resizeCanvas() {
  const rect = els.display.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  size = { w, h };
  els.canvas.width = Math.round(w * dpr);
  els.canvas.height = Math.round(h * dpr);
  els.canvas.style.width = `${w}px`;
  els.canvas.style.height = `${h}px`;
}

function readColors() {
  const cs = getComputedStyle(els.panel);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    bg: v("--pitch-bg"),
    laneKey: v("--pitch-lane-key"),
    laneActive: v("--pitch-lane-active"),
    line: v("--pitch-line"),
    lineStrong: v("--pitch-line-strong"),
    keyWhite: v("--pitch-key-white"),
    keyBlack: v("--pitch-key-black"),
    keyEdge: v("--pitch-key-edge"),
    keyLabel: v("--pitch-key-label"),
    inTune: v("--pitch-in-tune"),
    offTune: v("--pitch-off-tune"),
    label: v("--pitch-label"),
    text: v("--pitch-text"),
    meter: v("--pitch-meter"),
    meterTrack: v("--pitch-meter-track"),
    target: v("--pitch-target"),
    targetLane: v("--pitch-target-lane"),
  };
}

function keyInfo() {
  const root = noteIndex(settings.key);
  const scale = new Set(SCALE_FORMULAS.major.map((s) => (s + root) % 12));
  return { inKey: (midi) => scale.has(((midi % 12) + 12) % 12), flats: FLAT_KEYS.has(settings.key) };
}

const isBlackKey = (midi) => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
const isInTune = (midi) => Math.abs(centsOff(midi)) <= settings.tolerance;

// The visible pitch range. A fixed voice range is fixed; Follow fits the
// points on screen with at least an octave showing, and only moves when the
// line nears an edge or the view has become much wider than it needs — a view
// that re-centred on every frame would make a steady note look like it moved.
function updateView(animate) {
  const fixed = RANGES[settings.range];
  let target;
  if (fixed) {
    target = { lo: fixed[0] - 0.5, hi: fixed[1] + 0.5 };
  } else {
    let min = Infinity;
    let max = -Infinity;
    const pts = take?.points || [];
    const from = playhead - settings.window;
    for (let i = Math.max(0, lastIndexAtOrBefore(pts, from)); i < pts.length; i++) {
      const p = pts[i];
      if (p.t > playhead) break;
      if (p.m == null || p.t < from) continue;
      min = Math.min(min, p.m);
      max = Math.max(max, p.m);
    }
    if (min === Infinity) {
      target = view;
    } else {
      let lo = min - 1.5;
      let hi = max + 1.5;
      if (hi - lo < FOLLOW_SPAN) {
        const mid = (lo + hi) / 2;
        lo = mid - FOLLOW_SPAN / 2;
        hi = mid + FOLLOW_SPAN / 2;
      }
      const fits = view.lo <= lo && view.hi >= hi;
      const tooWide = view.hi - view.lo > hi - lo + 6;
      target = fits && !tooWide ? view : { lo, hi };
    }
  }
  if (animate) {
    view = {
      lo: view.lo + (target.lo - view.lo) * 0.15,
      hi: view.hi + (target.hi - view.hi) * 0.15,
    };
  } else {
    view = { lo: target.lo, hi: target.hi };
  }
}

function draw(animate = false) {
  if (!els || !size.w || els.panel.style.display === "none") return;
  if (!colors) colors = readColors();
  const ctx = els.canvas.getContext("2d");
  const dpr = els.canvas.width / size.w;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { w, h } = size;

  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, w, h);

  updateView(animate);
  updateReadout(animate);
  const key = keyInfo();
  const g = {
    left: KEYBOARD_W,
    right: w - HEAD_INSET,
    top: GRAPH_PAD_Y,
    bottom: h - GRAPH_PAD_Y,
  };
  publishGeometry(g);
  geom = g;

  drawLanes(ctx, g, w, key);
  drawKeyboard(ctx, g, key);
  drawTrace(ctx, g, w);
  if (state === "recording" || state === "paused") drawMeter(ctx, w);
  updateNote(key);
}

// Input meter, top right, on a dBFS scale (-60..0) because a linear one sits
// at the bottom for any normal voice. The tick marks the detector's gate:
// below it nothing is tracked, which is the first thing to see when the line
// stays empty.
function drawMeter(ctx, width) {
  const w = 90;
  const h = 6;
  const x = width - w - 22;
  const y = 20;
  const pos = (rms) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-6)) + 60) / 60));
  ctx.fillStyle = colors.meterTrack;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = level > DEFAULT_OPTIONS.rmsGate ? colors.meter : colors.label;
  ctx.fillRect(x, y, w * pos(level), h);
  ctx.fillStyle = colors.text;
  ctx.fillRect(Math.round(x + w * pos(DEFAULT_OPTIONS.rmsGate)), y - 3, 1, h + 6);
  ctx.font = "600 10px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = colors.label;
  ctx.fillText("INPUT", x + w, y + h + 5);
}

// Published on the canvas so a test can find the lane of a note without
// duplicating this layout: the same contract melody-render.js keeps with its
// data-stave-* attributes.
function publishGeometry(g) {
  const k = `${view.lo}|${view.hi}|${g.top}|${g.bottom}|${g.left}|${g.right}`;
  if (k === geometryKey) return;
  geometryKey = k;
  Object.assign(els.canvas.dataset, {
    lo: String(view.lo),
    hi: String(view.hi),
    graphTop: String(g.top),
    graphBottom: String(g.bottom),
    graphLeft: String(g.left),
    graphRight: String(g.right),
  });
}

function yFor(m, g) {
  return g.bottom - ((m - view.lo) / (view.hi - view.lo)) * (g.bottom - g.top);
}

// One lane per semitone, centred on the note, so a held note runs along the
// middle of its lane. Lanes of notes in the key are lifted slightly — in C
// major that is exactly the white keys, which is what makes the keyboard and
// the lanes read as one object. The lane of the note being sung is tinted.
function drawLanes(ctx, g, w, key) {
  const step = (g.bottom - g.top) / (view.hi - view.lo);
  for (let m = Math.floor(view.lo); m <= Math.ceil(view.hi); m++) {
    const y0 = yFor(m + 0.5, g);
    const active = m === readout.note;
    const fill = active ? colors.laneActive : key.inKey(m) ? colors.laneKey : null;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(g.left, y0, w - g.left, step);
    }
    // A target lane: tinted and bordered top and bottom, so the singer can
    // see the band the line should run inside.
    if (targets.has(m)) {
      ctx.fillStyle = colors.targetLane;
      ctx.fillRect(g.left, y0, w - g.left, step);
      ctx.fillStyle = colors.target;
      ctx.fillRect(g.left, y0, w - g.left, 2);
      ctx.fillRect(g.left, y0 + step - 2, w - g.left, 2);
    }
    // Octave and E/F boundaries are the two places adjacent white keys meet;
    // a stronger line there gives the eye the keyboard's own landmarks.
    const pcAbove = (((m + 1) % 12) + 12) % 12;
    ctx.fillStyle = pcAbove === 0 || pcAbove === 5 ? colors.lineStrong : colors.line;
    ctx.fillRect(g.left, Math.round(y0), w - g.left, 1);
  }
}

function drawKeyboard(ctx, g, key) {
  const step = (g.bottom - g.top) / (view.hi - view.lo);
  const lit = readout.note;
  const litColor = readout.inTune ? colors.inTune : colors.offTune;
  const x = KEY_X;
  const wWhite = KEY_W_WHITE;
  const wBlack = KEY_W_BLACK;
  ctx.strokeStyle = colors.target;
  ctx.lineWidth = 3;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, g.top, KEYBOARD_W, g.bottom - g.top);
  ctx.clip();

  // White keys share the space of the black keys beside them, as on a real
  // keyboard: a white key reaches a full lane further toward a black
  // neighbour, which then covers that part.
  const lo = Math.floor(view.lo) - 1;
  const hi = Math.ceil(view.hi) + 1;
  ctx.font = "600 10px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let m = lo; m <= hi; m++) {
    if (isBlackKey(m)) continue;
    const top = yFor(m + (isBlackKey(m + 1) ? 1 : 0.5), g);
    const bottom = yFor(m - (isBlackKey(m - 1) ? 1 : 0.5), g);
    ctx.fillStyle = m === lit ? litColor : colors.keyWhite;
    ctx.fillRect(x, top + 0.5, wWhite, bottom - top - 1);
    // Drawn before the black keys, which cover it where they overlap — so
    // the border follows the key's visible outline.
    if (targets.has(m)) ctx.strokeRect(x + 1.5, top + 2, wWhite - 3, bottom - top - 4);
    const isC = ((m % 12) + 12) % 12 === 0;
    if (step >= 10 || isC) {
      const { name, octave } = noteName(m, key.flats);
      ctx.fillStyle = m === lit ? colors.bg : colors.keyLabel;
      ctx.fillText(`${name}${octave}`, x + wWhite - 5, yFor(m, g));
    }
  }
  for (let m = lo; m <= hi; m++) {
    if (!isBlackKey(m)) continue;
    const top = yFor(m + 0.5, g);
    ctx.fillStyle = m === lit ? litColor : colors.keyBlack;
    ctx.fillRect(x, top + 1, wBlack, step - 2);
    ctx.fillStyle = colors.keyEdge;
    ctx.fillRect(x + wBlack, top + 1, 1, step - 2);
    if (targets.has(m)) ctx.strokeRect(x + 1.5, top + 2.5, wBlack - 3, step - 5);
  }
  ctx.restore();
}

// The pitch line, coloured by accuracy: in tune (within the tolerance of the
// nearest note) or not.
//
// Accuracy is judged on the line's centre — a centred average over about one
// vibrato cycle — not on each instant. The ear hears vibrato as its centre
// pitch; judged point by point, a perfectly centred ±30-cent vibrato striped
// green and orange five times a second, which says "out of tune" about a
// note that is not. The two colours differ in lightness as well as hue,
// and the in-tune line is drawn thicker, so the difference survives colour
// blindness. A run of one colour is stroked as a single path; a new path is
// started on every change, overlapping by one point so the line has no gap.
function drawTrace(ctx, g, w) {
  const pts = take?.points;
  if (!pts?.length) return;
  const from = playhead - settings.window;
  const xFor = (t) => g.right - ((playhead - t) / settings.window) * (g.right - g.left);
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.left, g.top, w - g.left, g.bottom - g.top);
  ctx.clip();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const first = Math.max(0, lastIndexAtOrBefore(pts, from - CENTRE_S));
  const centres = centredPitch(pts, first, playhead + CENTRE_S);

  let run = null;
  let prev = null;
  let lastT = -Infinity;
  const flush = () => {
    if (run && run.n > 1) {
      ctx.strokeStyle = run.ok ? colors.inTune : colors.offTune;
      ctx.lineWidth = run.ok ? 2.8 : 2;
      ctx.stroke();
    }
    run = null;
  };
  for (let i = Math.max(0, lastIndexAtOrBefore(pts, from)); i < pts.length; i++) {
    const p = pts[i];
    if (p.t > playhead) break;
    if (p.m == null || p.t - lastT > GAP_S) {
      flush();
      prev = null;
    }
    lastT = p.t;
    if (p.m == null) continue;
    const x = xFor(p.t);
    const y = yFor(p.m, g);
    const ok = isInTune(centres.get(i) ?? p.m);
    if (!run || run.ok !== ok) {
      flush();
      ctx.beginPath();
      run = { ok, n: 0 };
      if (prev) {
        ctx.moveTo(prev.x, prev.y);
        run.n++;
      } else ctx.moveTo(x, y);
    }
    if (run.n) ctx.lineTo(x, y);
    run.n++;
    prev = { x, y };
  }
  flush();

  // The head: where the voice is right now (or at the playhead), coloured
  // like the line just behind it.
  if (current != null && (state !== "idle" || playhead < take.duration)) {
    const head = lastIndexAtOrBefore(pts, playhead);
    ctx.fillStyle = isInTune(centres.get(head) ?? current) ? colors.inTune : colors.offTune;
    ctx.beginPath();
    ctx.arc(g.right, yFor(current, g), 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Half-width of the averaging window: ±0.1s spans one cycle of a typical
// 5–6 Hz vibrato, so the average lands on its centre.
const CENTRE_S = 0.1;

// For each voiced point from `first` up to time `until`, the mean pitch of
// the voiced points within ±CENTRE_S of it in the same unbroken run — never
// averaged across a silence into another note. Direct rather than a sliding
// sum: a screenful is ~600 points with ~12 neighbours each, which is nothing,
// and the direct form is obviously right. Near the live edge the window is
// one-sided, the best that can be done without seeing the future.
function centredPitch(pts, first, until) {
  const out = new Map();
  for (let i = first; i < pts.length && pts[i].t <= until; i++) {
    const p = pts[i];
    if (p.m == null) continue;
    let sum = p.m;
    let n = 1;
    for (let j = i - 1; j >= 0 && pts[j].m != null && p.t - pts[j].t <= CENTRE_S; j--) {
      if (pts[j + 1].t - pts[j].t > GAP_S) break;
      sum += pts[j].m;
      n++;
    }
    for (let j = i + 1; j < pts.length && pts[j].m != null && pts[j].t - p.t <= CENTRE_S; j++) {
      if (pts[j].t - pts[j - 1].t > GAP_S) break;
      sum += pts[j].m;
      n++;
    }
    out.set(i, sum / n);
  }
  return out;
}

// `animate` is true on frames of the live/playback loop. Any other redraw —
// a scrub, a resize, a settings change — snaps, because there is no motion
// to smooth and an eased value would show where the playhead *was*.
function updateReadout(animate) {
  const now = performance.now() / 1000;
  const dt = Math.min(0.1, now - readout.lastFrame);
  readout.lastFrame = now;
  if (current != null) {
    const resumed = now - readout.lastVoiced > HOLD_S;
    if (!animate || readout.note == null || resumed) readout.midi = current;
    else readout.midi += (current - readout.midi) * (1 - Math.exp(-dt / READOUT_TAU));
    readout.lastVoiced = now;
    if (!animate || readout.note == null || resumed ||
        Math.abs(readout.midi - readout.note) > NOTE_HYSTERESIS) {
      readout.note = Math.round(readout.midi);
    }
  } else if (!animate || now - readout.lastVoiced > HOLD_S) {
    readout.note = null;
  }
  readout.cents = readout.note == null ? null : (readout.midi - readout.note) * 100;
  readout.inTune = readout.cents != null && Math.abs(readout.cents) <= settings.tolerance;
}

// The card: note name, cents, and a flat-to-sharp bar whose green zone is the
// tolerance. The marker and the cents are coloured like the line.
function updateNote(key) {
  let name = "–";
  let octave = "";
  let cents = "";
  let tune = "";
  if (readout.note != null) {
    const n = noteName(readout.note, key.flats);
    name = n.name;
    octave = String(n.octave);
    cents = String(Math.round(readout.cents));
    tune = readout.inTune ? "in" : "off";
  }
  const [nameEl, octEl] = els.note.children;
  if (nameEl.textContent !== name) nameEl.textContent = name;
  if (octEl.textContent !== octave) octEl.textContent = octave;
  if (els.note.dataset.cents !== cents) els.note.dataset.cents = cents;
  const centsText = cents === "" ? "" : `${Number(cents) > 0 ? "+" : Number(cents) < 0 ? "−" : ""}${Math.abs(Number(cents))}¢`;
  if (els.cents.textContent !== centsText) els.cents.textContent = centsText;
  els.card.dataset.tune = tune;
  els.card.classList.toggle("is-held", readout.note != null && current == null);
  els.zone.style.left = `${50 - settings.tolerance}%`;
  els.zone.style.width = `${settings.tolerance * 2}%`;
  const pos = readout.cents == null ? 50 : 50 + Math.max(-50, Math.min(50, readout.cents));
  els.marker.style.left = `${pos}%`;
}
