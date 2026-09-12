// The beat grid: drums→beat.
//
// This is the editor for a melody with `clef: "drums"`. It mirrors
// `createMelodyEditor`'s contract exactly — owns the DOM inside `host`, reports
// committed changes through `onChange`, knows nothing about boards, tabs or
// storage — so `melody-panel.js` can pick between the two by clef and treat
// them identically otherwise.
//
// A grid rather than a staff, because the input problem is genuinely different.
// On a melody staff the question is "which pitch", and the staff itself is the
// natural answer. On a kit the voices are a fixed short list and the question is
// "which sixteenth", so a row per voice and a column per step IS the notation
// people actually read and write. The staff view stays as the printed output.
//
// The grid is a VIEW, not the storage: `melody.events` remains canonical, so
// the sheet, the song file, the PDF and the tick arithmetic all work on a beat
// unchanged. `gridFromMelody`/`melodyFromGrid` convert in both directions and
// the round-trip is pinned by a test.
import {
  DRUM_VOICES,
  createMelody,
  normalizeMelody,
  gridFromMelody,
  melodyFromGrid,
  beatStepCount,
  stepsPerBar,
  melodyPlaybackSchedule,
} from "./melody-model.js";
import { playNotes } from "./audio.js";
import { renderMelodySVG, clampScale, MIN_SCALE, MAX_SCALE } from "./melody-render.js";

// The kit has no oscillator of its own, so each voice is played as a short
// pitched blip: low and dark for the kick, high and bright for the cymbals.
// This is deliberately a sketch — enough to hear whether a pattern grooves,
// not a drum synth. `brightness` scales audio.js's per-voice filter cutoff.
const DRUM_SOUND = {
  kick: { midi: 36, duration: 0.18, brightness: 0.35, velocity: 1 },
  snare: { midi: 62, duration: 0.16, brightness: 2.6, velocity: 0.75 },
  hihat: { midi: 90, duration: 0.06, brightness: 3, velocity: 0.4 },
  ride: { midi: 88, duration: 0.3, brightness: 2.8, velocity: 0.45 },
  crash: { midi: 84, duration: 0.9, brightness: 2.8, velocity: 0.6 },
};

let timers = [];

export function stopBeatPlayback() {
  timers.forEach((t) => clearTimeout(t));
  timers = [];
}

export function playBeat(melody) {
  stopBeatPlayback();
  melodyPlaybackSchedule(melody).forEach((hit) => {
    hit.midis.forEach((midi) => {
      const voice = DRUM_VOICES.find((v) => v.midi === midi);
      const sound = (voice && DRUM_SOUND[voice.id]) || DRUM_SOUND.snare;
      timers.push(
        setTimeout(() => {
          // retrigger:false — a kick and a hat land on the same tick constantly,
          // and the default would have each one cut the other off.
          playNotes([sound.midi], { ...sound, retrigger: false });
        }, hit.atMs)
      );
    });
  });
}

/**
 * @param {HTMLElement} host
 * @param {object} melody   a melody with clef "drums"
 * @param {{ onChange?: Function }} options
 * @returns {{ el, getMelody, setMelody, destroy }}
 */
export function createDrumGridEditor(host, melody, options = {}) {
  const onChange = options.onChange || (() => {});

  let current = normalizeMelody(melody);
  if (current.clef !== "drums") current = createMelody({ ...current, clef: "drums" });
  let grid = gridFromMelody(current);
  let steps = beatStepCount(current);
  // The same zoom the melody editor uses, from the same injected preference, so
  // one setting governs however you are reading notation.
  let scale = clampScale(options.scale != null ? options.scale : 1.6);
  const onScaleChange = options.onScaleChange || (() => {});

  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "drum-grid-editor";
  const controls = document.createElement("div");
  controls.className = "drum-grid-controls no-drag";
  // The notation the grid is actually writing, live. The grid answers "which
  // sixteenth" and is the right thing to edit in; the staff answers "what does
  // this read as", which is the thing that gets printed and the thing a drummer
  // is handed. Showing both removes the guesswork between them — in particular
  // it makes visible that a hit takes the duration of the gap to the next hit,
  // which is otherwise a rule you have to know rather than see.
  const notation = document.createElement("div");
  notation.className = "drum-notation no-drag";
  notation.setAttribute("aria-hidden", "true"); // decorative: the grid is the control
  const gridEl = document.createElement("div");
  gridEl.className = "drum-grid no-drag";
  root.appendChild(controls);
  root.appendChild(notation);
  root.appendChild(gridEl);
  host.appendChild(root);

  // The grid edits `grid`; the melody is rebuilt from it on every commit rather
  // than patched, so the two can never disagree about what the pattern is.
  function commit() {
    current = melodyFromGrid(current, grid, steps);
    onChange(current);
  }

  function mkButton(label, title, onClick, active) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "no-drag" + (active ? " is-active" : "");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function setBars(n) {
    const per = stepsPerBar(current.timeSig);
    const bars = Math.max(1, Math.min(8, n));
    const next = bars * per;
    if (next === steps) return;
    // Shrinking drops the hits in the bars removed. Doing that on the grid
    // rather than on the events means a bar that is re-added comes back empty
    // instead of resurrecting what used to be in it.
    if (next < steps) {
      grid.forEach((set) => [...set].forEach((s) => { if (s >= next) set.delete(s); }));
    }
    steps = next;
    commit();
    draw();
  }

  function clear() {
    grid.forEach((set) => set.clear());
    commit();
    draw();
  }

  function drawControls() {
    controls.innerHTML = "";

    const timeSel = document.createElement("select");
    timeSel.className = "no-drag";
    timeSel.setAttribute("aria-label", "Time signature");
    [[4, 4], [3, 4], [6, 8], [5, 4]].forEach(([num, den]) =>
      timeSel.appendChild(new Option(`${num}/${den}`, `${num}/${den}`))
    );
    timeSel.value = `${current.timeSig.num}/${current.timeSig.den}`;
    timeSel.addEventListener("change", () => {
      const [num, den] = timeSel.value.split("/").map(Number);
      const bars = Math.max(1, Math.round(steps / stepsPerBar(current.timeSig)));
      current.timeSig = { num, den };
      // Steps per bar changed under the pattern, so the columns no longer mean
      // what the hits were placed against. Keep the bar count and start clean
      // rather than silently reinterpreting every hit's position.
      grid.forEach((set) => set.clear());
      steps = bars * stepsPerBar(current.timeSig);
      commit();
      draw();
    });
    controls.appendChild(timeSel);

    const bars = Math.max(1, Math.round(steps / stepsPerBar(current.timeSig)));
    const barBox = document.createElement("span");
    barBox.className = "drum-bars no-drag";
    barBox.appendChild(mkButton("−", "One bar fewer", () => setBars(bars - 1)));
    const barLabel = document.createElement("span");
    barLabel.className = "drum-bars-value";
    barLabel.textContent = `${bars} bar${bars === 1 ? "" : "s"}`;
    barBox.appendChild(barLabel);
    barBox.appendChild(mkButton("+", "One bar more", () => setBars(bars + 1)));
    controls.appendChild(barBox);

    const tempo = document.createElement("input");
    tempo.type = "number";
    tempo.className = "no-drag drum-tempo";
    tempo.min = "30";
    tempo.max = "300";
    tempo.value = String(current.tempo);
    tempo.setAttribute("aria-label", "Tempo in BPM");
    tempo.addEventListener("change", () => {
      const v = Number(tempo.value);
      current.tempo = Number.isFinite(v) && v > 0 ? Math.min(300, Math.max(30, v)) : 96;
      tempo.value = String(current.tempo);
      commit();
    });
    controls.appendChild(tempo);

    controls.appendChild(mkButton("▶", "Play this beat", () => playBeat(current)));
    controls.appendChild(mkButton("■", "Stop playback", stopBeatPlayback));
    controls.appendChild(mkButton("Clear", "Remove every hit", clear));

    const zoom = document.createElement("span");
    zoom.className = "melody-zoom no-drag";
    const setScale = (next) => {
      const v = clampScale(next);
      if (v === scale) return;
      scale = v;
      onScaleChange(v);
      drawControls();
      drawNotation();
    };
    const out = mkButton("−", "Smaller notation", () => setScale(scale - 0.2));
    const inn = mkButton("+", "Larger notation", () => setScale(scale + 0.2));
    out.disabled = scale <= MIN_SCALE;
    inn.disabled = scale >= MAX_SCALE;
    zoom.appendChild(out);
    const pct = document.createElement("span");
    pct.className = "melody-zoom-value";
    pct.textContent = `${Math.round(scale * 100)}%`;
    zoom.appendChild(pct);
    zoom.appendChild(inn);
    controls.appendChild(zoom);
  }

  function drawGrid() {
    gridEl.innerHTML = "";
    const per = stepsPerBar(current.timeSig);
    // One column for the row label, then one per step.
    gridEl.style.gridTemplateColumns = `auto repeat(${steps}, 1fr)`;

    DRUM_VOICES.forEach((voice) => {
      const label = document.createElement("div");
      label.className = "drum-row-label";
      label.textContent = voice.label;
      gridEl.appendChild(label);

      for (let s = 0; s < steps; s += 1) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "drum-cell no-drag";
        // The beat within the bar, so the eye can find "2" without counting
        // sixteen identical boxes — the grid's only real legibility problem.
        const inBar = s % per;
        const sub = Math.round(per / current.timeSig.num);
        if (inBar === 0) cell.classList.add("is-barstart");
        else if (sub > 0 && inBar % sub === 0) cell.classList.add("is-beat");
        if (grid.get(voice.id).has(s)) cell.classList.add("is-on");
        cell.dataset.voice = voice.id;
        cell.dataset.step = String(s);
        cell.setAttribute(
          "aria-label",
          `${voice.label}, step ${s + 1}`
        );
        cell.setAttribute("aria-pressed", String(grid.get(voice.id).has(s)));
        cell.addEventListener("click", (e) => {
          e.stopPropagation();
          const set = grid.get(voice.id);
          if (set.has(s)) set.delete(s);
          else {
            set.add(s);
            const sound = DRUM_SOUND[voice.id] || DRUM_SOUND.snare;
            playNotes([sound.midi], { ...sound, retrigger: false });
          }
          commit();
          draw();
        });
        gridEl.appendChild(cell);
      }
    });
  }

  function drawNotation() {
    notation.innerHTML = "";
    notation.appendChild(renderMelodySVG(current, { scale }));
  }

  function draw() {
    drawControls();
    drawNotation();
    drawGrid();
  }

  draw();

  return {
    el: root,
    getMelody: () => current,
    setMelody: (next) => {
      current = normalizeMelody(next);
      grid = gridFromMelody(current);
      steps = beatStepCount(current);
      draw();
    },
    destroy: () => {
      stopBeatPlayback();
      host.innerHTML = "";
    },
  };
}
