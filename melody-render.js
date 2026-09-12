// Notation renderer — a thin wrapper over VexFlow 5.0.0, which is loaded from
// CDN in index.html as the global `VexFlow` alongside html2canvas, jsPDF and
// SortableJS. This module is the ONLY file that touches it, so it stays
// swappable, the same containment `guitar-chords.js` gives chord shapes.
//
// It draws melodies and drum beats alike: a beat is a melody with
// `clef: "drums"`, and the differences are local to a few branches here.
//
// This replaced a hand-rolled Bravura/SMuFL renderer. That version worked, but
// engraving is a deep rulebook — beaming, key signatures, tuplets, multi-voice
// and beam-break rules all interact — and matching it by hand is open-ended
// work. Three objections had been raised against VexFlow; all three were
// measured against the real library and all three were wrong:
//
//   - **Theming is free.** VexFlow writes colours as SVG *presentation
//     attributes* (`fill`/`stroke`), which ANY CSS rule outranks. So the
//     `.ms-*` rules in styles.css recolour it for dark/light and
//     `.pdf-capture` exactly as `.gc-*` and `.gs-*` do — no JS styling options.
//   - **Notes stay addressable.** Each StaveNote's painted group takes our
//     `data-event-index`, so `melody-editor.js` was untouched by this swap.
//   - **No webfont fetch.** 5.x draws glyphs as <text> in Bravura, but ships
//     the faces as base64 `data:font/woff2` URIs registered at load, so there
//     is no network request, no CORS, and no fonts.ready race.
//
// ---- On the pinned version, which is NOT arbitrary ----
//
// Do not "fix" this to a cdnjs URL. **Every cdnjs `vexflow` 4.x entry serves
// VexFlow 3.0.9** (2019): the npm package carries a stale legacy `releases/`
// directory that was never rebuilt, cdnjs mirrors that directory, and so
// 4.2.2 and 4.2.5 there are byte-identical and log "This page uses version
// 3.0.9, which is no longer supported." This file was first written against
// that build without realising it, which is why its API notes were all wrong:
// 3.0.9 wants `addModifier(index, modifier)`, has no `Dot.buildAndAttach`, and
// exposes no `getSVGElement()`. Real builds live under `build/`, and 4.2.6 is
// a GitHub release that was never published to npm at all.
//
// 5.0.0's API is the documented one: `addModifier(modifier, index)`,
// `Dot.buildAndAttach`, `getSVGElement()` on notes AND tab notes, camelCase
// options (`numBeats`/`beatValue`, `StaveTie({firstNote, lastNote})` — the
// snake_case spellings throw), and the global is `VexFlow`, not `Vex.Flow`.
//
// This module owns no DOM state and no melody state — it reads what it is
// handed and returns a fresh SVGSVGElement, the same contract as
// renderScaleSVG and renderChordDiagram.

import {
  layoutBars,
  spellNote,
  assignTab,
  drumVoiceForMidi,
  isDrumMelody,
} from "./melody-model.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// ---- Geometry ----
//
// VexFlow's own staff spacing is 10px between lines, so a diatonic step (a
// line or the space above it) is half that. These are not free parameters:
// the editor inverts clicks against `data-step-px`, which must be whatever
// VexFlow actually drew. They are read back from the stave after rendering
// rather than assumed — these constants only size the canvas beforehand.
const LINE_GAP = 10;
const STEP = LINE_GAP / 2;
const TOP_STEP_OFFSET = 8; // 5 lines = 4 gaps = 8 diatonic steps, bottom to top

const CLEF_BAR_EXTRA = 66; // clef + time signature, first bar only
const ITEM_WIDTH = 42; // room per note before VexFlow's formatter fine-tunes
const MIN_BAR_WIDTH = 150;
const PAD_LEFT = 10;
const PAD_RIGHT = 16;
const MIN_TOP_PAD = 34; // ledger lines and the treble clef's own upward reach
const MIN_BOTTOM_PAD = 30;
const EXTENT_BUFFER = 10;
const GRAND_GAP = 90; // treble bottom line to bass top line
const TAB_GAP = 52; // staff bottom line to tab top line
const TAB_HEIGHT = 6 * 13;

// Which staffStep sits on each stave's bottom line. Shared with
// melody-model.js's spellNote numbering, and republished to the editor as
// `data-stave-ref-bottom` so it can invert a click without duplicating this.
const CLEF_REF = {
  treble: { bottom: 30 }, // E4
  bass: { bottom: 18 }, // G2
  // Drum-set positions are written against a treble staff — kick in the bottom
  // space, snare in the third space — so the percussion stave shares treble's
  // reference even though nothing on it is a pitch.
  percussion: { bottom: 30 },
};

// The vertical reach of the drum voices, in staffSteps: kick (F4, step 31) up
// to crash (A5, step 40). Fixed rather than derived from the notes present,
// because a drum "midi" is a GM percussion number and spellNote would read it
// as a pitch — 36 is not a C2 sitting four ledger lines down.
const DRUM_EXTENT = { min: 30, max: 40 };

// melody-model speaks {den, dots}; VexFlow speaks a duration code plus a Dot
// modifier per dot.
const VF_DURATION = { 1: "w", 2: "h", 4: "q", 8: "8", 16: "16" };

// Zoom bounds. Below 1 notation stops being readable at all; above 3 a melody
// outgrows any column it could be placed in.
export const MIN_SCALE = 1;
export const MAX_SCALE = 3;

export function clampScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));
}

function flow() {
  if (typeof window === "undefined") return null;
  // 5.x exposes `VexFlow`; 3.x/4.x exposed `Vex.Flow`. The fallback is not
  // support for the old one — the API differs enough that it would not work —
  // it just keeps a wrong-version page from throwing before the placeholder.
  return window.VexFlow || (window.Vex && window.Vex.Flow) || null;
}

// The painted element for a drawable. 5.x provides getSVGElement() on notes
// AND tab notes; the 3.0.9 build this used to run against had neither, which
// is why tab notes could not be addressed at all back then.
function elementOf(drawable) {
  if (!drawable) return null;
  if (typeof drawable.getSVGElement === "function") {
    try {
      return drawable.getSVGElement() || null;
    } catch (_) {
      return null;
    }
  }
  return (drawable.attrs && drawable.attrs.el) || null;
}

// VexFlow classes noteheads and stems but leaves beams, ties and rests as
// anonymous paths. Tagging what we create gives the tests — and any future
// CSS — stable hooks that belong to us, the same reasoning behind stamping
// `data-event-index` rather than relying on VexFlow's own element identity.
function markAs(drawable, cls) {
  const node = elementOf(drawable);
  if (node && node.classList) node.classList.add(cls);
  return !!node;
}

// Beams and ties expose NO painted element (unlike a StaveNote, which has
// attrs.el), so they cannot be tagged after the fact. The SVG context can wrap
// whatever is drawn inside it in a classed <g> instead, which is the only hook
// available for them.
function inGroup(ctx, cls, draw) {
  const canGroup =
    typeof ctx.openGroup === "function" && typeof ctx.closeGroup === "function";
  if (canGroup) {
    // openGroup PREFIXES the name it is given with "vf-", so asking for
    // "ms-beam" yields class "vf-ms-beam". It hands back the <g> though, so
    // put the class we actually want on it rather than matching their scheme.
    const g = ctx.openGroup(cls);
    if (g && g.classList) g.classList.add(cls);
  }
  try {
    draw();
  } finally {
    if (canGroup) ctx.closeGroup();
  }
}

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
  return node;
}

// ---- Translating our model into VexFlow's vocabulary ----

// spellNote already decides letter and accidental from the key; VexFlow wants
// them glued together as "c#/4".
function vfKey(midi, keyRoot) {
  const s = spellNote(midi, keyRoot);
  return `${s.letter.toLowerCase()}${s.accidental}/${s.octave}`;
}

function durationCode(item) {
  return VF_DURATION[item.den] || "q";
}

// Which stave a pitch belongs on. Only a grand staff has a choice to make.
function routeIndex(staveKeys, midi) {
  if (staveKeys.length === 1) return 0;
  return midi >= 60 ? 0 : 1;
}

// How far above and below each stave's own five lines the music actually
// reaches, in staffSteps. The canvas is sized from this rather than from a
// flat margin — a flat margin regardless of content is exactly how a note a
// few ledger lines out ends up drawn outside the SVG's own viewBox, which the
// previous renderer learned the hard way and VexFlow does not protect against
// (it will happily paint above y=0).
function staveExtent(melody, staveKeys) {
  const out = staveKeys.map((key) => ({
    key,
    bottom: CLEF_REF[key].bottom,
    min: CLEF_REF[key].bottom,
    max: CLEF_REF[key].bottom + TOP_STEP_OFFSET,
  }));
  // Drum positions are fixed by voice, not derived from the notes present — see
  // DRUM_EXTENT. Reading their GM numbers as pitches would size the canvas for
  // notes several ledger lines below the staff that are not drawn there.
  if (isDrumMelody(melody)) {
    out[0].min = Math.min(out[0].min, DRUM_EXTENT.min);
    out[0].max = Math.max(out[0].max, DRUM_EXTENT.max);
    return out;
  }
  (melody.events || []).forEach((event) => {
    if (event.rest) return;
    (event.notes || []).forEach((n) => {
      const slot = out[routeIndex(staveKeys, n.midi)];
      const step = spellNote(n.midi, melody.keyRoot).staffStep;
      if (step < slot.min) slot.min = step;
      if (step > slot.max) slot.max = step;
    });
  });
  return out;
}

function staveKeysFor(melody) {
  if (melody.clef === "grand") return ["treble", "bass"];
  if (melody.clef === "bass") return ["bass"];
  if (melody.clef === "drums") return ["percussion"];
  return ["treble"]; // guitar reads treble, with a tab stave under it
}

function barWidth(bar, isFirst) {
  const base = Math.max(MIN_BAR_WIDTH, ITEM_WIDTH * Math.max(1, bar.items.length));
  return base + (isFirst ? CLEF_BAR_EXTRA : 0);
}

// ---- Rendering ----

export function renderMelodySVG(melody, opts = {}) {
  const showTab = opts.showTab != null ? opts.showTab : melody.clef === "guitar";
  // Zoom is applied to the DECLARED width/height only; the viewBox stays in
  // VexFlow's own user space. That is what keeps it free: `data-step-px` and
  // `data-stave-bottom-y` are user-space coordinates, and the editor inverts
  // clicks through getScreenCTM(), which already folds in the viewBox→viewport
  // ratio. Scaling by re-rendering at a larger size would instead change
  // VexFlow's engraving decisions, and scaling with a CSS transform would leave
  // the element's layout box at the old size.
  const scale = clampScale(opts.scale);

  // The app is zero-build and loads VexFlow from a CDN, so it can genuinely be
  // absent (offline, blocked). Degrade to a readable message rather than
  // throwing inside whatever tab is drawing.
  if (!flow()) return renderPlaceholder("Notation library unavailable.");

  try {
    return renderScore(melody, { showTab, scale });
  } catch (e) {
    return renderPlaceholder("Could not draw this melody.");
  }
}

function renderPlaceholder(message) {
  const svg = el("svg", {
    class: "ms-score ms-placeholder-svg",
    width: 280,
    height: 60,
    viewBox: "0 0 280 60",
  });
  const text = el("text", {
    class: "ms-placeholder",
    x: 140,
    y: 34,
    "text-anchor": "middle",
  });
  text.textContent = message;
  svg.appendChild(text);
  return svg;
}

function renderScore(melody, { showTab, scale = 1 }) {
  const VF = flow();
  // Tab positions are derived from pitch, never stored, so they are recomputed
  // here on every draw — that is what stops a fret going stale after an edit.
  if (showTab) assignTab(melody);

  const bars = layoutBars(melody);
  const staveKeys = staveKeysFor(melody);
  const extents = staveExtent(melody, staveKeys);

  // Vertical plan, top down, sized from real content on both ends.
  const topPad = Math.max(
    MIN_TOP_PAD,
    (extents[0].max - (CLEF_REF[staveKeys[0]].bottom + TOP_STEP_OFFSET)) * STEP + EXTENT_BUFFER
  );
  const staveTops = [];
  let y = topPad;
  staveKeys.forEach((key, i) => {
    staveTops.push(y);
    y += TOP_STEP_OFFSET * STEP; // the five lines themselves
    if (i < staveKeys.length - 1) y += GRAND_GAP;
  });
  const lastStaffBottomY = y;
  const tabTop = showTab ? lastStaffBottomY + TAB_GAP : null;

  const last = extents[extents.length - 1];
  const bottomPad = Math.max(
    MIN_BOTTOM_PAD,
    (CLEF_REF[staveKeys[staveKeys.length - 1]].bottom - last.min) * STEP + EXTENT_BUFFER
  );
  const height = showTab
    ? tabTop + TAB_HEIGHT + EXTENT_BUFFER
    : lastStaffBottomY + bottomPad;

  const widths = bars.map((bar, i) => barWidth(bar, i === 0));
  const width = PAD_LEFT + widths.reduce((a, b) => a + b, 0) + PAD_RIGHT;

  // VexFlow renders into a container element. It is attached offscreen rather
  // than left detached because the final size is taken from getBBox() below,
  // and getBBox reports zeros for a node that was never in the document.
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:visible;";
  document.body.appendChild(host);
  const renderer = new VF.Renderer(host, VF.Renderer.Backends.SVG);
  renderer.resize(width, height);
  const ctx = renderer.getContext();

  const drawn = []; // { item, note } in score order, for ties
  // Everything whose extent should count towards the final canvas size. Staves
  // carry their clef and time signature, so their box already includes the
  // reach those glyphs add.
  const measurables = [];
  let x = PAD_LEFT;
  let firstStave = null;

  bars.forEach((bar, barIndex) => {
    const isFirst = barIndex === 0;
    const isLast = barIndex === bars.length - 1;
    const w = widths[barIndex];

    const staves = staveKeys.map((key, i) => {
      const stave = new VF.Stave(x, staveTops[i], w);
      if (isFirst) {
        stave.addClef(key);
        stave.addTimeSignature(`${melody.timeSig.num}/${melody.timeSig.den}`);
      }
      if (isLast) stave.setEndBarType(VF.Barline.type.END);
      stave.setContext(ctx).draw();
      measurables.push(stave);
      return stave;
    });
    if (!firstStave) firstStave = staves[0];

    // A grand staff gets its brace and connecting line, once.
    if (isFirst && staves.length > 1) {
      new VF.StaveConnector(staves[0], staves[1])
        .setType(VF.StaveConnector.type.BRACE)
        .setContext(ctx)
        .draw();
      new VF.StaveConnector(staves[0], staves[1])
        .setType(VF.StaveConnector.type.SINGLE_LEFT)
        .setContext(ctx)
        .draw();
    }

    const tabStave = showTab
      ? new VF.TabStave(x, tabTop, w).setContext(ctx)
      : null;
    if (tabStave) {
      if (isFirst) tabStave.addClef("tab");
      tabStave.draw();
      measurables.push(tabStave);

    }

    if (!bar.items.length) {
      x += w;
      return;
    }

    // Ask the stave how much room it actually has for notes rather than
    // re-deriving it: the stave already subtracted whatever the clef and time
    // signature took, and subtracting CLEF_BAR_EXTRA again here crammed a
    // whole bar into the left half of its own measure.
    const noteArea =
      typeof staves[0].getNoteEndX === "function"
        ? staves[0].getNoteEndX() - staves[0].getNoteStartX()
        : w - (isFirst ? CLEF_BAR_EXTRA : 0);

    drawBar({
      VF,
      ctx,
      bar,
      staves,
      staveKeys,
      tabStave,
      melody,
      width: noteArea - 12,
      drawn,
    });

    x += w;
  });

  // Ties, including across a barline. layoutBars already split a long note
  // into legal fragments and flagged them, so this only has to join what it
  // marked rather than work out where a tie belongs.
  for (let i = 0; i < drawn.length - 1; i++) {
    if (!drawn[i].item.tiedTo) continue;
    const a = drawn[i];
    const b = drawn[i + 1];
    if (!a.note || !b.note || a.staveIndex !== b.staveIndex) continue;
    try {
      const tie = new VF.StaveTie({ firstNote: a.note, lastNote: b.note });
      inGroup(ctx, "ms-tie", () => tie.setContext(ctx).draw());
    } catch (_) {
      // A tie whose ends VexFlow cannot connect is cosmetic; never let it take
      // the whole score down.
    }
  }

  const svg = host.querySelector("svg");
  svg.setAttribute("class", "ms-score");

  // Size from what was actually laid out, not from the estimate the canvas was
  // created with. Sizing by arithmetic means knowing how far every glyph
  // reaches, which is VexFlow's business rather than ours — the treble clef's
  // descender alone put 25px below the declared height on every treble melody,
  // including an EMPTY one, where there is no note to be "far" from the staff.
  //
  // **Ask VexFlow, do not measure the DOM.** This used to call
  // `svg.getBBox()`, which is wrong now that 5.x draws every glyph as <text> in
  // Bravura: `getBBox` on an SVG <text> returns the FONT'S LINE BOX, not the
  // glyph's ink, so a 10px notehead measured 160px tall. Every score came out
  // ~130px taller than its own contents, which is a lot of blank paper on a
  // sheet — and it was invisible for a while because the inline-style bug was
  // separately squeezing the result back down.
  //
  // VexFlow's own `getBoundingBox()` is computed from its metrics, which encode
  // real glyph extents: for a 40px stave with a treble clef it reports 130,
  // correctly including the clef's reach. That is the number we want.
  //
  // The union with (0,0,width,height) keeps the declared box from ever
  // shrinking below the layout that was planned, and a negative minY is
  // handled by the viewBox rather than by shifting anything: getScreenCTM
  // already accounts for the viewBox, so the editor's click→pitch inverse
  // keeps working unchanged.
  let viewMinX = 0;
  let viewMinY = 0;
  let viewW = width;
  let viewH = height;
  {
    let minX = 0;
    let minY = 0;
    let maxX = width;
    let maxY = height;
    let measured = false;
    const absorb = (obj) => {
      if (!obj || typeof obj.getBoundingBox !== "function") return;
      let b;
      try {
        b = obj.getBoundingBox();
      } catch (_) {
        return;
      }
      if (!b) return;
      const w = b.w != null ? b.w : b.width;
      const h = b.h != null ? b.h : b.height;
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return;
      if (!Number.isFinite(w) || !Number.isFinite(h)) return;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + w);
      maxY = Math.max(maxY, b.y + h);
      measured = true;
    };
    measurables.forEach(absorb);
    drawn.forEach((d) => absorb(d.note));
    if (measured) {
      viewMinX = Math.floor(minX) - 2;
      viewMinY = Math.floor(minY) - 2;
      viewW = Math.ceil(maxX) + 2 - viewMinX;
      viewH = Math.ceil(maxY) + 2 - viewMinY;
    }
  }

  const outW = Math.round(viewW * scale);
  const outH = Math.round(viewH * scale);
  svg.setAttribute("viewBox", `${viewMinX} ${viewMinY} ${viewW} ${viewH}`);
  svg.setAttribute("width", String(outW));
  svg.setAttribute("height", String(outH));
  svg.setAttribute("data-scale", String(scale));
  // The INLINE STYLE is what actually governs the painted size. VexFlow's
  // `renderer.resize()` writes `style.width`/`style.height` in px, and an inline
  // style outranks a presentation attribute — so setting the attributes alone
  // changes nothing on screen. It also means the size resize() was called with
  // is the pre-measurement ESTIMATE: leaving it there displayed every score
  // squeezed into a box narrower than the viewBox it had grown to.
  svg.style.width = `${outW}px`;
  svg.style.height = `${outH}px`;

  // The primary stave's geometry, published so the editor can turn a click's y
  // back into a staffStep without duplicating any of this. Read back off what
  // VexFlow actually drew rather than from the constants above, so the two can
  // never drift. These are user-space coordinates, which is what the editor's
  // getScreenCTM inverse expects — so they stay correct even when the viewBox
  // above was shifted to take in ink above y=0.
  if (firstStave) {
    svg.setAttribute("data-stave-bottom-y", String(firstStave.getBottomLineY()));
    svg.setAttribute("data-stave-ref-bottom", String(CLEF_REF[staveKeys[0]].bottom));
    svg.setAttribute("data-step-px", String(firstStave.getSpacingBetweenLines() / 2));
  }

  svg.remove();
  host.remove();
  return svg;
}

// One bar: build a voice per stave, format them together so the staves stay
// vertically aligned, then draw.
function drawBar({ VF, ctx, bar, staves, staveKeys, tabStave, melody, width, drawn }) {
  const perStave = staves.map(() => []);
  const realNotes = staves.map(() => []);
  const tabNotes = [];

  bar.items.forEach((item) => {
    const event = item.event;
    const isRest = event.rest || !(event.notes || []).length;
    const code = durationCode(item);
    // A rest lives on the first stave; the others get a spacer so every voice
    // still accounts for the same ticks and the staves stay aligned.
    const target = isRest
      ? 0
      : routeIndex(staveKeys, event.notes[0].midi);

    staves.forEach((_, i) => {
      if (i !== target) {
        perStave[i].push(new VF.GhostNote({ duration: code }));
        return;
      }
      if (isRest) {
        const rest = new VF.StaveNote({
          keys: [staveKeys[i] === "bass" ? "d/3" : "b/4"],
          duration: `${code}r`,
          clef: staveKeys[i],
        });
        for (let d = 0; d < (item.dots || 0); d++) rest.addModifier(new VF.Dot(), 0);
        perStave[i].push(rest);
        drawn.push({ item, note: rest, staveIndex: i, rest: true });
        return;
      }

      // A drum "note" is a voice, not a pitch: its staff position and notehead
      // come from DRUM_VOICES, and it never takes an accidental. VexFlow reads
      // a third segment in a key as the notehead glyph, so "g/5/x2" is a hi-hat
      // cross on the space above the top line.
      const drums = isDrumMelody(melody);
      const keys = drums
        ? event.notes.map((n) => {
            const v = drumVoiceForMidi(n.midi);
            if (!v) return "c/5";
            return v.head ? `${v.key}/${v.head}` : v.key;
          })
        : event.notes.map((n) => vfKey(n.midi, melody.keyRoot));
      const note = new VF.StaveNote({ keys, duration: code, clef: staveKeys[i] });
      // Stems up for the whole kit. Left to itself VexFlow picks a direction per
      // chord from its average pitch, so a hat+kick chord stems DOWN and drags
      // its beam below the staff while a hat alone stems up — the beam then
      // zigzags across the staff. Real drum notation solves this with two
      // voices (cymbals up, kick down); one voice with a consistent direction
      // is the honest simplification, and it is at least consistent.
      if (drums) note.setStemDirection(VF.Stem.UP);
      for (let d = 0; d < (item.dots || 0); d++) note.addModifier(new VF.Dot(), 0);
      if (!drums) {
        event.notes.forEach((n, ni) => {
          const acc = spellNote(n.midi, melody.keyRoot).accidental;
          // A tied continuation does not restate its accidental.
          if (acc && !item.tiedFrom) note.addModifier(new VF.Accidental(acc), ni);
        });
      }
      perStave[i].push(note);
      realNotes[i].push(note);
      drawn.push({ item, note, staveIndex: i, rest: false });
    });

    if (tabStave) {
      const positions = isRest
        ? []
        : event.notes
            .filter((n) => Number.isInteger(n.stringIdx) && Number.isInteger(n.fret))
            // assignTab indexes strings low→high (0 = low E), matching
            // guitar-chords.js; VexFlow's `str` is 1-based from the HIGH e.
            .map((n) => ({ str: 6 - n.stringIdx, fret: n.fret }));
      tabNotes.push(
        positions.length
          ? new VF.TabNote({ positions, duration: code })
          : new VF.GhostNote({ duration: code })
      );
    }
  });

  const voices = [];
  perStave.forEach((tickables, i) => {
    const v = new VF.Voice({
      numBeats: melody.timeSig.num,
      beatValue: melody.timeSig.den,
    })
      // A bar mid-edit is routinely incomplete; strict mode would throw on it.
      .setStrict(false)
      .addTickables(tickables);
    v.__stave = staves[i];
    voices.push(v);
  });
  let tabVoice = null;
  if (tabStave && tabNotes.length) {
    tabVoice = new VF.Voice({
      numBeats: melody.timeSig.num,
      beatValue: melody.timeSig.den,
    })
      .setStrict(false)
      .addTickables(tabNotes);
    tabVoice.__stave = tabStave;
  }

  const all = tabVoice ? voices.concat([tabVoice]) : voices;
  const formatter = new VF.Formatter().joinVoices(voices);
  // formatToStave justifies to the stave's OWN note area. Passing a width to
  // format() instead left every bar's notes bunched into its left half, because
  // that width is a minimum to fit rather than a span to fill. The tab voice
  // shares the treble stave's x range, so one stave governs them all.
  if (typeof formatter.formatToStave === "function") {
    formatter.formatToStave(all, staves[0]);
  } else {
    formatter.format(all, Math.max(60, width));
  }

  // Beams — the thing the hand-rolled renderer deferred, and the single biggest
  // reason for this swap. One line per stave.
  //
  // generateBeams re-decides stem direction per group from the notes' average
  // pitch, which silently undoes the stems-up we set on drum notes above. It
  // has to be told to keep them.
  const beamConfig = isDrumMelody(melody)
    ? { maintainStemDirections: true, stemDirection: VF.Stem.UP }
    : undefined;
  const beams = [];
  realNotes.forEach((notes) => {
    if (notes.length > 1) beams.push(...VF.Beam.generateBeams(notes, beamConfig));
  });

  all.forEach((v) => v.draw(ctx, v.__stave));
  beams.forEach((b) => {
    inGroup(ctx, "ms-beam", () => b.setContext(ctx).draw());
  });

  // Stamp our event index onto each painted note group. This is the contract
  // melody-editor.js hit-tests against, and the reason the editor survived
  // this renderer being replaced wholesale.
  drawn.forEach(({ item, note, rest }) => {
    const node = elementOf(note);
    if (!node) return;
    node.setAttribute("data-event-index", String(item.eventIndex));
    // A rest is a StaveNote to VexFlow and carries the same vf-notehead class
    // as a pitched note, so there is otherwise no way to tell them apart.
    node.classList.add(rest ? "ms-rest" : "ms-note");
  });
}
