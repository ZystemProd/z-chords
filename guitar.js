// guitar.js
const GUITAR_TUNING = ["E", "B", "G", "D", "A", "E"]; // strings 1..6 (top to bottom visually)
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const ENHARMONIC = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#" };

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

function noteIndex(name) {
  if (ENHARMONIC[name]) name = ENHARMONIC[name];
  return NOTES.indexOf(name);
}

function buildScale(root, intervals) {
  const rootIdx = noteIndex(root);
  return intervals.map((i) => (rootIdx + i) % 12);
}

// Compute five playable windows (CAGED-like) over 17 frets
export function computeCAGEDShapes(root, intervals) {
  const rootIdx = noteIndex(root);
  const OPEN = [64, 59, 55, 50, 45, 40];
  const width = 5;
  const startMin = 1;
  const startMax = 13; // 17 - width + 1
  const inScale = new Set(intervals.map((x) => (x % 12 + 12) % 12));

  // Special case: strict major scale → fixed CAGED starts (E-D-C-A-G mapping)
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const isMajor =
    intervals.length === 7 &&
    MAJOR.every((d) => inScale.has(d));
  if (isMajor) {
    // 6th-string open E pitch-class index
    const E_PC = noteIndex("E");
    const r = (rootIdx - E_PC + 12) % 12; // 6th-string root fret within 0..11
    // Window start offsets from the 6th-string root (Position 1 E-shape):
    // Pos1 (E) = r-1, Pos2 (D) = r+1, Pos3 (C) = r+4, Pos4 (A) = r+6, Pos5 (G) = r+9
    const raw = [r - 1, r + 1, r + 4, r + 6, r + 9];
    // Normalize to 1..13 start range and ascending order over the neck
    const norm = raw.map((v) => {
      let s = ((v % 12) + 12) % 12; // 0..11
      s = s === 0 ? 12 : s; // map 0 → 12 (12th fret)
      // convert to 1..13 window starts; clamp so window fully visible
      let start = s;
      if (start < startMin) start += 12;
      if (start > startMax) start -= 12;
      return start;
    });
    // Ensure ascending (wrap by adding 12 where needed)
    for (let i = 1; i < norm.length; i++) {
      while (norm[i] <= norm[i - 1]) norm[i] += 12;
    }
    // Bring into 1..13 range (mod 12) but keep spacing
    const starts = norm.map((v) => {
      while (v > startMax) v -= 12;
      while (v < startMin) v += 12;
      return v;
    });
    return starts;
  }

  const notesByString = Array.from({ length: 6 }, (_, si) => {
    const open = OPEN[si];
    const arr = [];
    for (let f = 1; f <= 17; f++) {
      const pc = (open + f) % 12;
      const deg = (pc - rootIdx + 12) % 12;
      if (inScale.has(deg)) arr.push({ fret: f, deg });
    }
    return arr;
  });

  function windowDegrees(s) {
    const hi = s + width - 1;
    const set = new Set();
    let hasRoot = false;
    for (let si = 0; si < 6; si++) {
      for (const n of notesByString[si]) {
        if (n.fret < s) continue;
        if (n.fret > hi) break;
        set.add(n.deg);
        if (n.deg === 0) hasRoot = true;
      }
    }
    return { set, hasRoot };
  }

  function rootDistance(s) {
    const center = s + 2; // width=5
    let best = Infinity;
    for (let si = 0; si < 6; si++) {
      for (const n of notesByString[si]) {
        if (n.deg !== 0) continue;
        if (n.fret < s || n.fret > s + 4) continue;
        best = Math.min(best, Math.abs(n.fret - center));
      }
    }
    return best;
  }

  function smoothness(s) {
    const hi = s + 4;
    let sum = 0;
    let cnt = 0;
    for (let si = 1; si < 6; si++) {
      const a = notesByString[si - 1].filter((n) => n.fret >= s && n.fret <= hi);
      const b = notesByString[si].filter((n) => n.fret >= s && n.fret <= hi);
      if (!a.length || !b.length) {
        sum += 4;
        cnt++;
        continue;
      }
      let best = 99;
      for (const na of a) for (const nb of b) best = Math.min(best, Math.abs(na.fret - nb.fret));
      sum += best;
      cnt++;
    }
    return cnt ? sum / cnt : 9;
  }

  const candidates = [];
  for (let s = startMin; s <= startMax; s++) {
    const { set, hasRoot } = windowDegrees(s);
    const coversAll = intervals.every((d) => set.has((d % 12 + 12) % 12));
    if (!hasRoot || !coversAll) continue;
    candidates.push({ s, rootDist: rootDistance(s), smooth: smoothness(s) });
  }
  if (!candidates.length) {
    for (let s = startMin; s <= startMax; s++) {
      const { hasRoot } = windowDegrees(s);
      if (!hasRoot) continue;
      candidates.push({ s, rootDist: rootDistance(s), smooth: smoothness(s) });
    }
  }

  candidates.sort((a, b) => a.s - b.s || a.rootDist - b.rootDist || a.smooth - b.smooth);
  if (!candidates.length) return [1, 4, 7, 10, 13];

  const shapes = [];
  let last = -100;
  for (const c of candidates) {
    if (!shapes.length || c.s >= last + 2) {
      shapes.push(c);
      last = c.s;
      if (shapes.length === 5) break;
    }
  }
  if (shapes.length < 5) {
    const desired = [1, 4, 7, 10, 13];
    for (const d of desired) {
      if (shapes.find((x) => Math.abs(x.s - d) <= 1)) continue;
      let best = null;
      let diff = Infinity;
      for (const c of candidates) {
        if (shapes.some((x) => x.s === c.s)) continue;
        const df = Math.abs(c.s - d);
        if (df < diff) {
          best = c;
          diff = df;
        }
      }
      if (best) shapes.push(best);
      if (shapes.length === 5) break;
    }
  }
  return shapes.sort((a, b) => a.s - b.s).slice(0, 5).map((x) => x.s);
}

// Map a modal root back to its parent major root for CAGED windows.
// Returns a note name using sharps.
export function getParentMajorRoot(root, mode) {
  const r = noteIndex(root);
  if (r < 0) return root;
  // Semitone shifts relative to the modal root to reach parent major
  // Ionian/Major = 0; Dorian −2; Phrygian −4; Lydian −5; Mixolydian −7; Aeolian −9; Locrian −11
  const SHIFT = {
    major: 0,
    ionian: 0,
    majorPentatonic: 0,
    majorBlues: 0,
    dorian: -2,
    phrygian: -4,
    lydian: -5,
    mixolydian: -7,
    aeolian: -9,
    minorPentatonic: -9,
    blues: -9,
    minorBlues: -9,
    harmonicMinor: -9, // same CAGED windows as natural minor
    melodicMinor: -9, // use Aeolian windows
    harmonicMajor: 0, // use Ionian windows
    locrian: -11,
  };
  const s = SHIFT[mode] ?? 0;
  const parentIdx = (r + s + 12) % 12;
  return NOTES[parentIdx];
}

// Convenience: compute CAGED starts directly for a given key+mode
export function getCAGEDStartsForMode(root, mode) {
  const parent = getParentMajorRoot(root, mode);
  return computeCAGEDShapes(parent, SCALE_FORMULAS.major);
}

export function renderScaleSVG(
  root,
  intervals,
  startFret = 1,
  fretsWide = 17,
  opts = {}
) {
  const scale = buildScale(root, intervals);
  const rootIdx = noteIndex(root);
  const labelMode = opts.labelMode === "note" ? "note" : "interval";
  const editable = opts.editable === true;
  const customMode = opts.customMode === true;
  const customNoteSet = customMode ? new Set((opts.customNoteKeys || []).map((n) => String(n))) : null;

  const isLydian = (() => {
    const lyd = SCALE_FORMULAS.lydian;
    return Array.isArray(intervals) && intervals.length === lyd.length && lyd.every((v) => intervals.includes(v));
  })();
  const isWholeTone = (() => {
    const wt = SCALE_FORMULAS.wholeTone;
    return Array.isArray(intervals) && intervals.length === wt.length && wt.every((v) => intervals.includes(v));
  })();
  const isHarmMinor = (() => {
    const hm = SCALE_FORMULAS.harmonicMinor;
    return Array.isArray(intervals) && intervals.length === hm.length && hm.every((v) => intervals.includes(v));
  })();

  function intervalLabel(semi) {
    switch (semi) {
      case 0:
        return "R";
      case 1:
        return "b2";
      case 2:
        return "2";
      case 3:
        return "b3";
      case 4:
        return "3";
      case 5:
        return "4";
      case 6:
        return isWholeTone || isLydian ? "#4" : "b5";
      case 7:
        return "5";
      case 8:
        return isWholeTone ? "#5" : "b6";
      case 9:
        return "6";
      case 10:
        return "b7";
      case 11:
        return isHarmMinor ? "Δ7" : "7";
      default:
        return "";
    }
  }

  const fretWidth = 60;
  const stringHeight = 40;
  const paddingTop = 30;
  const paddingBottom = 50;
  const paddingLeft = 80;
  const paddingRight = 30;
  const width = paddingLeft + fretWidth * fretsWide + paddingRight;
  const height = paddingTop + stringHeight * GUITAR_TUNING.length + paddingBottom;
  const svgNS = "http://www.w3.org/2000/svg";

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute(
    "style",
    "font-family: sans-serif; background: linear-gradient(#fdf5e6, #f0e6d2); border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.2);"
  );

  // Window options
  const windowStart = typeof opts.windowStart === "number" ? opts.windowStart : null; // 1-based
  const windowWidth = typeof opts.windowWidth === "number" ? opts.windowWidth : 5;
  const showOpen = opts.showOpen !== false; // default true
  const fretShift = typeof opts.fretShift === "number" ? opts.fretShift : 0; // shift fretted notes (e.g., wrap 12 → 0)
  const inWindow = (fret) => {
    const f = fret + fretShift;
    if (windowStart === null) return true;
    return f >= windowStart && f <= windowStart + windowWidth - 1;
  };

  const openStringMIDIs = [64, 59, 55, 50, 45, 40];
  const nearNut =
    windowStart === null ? true : Math.abs(windowStart - 0) <= 4; // include open if window sits within 4 frets of nut

  function noteNameWithOctave(midiNote) {
    const noteName = NOTES[midiNote % 12];
    const octave = Math.floor(midiNote / 12) - 1;
    return `${noteName}${octave}`;
  }

  const romanMap = {
    1: "I",
    2: "II",
    3: "III",
    4: "IV",
    5: "V",
    6: "VI",
    7: "VII",
    8: "VIII",
    9: "IX",
    10: "X",
    11: "XI",
    12: "XII",
    13: "XIII",
    14: "XIV",
    15: "XV",
    16: "XVI",
    17: "XVII",
  };

  // Frets and markers
  for (let fret = startFret; fret <= startFret + fretsWide - 1; fret++) {
    const x = paddingLeft + fretWidth * (fret - startFret);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", x);
    line.setAttribute("y1", paddingTop);
    line.setAttribute("x2", x);
    line.setAttribute("y2", height - paddingBottom + 10);
    line.setAttribute("stroke", "#bbb");
    line.setAttribute("stroke-width", fret === startFret ? 6 : 2);
    svg.appendChild(line);

    if ([3, 5, 7, 9, 12, 15, 17].includes(fret)) {
      const marker = document.createElementNS(svgNS, "circle");
      marker.setAttribute("cx", x + fretWidth / 2);
      marker.setAttribute("cy", paddingTop + (stringHeight * GUITAR_TUNING.length) / 2);
      marker.setAttribute("r", 5);
      marker.setAttribute("fill", "#ccc");
      svg.appendChild(marker);
    }

    if (romanMap[fret]) {
      const romanText = document.createElementNS(svgNS, "text");
      romanText.setAttribute("x", x + fretWidth / 2);
      romanText.setAttribute("y", height - paddingBottom + 30);
      romanText.setAttribute("text-anchor", "middle");
      romanText.setAttribute("fill", "#333");
      romanText.setAttribute("font-size", "14");
      romanText.textContent = romanMap[fret];
      svg.appendChild(romanText);
    }
  }

  // Strings and labels
  const renderNotes = [];
  let nid = 0;
  for (let stringIdx = 0; stringIdx < GUITAR_TUNING.length; stringIdx++) {
    const stringNote = GUITAR_TUNING[stringIdx];
    const y = paddingTop + stringHeight * (stringIdx + 0.5);
    const labelX = paddingLeft - 24;

    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", paddingLeft);
    line.setAttribute("y1", y);
    line.setAttribute("x2", width - paddingRight);
    line.setAttribute("y2", y);
    line.setAttribute("stroke", "#555");
    const strokeWidths = [1, 1, 1.5, 1.5, 2.5, 2.5];
    line.setAttribute("stroke-width", strokeWidths[stringIdx] || 1.5);
    svg.appendChild(line);

    const openMidi = openStringMIDIs[stringIdx];
    const openNoteIdx = openMidi % 12;
    const notesOnString = [];

    if (!customMode && !editable && !(showOpen && nearNut && scale.includes(openNoteIdx))) {
      // Show string label when open note is not used
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", labelX);
      label.setAttribute("y", y + 4);
      label.setAttribute("text-anchor", "end");
      label.setAttribute("fill", "#333");
      label.setAttribute("font-size", "12");
      label.textContent = stringNote;
      svg.appendChild(label);
    } else {
      // Treat open string as fret 0 so it can be clicked like any other note.
      notesOnString.push({ fret: 0, midiNote: openMidi, xOverride: labelX, open: true });
    }

    for (let fret = startFret; fret <= startFret + fretsWide - 1; fret++) {
      const displayFret = fret + fretShift;
      if (displayFret < 0) continue;
      const midiNote = openMidi + fret;
      const noteIdx = midiNote % 12;
      if ((customMode || editable || scale.includes(noteIdx)) && inWindow(fret)) {
        notesOnString.push({ fret: displayFret, midiNote });
      }
    }

    // Collect all
    for (const { fret, midiNote, xOverride, open } of notesOnString) {
      const noteIdx = midiNote % 12;
      const x =
        typeof xOverride === "number"
          ? xOverride
          : fret === 0
          ? paddingLeft - fretWidth / 2
          : paddingLeft + fretWidth * (fret - startFret + 0.5);
      const deg = (noteIdx - rootIdx + 12) % 12;
      renderNotes.push({ id: nid++, stringIdx, fret, midiNote, noteIdx, deg, x, y, open: Boolean(open) });
    }
  }

  // Render notes in the window (no pruning); CAGED shape is determined by windowStart
  const toRemove = new Set();

  // Harmonic minor per-shape fixups: Shape 2 remove Δ7 on B string
  if (isHarmMinor && typeof windowStart === 'number') {
    try {
      const parent = getParentMajorRoot(root, 'harmonicMinor');
      const starts = computeCAGEDShapes(parent, SCALE_FORMULAS.major);
      const normStart = ((windowStart - 1) % 12 + 12) % 12 + 1;
      const idx = starts.findIndex((s) => ((s - 1) % 12) === ((normStart - 1) % 12));
      if (idx === 1) {
        for (const n of renderNotes) {
          if (n.stringIdx === 1 && n.deg === 11) n._remove = true;
        }
      }
    } catch (_) {}
  }

  // Render
  for (const { x, y, noteIdx, midiNote, deg, id, _remove, stringIdx, fret } of renderNotes) {
    if (toRemove.has(id) || _remove) continue;
    const noteKey = `${stringIdx}:${fret}:${midiNote}`;
    const active = customMode ? customNoteSet.has(noteKey) : scale.includes(noteIdx);
    const circle = document.createElementNS(svgNS, "circle");
    circle.setAttribute("cx", x);
    circle.setAttribute("cy", y);
    circle.setAttribute("r", active ? 12 : 10);
    circle.setAttribute("fill", active ? (customMode ? "#333" : (noteIdx === rootIdx ? "#ff6347" : "#333")) : "transparent");
    circle.setAttribute("stroke", active ? "#fff" : "#7f8c9a");
    circle.setAttribute("stroke-width", active ? 2 : 1.5);
    circle.setAttribute("stroke-dasharray", active ? "" : "3 2");
    circle.setAttribute("data-note-idx", String(noteIdx));
    circle.setAttribute("data-midi-note", String(midiNote));
    circle.setAttribute("data-note-key", noteKey);
    circle.setAttribute("data-active", String(active));
    circle.style.cursor = editable ? "pointer" : "default";
    svg.appendChild(circle);

    const tooltip = document.createElementNS(svgNS, "title");
    tooltip.textContent = noteNameWithOctave(midiNote);
    circle.appendChild(tooltip);

    if (!customMode || active) {
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", x);
      label.setAttribute("y", y + 5);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("fill", active ? "#fff" : "#9fb0c2");
      label.setAttribute("font-size", active ? "12" : "11");
      label.setAttribute("pointer-events", "none");
      label.textContent = customMode
        ? noteNameWithOctave(midiNote)
        : (labelMode === "note" ? NOTES[midiNote % 12] : intervalLabel(deg));
      svg.appendChild(label);
    }
  }

  return svg;
}
