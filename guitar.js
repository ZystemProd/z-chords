// guitar.js
const GUITAR_TUNING = ["E", "B", "G", "D", "A", "E"];
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

export function renderScaleSVG(root, intervals, startFret = 1, fretsWide = 5) {
  const scale = buildScale(root, intervals);
  const rootIdx = noteIndex(root);

  const fretWidth = 60;
  const stringHeight = 40;
  const paddingTop = 30;
  const paddingBottom = 50;
  const paddingLeft = 80;
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

  const openStringMIDIs = [64, 59, 55, 50, 45, 40]; // string 1 → 6

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
  };

  // Draw frets
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

    if ([3, 5, 7, 9, 12].includes(fret)) {
      const marker = document.createElementNS(svgNS, "circle");
      marker.setAttribute("cx", x + fretWidth / 2);
      marker.setAttribute(
        "cy",
        paddingTop + (stringHeight * GUITAR_TUNING.length) / 2
      );
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

  // Duplicate check using full MIDI pitch
  function isDuplicateOnLowerStrings(midiNote, stringIdx) {
    if (midiNote === openStringMIDIs[stringIdx]) return false; // keep open note
    for (let lower = stringIdx + 1; lower < GUITAR_TUNING.length; lower++) {
      const lowerOpenMidi = openStringMIDIs[lower];
      if (lowerOpenMidi === midiNote) return true;
      for (let f = startFret; f <= startFret + fretsWide - 1; f++) {
        if (lowerOpenMidi + f === midiNote) return true;
      }
    }
    return false;
  }

  // Iterate strings top → bottom (string 1 → 6)
  for (let stringIdx = 0; stringIdx < GUITAR_TUNING.length; stringIdx++) {
    const stringNote = GUITAR_TUNING[stringIdx];
    const y = paddingTop + stringHeight * (stringIdx + 0.5);

    // Draw string line
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", paddingLeft);
    line.setAttribute("y1", y);
    line.setAttribute("x2", width - paddingRight);
    line.setAttribute("y2", y);
    line.setAttribute("stroke", "#555");
    line.setAttribute("stroke-width", stringIdx <= 1 ? 2.5 : 1.5);
    svg.appendChild(line);

    // Open string
    const openMidi = openStringMIDIs[stringIdx];
    let notesOnString = [];
    if (scale.includes(openMidi % 12)) {
      notesOnString.push({ fret: 0, midiNote: openMidi });
      const xOpen = paddingLeft - fretWidth / 2;
      const openCircle = document.createElementNS(svgNS, "circle");
      openCircle.setAttribute("cx", xOpen);
      openCircle.setAttribute("cy", y);
      openCircle.setAttribute("r", 14);
      openCircle.setAttribute("fill", "#fff");
      openCircle.setAttribute("stroke", "#333");
      openCircle.setAttribute("stroke-width", 2);
      svg.appendChild(openCircle);

      const openText = document.createElementNS(svgNS, "text");
      openText.setAttribute("x", xOpen);
      openText.setAttribute("y", y + 5);
      openText.setAttribute("text-anchor", "middle");
      openText.setAttribute("fill", "#333");
      openText.setAttribute("font-size", "12");
      openText.textContent = stringNote;
      svg.appendChild(openText);

      const openTooltip = document.createElementNS(svgNS, "title");
      openTooltip.textContent = noteNameWithOctave(openMidi);
      openCircle.appendChild(openTooltip);
    }

    // Fretted notes
    for (let fret = startFret; fret <= startFret + fretsWide - 1; fret++) {
      const midiNote = openMidi + fret;
      const noteIdx = midiNote % 12;
      if (
        scale.includes(noteIdx) &&
        !isDuplicateOnLowerStrings(midiNote, stringIdx)
      ) {
        notesOnString.push({ fret, midiNote });
      }
    }

    // Limit notes per string
    let maxNotes =
      intervals.length === SCALE_FORMULAS.pentatonic.length ? 2 : 3;
    let notesToRender = [];
    const openNote = notesOnString.find((n) => n.fret === 0);
    const frettedNotes = notesOnString.filter((n) => n.fret !== 0);
    if (openNote) {
      notesToRender.push(openNote);
      notesToRender.push(...frettedNotes.slice(0, maxNotes - 1));
    } else {
      notesToRender = frettedNotes.slice(0, maxNotes);
    }

    // Render notes
    notesToRender.forEach(({ fret, midiNote }) => {
      const noteIdx = midiNote % 12;
      const x = paddingLeft + fretWidth * (fret - startFret + 0.5);
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("cx", x);
      circle.setAttribute("cy", y);
      circle.setAttribute("r", 12);
      circle.setAttribute("fill", noteIdx === rootIdx ? "#ff6347" : "#333");
      circle.setAttribute("stroke", "#fff");
      circle.setAttribute("stroke-width", 2);
      svg.appendChild(circle);

      const tooltip = document.createElementNS(svgNS, "title");
      tooltip.textContent = noteNameWithOctave(midiNote);
      circle.appendChild(tooltip);

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
    });
  }

  return svg;
}
