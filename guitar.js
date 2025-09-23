// guitar.js
const GUITAR_TUNING = ["E", "A", "D", "G", "B", "E"]; // low to high
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const ENHARMONIC = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#" };
export const SCALE_FORMULAS = {
  pentatonic: [0, 3, 5, 7, 10], // minor pentatonic
  blues: [0, 3, 5, 6, 7, 10], // blues scale
  major: [0, 2, 4, 5, 7, 9, 11], // ionian
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10], // natural minor
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

function noteIndex(name) {
  if (ENHARMONIC[name]) name = ENHARMONIC[name];
  return NOTES.indexOf(name);
}

function buildScale(root, intervals) {
  const rootIdx = noteIndex(root);
  return intervals.map((i) => (rootIdx + i) % 12);
}

export function renderScaleSVG(root, intervals, startFret = 0, fretsWide = 12) {
  const scale = buildScale(root, intervals);
  const rootIdx = noteIndex(root);

  const fretWidth = 60;
  const stringHeight = 40;

  const paddingTop = 30;
  const paddingBottom = 30;
  const paddingLeft = 60; // space for string names and open circles
  const paddingRight = 30;

  const width = paddingLeft + fretWidth * fretsWide + paddingRight;
  const height =
    paddingTop + stringHeight * GUITAR_TUNING.length + paddingBottom;
  const svgNS = "http://www.w3.org/2000/svg";

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute(
    "style",
    "font-family: sans-serif; background: linear-gradient(#fdf5e6, #f0e6d2); border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.2);"
  );

  function noteNameWithOctave(noteIdx, stringIdx, fret) {
    const openStringNote = noteIndex(GUITAR_TUNING[stringIdx]);
    const midiNote = openStringNote + fret;
    const noteName = NOTES[midiNote % 12];
    const octave = 0 + Math.floor(midiNote / 12);
    return `${noteName}${octave}`;
  }

  // Draw frets
  for (let fret = 0; fret <= fretsWide; fret++) {
    const x = paddingLeft + fretWidth * fret;
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", x);
    line.setAttribute("y1", paddingTop);
    line.setAttribute("x2", x);
    line.setAttribute("y2", height - paddingBottom);
    line.setAttribute("stroke", "#bbb");
    line.setAttribute("stroke-width", fret === 0 ? 6 : 2);
    svg.appendChild(line);

    // Optional fret markers (dots)
    if ([3, 5, 7, 9, 12].includes(fret)) {
      const marker = document.createElementNS(svgNS, "circle");
      marker.setAttribute("cx", x - fretWidth / 2);
      marker.setAttribute(
        "cy",
        paddingTop + (stringHeight * GUITAR_TUNING.length) / 2
      );
      marker.setAttribute("r", 5);
      marker.setAttribute("fill", "#ccc");
      svg.appendChild(marker);
    }
  }

  // Draw strings and notes
  GUITAR_TUNING.forEach((note, stringIdx) => {
    const y = paddingTop + stringHeight * (stringIdx + 0.5);

    // Horizontal string line
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", paddingLeft);
    line.setAttribute("y1", y);
    line.setAttribute("x2", width - paddingRight);
    line.setAttribute("y2", y);
    line.setAttribute("stroke", "#555");
    line.setAttribute("stroke-width", stringIdx <= 1 ? 2.5 : 1.5);
    svg.appendChild(line);

    // String name
    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", paddingLeft / 2);
    text.setAttribute("y", y + 5);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "#333");
    text.setAttribute("font-size", "14");
    text.textContent = note;
    svg.appendChild(text);

    // Collect notes on string
    const notesOnString = [];
    for (let fret = 0; fret <= fretsWide; fret++) {
      const noteIdx = (noteIndex(note) + fret) % 12;
      if (scale.includes(noteIdx)) notesOnString.push({ fret, noteIdx });
    }

    // Soft limit: 3 notes per string
    const notesToRender = notesOnString.slice(0, 3);

    notesToRender.forEach(({ fret, noteIdx }) => {
      const x = paddingLeft + fretWidth * fret + fretWidth / 2;

      // Note circle
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("cx", x);
      circle.setAttribute("cy", y);
      circle.setAttribute("r", 12);
      circle.setAttribute("fill", noteIdx === rootIdx ? "#ff6347" : "#333");
      circle.setAttribute("stroke", "#fff");
      circle.setAttribute("stroke-width", 2);
      svg.appendChild(circle);

      // Tooltip
      const tooltip = document.createElementNS(svgNS, "title");
      tooltip.textContent = noteNameWithOctave(noteIdx, stringIdx, fret);
      circle.appendChild(tooltip);

      // Root label
      if (noteIdx === rootIdx) {
        const rootText = document.createElementNS(svgNS, "text");
        rootText.setAttribute("x", x);
        rootText.setAttribute("y", y + 5);
        rootText.setAttribute("text-anchor", "middle");
        rootText.setAttribute("fill", "#fff");
        rootText.setAttribute("font-size", "12");
        rootText.textContent = "R";
        svg.appendChild(rootText);
      }

      // Open string marker
      if (fret === 0) {
        const openCircle = document.createElementNS(svgNS, "circle");
        openCircle.setAttribute("cx", paddingLeft - fretWidth / 2);
        openCircle.setAttribute("cy", y);
        openCircle.setAttribute("r", 10);
        openCircle.setAttribute("fill", "#fff");
        openCircle.setAttribute("stroke", "#333");
        openCircle.setAttribute("stroke-width", 2);
        svg.appendChild(openCircle);

        // Tooltip
        const openTooltip = document.createElementNS(svgNS, "title");
        openTooltip.textContent = noteNameWithOctave(noteIdx, stringIdx, fret);
        openCircle.appendChild(openTooltip);
      }
    });
  });

  return svg;
}
