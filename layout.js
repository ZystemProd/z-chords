// The Layout tab: compose A4 pages from content made on the other tabs.
//
// This module owns its DOM the way main.js owns the guitar scale tab. It does
// not import script.js — script.js calls `initLayout(deps)` and hands in the few
// functions only it can provide. One direction, no module cycle, and the layout
// stays testable against fake deps.
//
// Everything it needs to know about mm and pages lives in layout-model.js; this
// file is the renderer, the drag wiring and the persistence.

import {
  LAYOUT_COLUMNS,
  PAGE_W_MM,
  PAGE_H_MM,
  PAGE_MARGIN_MM,
  CONTENT_W_MM,
  // (CONTENT_H_MM is the model's business; the UI never needs it directly.)
  DEFAULT_GUTTER_MM,
  DEFAULT_ROW_GAP_MM,
  createLayout,
  normalizeLayout,
  createBlock,
  clampSpan,
  defaultSpan,
  packRows,
  paginateRows,
} from "./layout-model.js";
import { renderScaleSVG, scaleWindow } from "./guitar.js";
import { SCALE_FORMULAS } from "./theory.js";
import { renderMelodySVG } from "./melody-render.js";
import { assignTab } from "./melody-model.js";

const LAYOUT_KEY = "cv-layout";
const LAYOUT_SCALE_KEY = "cv-layout-scale";

// Injected by script.js. Nothing here reaches into the board directly.
let deps = {
  readBoardState: () => ({ sections: [], title: "", subtitle: "" }),
  buildCardElement: null,
  openPdfPreviewModal: () => {},
  isTwoHandsMode: () => false,
};

let doc = createLayout();
let boards = { piano: null, guitar: null };
let els = null;
let flowSortable = null;
let librarySortables = [];

// ---- Persistence ----

function loadLayout() {
  let raw = null;
  try {
    raw = localStorage.getItem(LAYOUT_KEY);
  } catch (_) {}
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch (_) {}
  doc = normalizeLayout(parsed);
}

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(doc));
  } catch (_) {}
}

// Song files carry the sheet alongside both boards — see buildSongFile.
export function layoutForSongFile() {
  return doc && doc.blocks.length ? doc : null;
}

export function applyLayoutFromSongFile(raw) {
  // A v1 song file has no layout at all; that is not an error, it just means
  // the sheet stays as it is rather than being blanked.
  if (raw === undefined) return;
  doc = normalizeLayout(raw);
  saveLayout();
  if (els) refreshLayout();
}

// ---- Reading the boards ----
//
// The layout sheet is cross-instrument, but `#boards` only ever holds the board
// of the tab you were last on, so both are read from localStorage instead.
//
// Deliberately read-only. It would be natural to flush the on-screen board
// first, but `boardInstrument()` reports "piano" while this tab is up, so a
// flush here could write the wrong board's chords over the piano's. It is also
// unnecessary: `setInstrument` flushes the outgoing board before switching, so
// by the time this runs localStorage is already current.
function readBoards() {
  boards = {
    piano: deps.readBoardState("piano"),
    guitar: deps.readBoardState("guitar"),
    // Drums carries beats and no chords, but it is a board like any other as
    // far as this tab is concerned: blocks reference its content by id exactly
    // the same way.
    drums: deps.readBoardState("drums"),
  };
}

function findSection(instrument, sectionId) {
  const board = boards[instrument];
  if (!board || !Array.isArray(board.sections)) return null;
  return board.sections.find((s) => s && s.id === sectionId) || null;
}

function resolveRef(ref) {
  if (!ref || !ref.instrument) return null;
  const section = findSection(ref.instrument, ref.sectionId);
  if (!section) return null;
  if (!ref.chordId) return { section, chord: null };
  const chord = (section.chords || []).find((c) => c && c.id === ref.chordId);
  if (!chord) return null;
  return { section, chord };
}

// ---- Geometry ----

function pxPerMm() {
  if (!els || !els.flow) return 4;
  const raw = getComputedStyle(els.flow).getPropertyValue("--layout-px-per-mm");
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

function contentPx() {
  return CONTENT_W_MM * pxPerMm();
}

// ---- Block content ----

// SCALE_FORMULAS entries can repeat a degree; the fretboard wants each once,
// in order — the same normalisation the guitar scale tab applies.
function uniqueIntervals(intervals) {
  if (!Array.isArray(intervals)) return [];
  return Array.from(new Set(intervals)).sort((a, b) => a - b);
}

// The mode's human label, taken from the guitar tab's own <select> so the two
// never drift. Falls back to the raw key if that select isn't in the DOM.
function modeLabel(mode) {
  const src = document.getElementById("guitarMode");
  if (src) {
    const opt = src.querySelector(`option[value="${mode}"]`);
    if (opt) return opt.textContent.trim();
  }
  return mode;
}

// Copy an existing select's options (optgroups included) rather than restating
// the 17-mode list a third time.
function cloneOptionsFrom(sourceId, select) {
  const src = document.getElementById(sourceId);
  if (!src) return false;
  Array.from(src.children).forEach((child) =>
    select.appendChild(child.cloneNode(true))
  );
  return true;
}

function currentGuitarTabScale() {
  const key = document.getElementById("guitarKey");
  const mode = document.getElementById("guitarMode");
  return {
    root: key ? key.value : "A",
    mode: mode ? mode.value : "minorPentatonic",
    shapeIndex: 0,
    labelMode: "interval",
    view: "shape",
  };
}

// Editor-only controls that live inside the block. They are `.no-drag` so a
// press never starts a drag, and they are stripped before export along with the
// rest of the chrome.
function fretboardControls(block) {
  const row = document.createElement("div");
  row.className = "lb-controls no-drag";
  const s = block.scale;

  const commit = () => {
    saveLayout();
    render();
  };

  const rootSel = document.createElement("select");
  rootSel.className = "no-drag";
  rootSel.setAttribute("aria-label", "Scale root");
  if (!cloneOptionsFrom("guitarKey", rootSel)) {
    ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"].forEach(
      (n) => rootSel.appendChild(new Option(n, n))
    );
  }
  rootSel.value = s.root;
  rootSel.addEventListener("change", () => {
    s.root = rootSel.value;
    commit();
  });

  const modeSel = document.createElement("select");
  modeSel.className = "no-drag";
  modeSel.setAttribute("aria-label", "Scale mode");
  if (!cloneOptionsFrom("guitarMode", modeSel)) {
    Object.keys(SCALE_FORMULAS).forEach((m) =>
      modeSel.appendChild(new Option(m, m))
    );
  }
  modeSel.value = s.mode;
  modeSel.addEventListener("change", () => {
    s.mode = modeSel.value;
    // Whole tone has six shapes, CAGED modes five: a shape index carried over
    // from the previous mode can be out of range, so bring it back in.
    const intervals = uniqueIntervals(SCALE_FORMULAS[s.mode]);
    if (intervals.length) {
      const count = scaleWindow(s.root, s.mode, 0, intervals).starts.length || 1;
      s.shapeIndex = Math.min(Number(s.shapeIndex) || 0, count - 1);
    }
    commit();
  });

  const viewBtn = document.createElement("button");
  viewBtn.type = "button";
  viewBtn.className = "no-drag";
  const syncView = () => {
    viewBtn.textContent = s.view === "full" ? "Full neck" : "Shape";
  };
  syncView();
  viewBtn.title = "Switch between one CAGED shape and the whole neck";
  viewBtn.addEventListener("click", () => {
    s.view = s.view === "full" ? "shape" : "full";
    commit();
  });

  const labelBtn = document.createElement("button");
  labelBtn.type = "button";
  labelBtn.className = "no-drag";
  labelBtn.textContent = s.labelMode === "note" ? "Notes" : "Intervals";
  labelBtn.title = "Label the dots with note names or scale degrees";
  labelBtn.addEventListener("click", () => {
    s.labelMode = s.labelMode === "note" ? "interval" : "note";
    commit();
  });

  row.appendChild(rootSel);
  row.appendChild(modeSel);
  row.appendChild(viewBtn);
  row.appendChild(labelBtn);

  // The shape stepper is meaningless on the full neck, so it only appears
  // alongside a shape.
  if (s.view !== "full") {
    const stepper = document.createElement("span");
    stepper.className = "lb-shape-stepper no-drag";

    const shapeCount = () => {
      const intervals = uniqueIntervals(SCALE_FORMULAS[s.mode]);
      if (!intervals.length) return 1;
      return scaleWindow(s.root, s.mode, 0, intervals).starts.length || 1;
    };

    const step = (delta) => () => {
      const n = shapeCount();
      s.shapeIndex = (((Number(s.shapeIndex) || 0) + delta) % n + n) % n;
      commit();
    };

    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "no-drag";
    prev.innerHTML = "&#8592;";
    prev.setAttribute("aria-label", "Previous shape");
    prev.addEventListener("click", step(-1));

    const value = document.createElement("span");
    value.textContent = `${(Number(s.shapeIndex) || 0) + 1}/${shapeCount()}`;

    const next = document.createElement("button");
    next.type = "button";
    next.className = "no-drag";
    next.innerHTML = "&#8594;";
    next.setAttribute("aria-label", "Next shape");
    next.addEventListener("click", step(1));

    stepper.appendChild(prev);
    stepper.appendChild(value);
    stepper.appendChild(next);
    row.appendChild(stepper);
  }

  return row;
}

// ---- Melody blocks ----
//
// Melodies are BOARD content, authored on the Piano and Guitar tabs, not
// here — a sheet block references one by id exactly as section and chord
// blocks do, so editing a melody on its instrument tab updates every sheet
// that places it. The editor itself lives in melody-editor.js; this file
// only renders melodies read-only, like every other block.
function resolveMelodyRef(ref) {
  if (!ref || !ref.instrument) return null;
  const board = boards[ref.instrument];
  const list = (board && board.melodies) || [];
  return list.find((m) => m && m.id === ref.melodyId) || null;
}

function missingBlock(label) {
  const el = document.createElement("div");
  el.className = "lb-missing";
  el.textContent = `${label} — source removed`;
  return el;
}

function renderBlockContent(block) {
  if (block.type === "pagebreak") {
    const el = document.createElement("div");
    el.className = "lb-pagebreak";
    el.textContent = "Page break";
    return el;
  }

  if (block.type === "text") {
    const el = document.createElement("div");
    el.className = `lb-text lb-text-${block.style || "body"}`;
    el.contentEditable = "true";
    el.spellcheck = false;
    el.dataset.placeholder = "Type a note…";
    el.textContent = block.text || "";
    el.addEventListener("input", () => {
      block.text = el.textContent;
      saveLayout();
    });
    // Editing changes the block's height, so the page guides have to catch up —
    // but only once the user stops typing, not on every keystroke.
    el.addEventListener("blur", () => {
      block.text = el.textContent;
      saveLayout();
      repaginate();
    });
    return el;
  }

  if (block.type === "fretboard") {
    const s = block.scale || {};
    const root = s.root || "A";
    const mode = s.mode || "minorPentatonic";
    const intervals = uniqueIntervals(SCALE_FORMULAS[mode]);

    const host = document.createElement("div");
    host.className = "lb-fretboard";
    if (!intervals.length) {
      host.appendChild(missingBlock("Scale"));
      return host;
    }

    // "shape" narrows to one CAGED window, resolved by the same function the
    // guitar scale tab uses, so a printed shape is the shape that tab draws.
    // "full" leaves the window open and marks every scale tone on the neck.
    let opts = {
      labelMode: s.labelMode || "interval",
      showOpen: true,
      windowStart: null,
      windowWidth: 17,
    };
    let shownShape = null;
    if ((s.view || "shape") === "shape") {
      const win = scaleWindow(root, mode, Number(s.shapeIndex) || 0, intervals);
      opts = {
        labelMode: s.labelMode || "interval",
        windowStart: win.windowStart,
        windowWidth: win.windowWidth,
        showOpen: win.showOpen,
        fretShift: win.fretShift,
      };
      // scaleWindow clamps the index to the shapes this mode actually has, so
      // the caption reports what was drawn rather than what was asked for.
      shownShape = win.index + 1;
    }

    const caption = document.createElement("div");
    caption.className = "lb-fretboard-caption";
    caption.textContent =
      shownShape === null
        ? `${root} ${modeLabel(mode)}`
        : `${root} ${modeLabel(mode)} — shape ${shownShape}`;

    host.appendChild(caption);
    host.appendChild(renderScaleSVG(root, intervals, 1, 17, opts));
    return host;
  }

  if (block.type === "melody") {
    const melody = resolveMelodyRef(block.ref);
    if (!melody) return missingBlock("Melody");
    // Tab positions are derived from pitch, so they are recomputed here rather
    // than read from the stored melody — the same reason the editor recomputes
    // them on every change instead of persisting them.
    if (melody.clef === "guitar") assignTab(melody);

    const host = document.createElement("div");
    host.className = "lb-melody-host";
    host.appendChild(renderMelodySVG(melody, {}));

    const wrap = document.createElement("div");
    wrap.className = "lb-melody";
    wrap.appendChild(host);
    return wrap;
  }

  if (block.type === "chord") {
    const hit = resolveRef(block.ref);
    if (!hit || !hit.chord) return missingBlock("Chord");
    // interactive:false — a layout card is a picture of a chord. It has no
    // write path back to the board, which is what keeps the sheet from being a
    // second, competing editor.
    return deps.buildCardElement(hit.chord, {
      instrument: block.ref.instrument,
      interactive: false,
    });
  }

  if (block.type === "section") {
    const hit = resolveRef(block.ref);
    if (!hit) return missingBlock("Section");
    const { section } = hit;

    const wrap = document.createElement("div");
    wrap.className = "lb-section";

    if (block.showHeader !== false) {
      const h = document.createElement("h2");
      h.className = "lb-section-name";
      h.textContent = section.name || "";
      wrap.appendChild(h);
    }

    const grid = document.createElement("div");
    grid.className = "lb-section-chords";
    // Mirror the board's own column counts so a section looks on the sheet the
    // way it looks on the tab it came from — including the two-hands rule:
    // a three-octave keybed cannot share a row, so the board drops to one
    // column and so must this. Without it each card gets ~376px, and the
    // fit-to-width pass dutifully shrinks a 21-key keyboard to 47%.
    const twoHands =
      block.ref.instrument === "piano" && deps.isTwoHandsMode();
    grid.classList.add(
      block.ref.instrument === "guitar"
        ? "guitar-mode"
        : twoHands
        ? "piano-two-hands-mode"
        : "piano-mode"
    );
    (section.chords || []).forEach((chord) => {
      grid.appendChild(
        deps.buildCardElement(chord, {
          instrument: block.ref.instrument,
          interactive: false,
        })
      );
    });
    wrap.appendChild(grid);
    return wrap;
  }

  return missingBlock(block.type);
}

// ---- Rendering the flow ----

function blockLabel(block) {
  if (block.type === "pagebreak") return "Page break";
  if (block.type === "text") return "Text";
  if (block.type === "fretboard") {
    const s = block.scale || {};
    return `${s.root || "A"} ${modeLabel(s.mode || "minorPentatonic")}`;
  }
  if (block.type === "melody") {
    const m = resolveMelodyRef(block.ref);
    if (!m) return "Melody";
    return `${m.name || "Melody"} · ${block.ref.instrument}`;
  }
  const hit = resolveRef(block.ref);
  if (block.type === "chord") {
    return hit && hit.chord ? hit.chord.sym : "Chord";
  }
  if (block.type === "section") {
    const name = hit ? hit.section.name : "Section";
    return `${name} · ${block.ref.instrument}`;
  }
  return block.type;
}

function renderFlow() {
  const flow = els.flow;
  flow.innerHTML = "";
  flow.style.setProperty("--layout-columns", String(LAYOUT_COLUMNS));

  doc.blocks.forEach((block) => {
    const el = document.createElement("div");
    el.className = `layout-block lb-${block.type}`;
    el.dataset.blockId = block.id;
    el.style.gridColumn = `span ${clampSpan(block.span)}`;

    // Editor chrome. All of it is `.no-drag` so Sortable never starts a drag
    // from a button, and all of it is stripped before export.
    const chrome = document.createElement("div");
    chrome.className = "lb-chrome";

    const handle = document.createElement("span");
    handle.className = "lb-handle";
    handle.title = "Drag to reorder";
    handle.textContent = "⠿";

    const label = document.createElement("span");
    label.className = "lb-label";
    label.textContent = blockLabel(block);

    const spanBadge = document.createElement("span");
    spanBadge.className = "lb-span-badge no-drag";
    spanBadge.textContent = `${clampSpan(block.span)}/12`;

    const breakBtn = document.createElement("button");
    breakBtn.type = "button";
    breakBtn.className = "lb-break no-drag";
    breakBtn.title = "Start this block on a new page";
    breakBtn.setAttribute("aria-pressed", String(!!block.pageBreakBefore));
    breakBtn.textContent = "⏎";
    breakBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      block.pageBreakBefore = !block.pageBreakBefore;
      saveLayout();
      render();
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "lb-remove no-drag";
    removeBtn.title = "Remove from sheet";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      doc.blocks = doc.blocks.filter((b) => b.id !== block.id);
      saveLayout();
      render();
    });

    chrome.appendChild(handle);
    chrome.appendChild(label);
    chrome.appendChild(spanBadge);
    if (block.type !== "pagebreak") chrome.appendChild(breakBtn);
    chrome.appendChild(removeBtn);

    // `pdf-capture` on the body, not on the flow: a block sits on a white page,
    // so its contents must be inked for paper even while the app is in dark
    // mode — that is exactly what this class already does for the export. It is
    // scoped to the body so the editor chrome around it keeps theme colours.
    const body = document.createElement("div");
    body.className = "lb-body pdf-capture";
    body.appendChild(renderBlockContent(block));

    el.appendChild(chrome);
    // A fretboard has no source on a board to inherit from, so its settings
    // live on the block and are edited here rather than on the scale tab.
    if (block.type === "fretboard") {
      if (!block.scale) block.scale = currentGuitarTabScale();
      el.appendChild(fretboardControls(block));
    }
    el.appendChild(body);

    if (block.type !== "pagebreak") {
      const grip = document.createElement("div");
      grip.className = "lb-resize no-drag";
      grip.title = "Drag to resize (1–12 columns)";
      attachResize(grip, el, block, spanBadge);
      el.appendChild(grip);
    }

    if (block.pageBreakBefore) el.classList.add("lb-has-break");
    flow.appendChild(el);
  });
}

// ---- Span resize ----

function attachResize(grip, blockEl, block, badge) {
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const startSpan = clampSpan(block.span);
    // The flow is drawn at a fixed px width and then transformed to fit the
    // screen. The pointer moves in screen px, so the step has to be scaled by
    // the same factor or the drag runs at the wrong rate.
    const displayScale = currentDisplayScale();
    const gutterPx = DEFAULT_GUTTER_MM * pxPerMm();
    const colPx = (contentPx() - (LAYOUT_COLUMNS - 1) * gutterPx) / LAYOUT_COLUMNS;
    const stepPx = (colPx + gutterPx) * displayScale;

    let live = startSpan;

    const move = (ev) => {
      const delta = Math.round((ev.clientX - startX) / stepPx);
      const next = clampSpan(startSpan + delta);
      if (next === live) return;
      live = next;
      blockEl.style.gridColumn = `span ${next}`;
      if (badge) badge.textContent = `${next}/12`;
    };

    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      if (live !== startSpan) {
        block.span = live;
        saveLayout();
        // Full re-render, not just a repaginate: a keyboard's black keys are
        // positioned from measured white-key offsets, so they are only correct
        // for the width the card was built at.
        //
        // Deferred a frame because this runs inside the pointerup handler, and
        // re-rendering would tear out the grip that still holds the capture.
        requestAnimationFrame(render);
        return;
      }
      repaginate();
    };

    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
}

// ---- Measuring and page guides ----

// Fit each keyboard to its block by scaling it uniformly — never by reflowing
// it to a new width.
//
// A keyboard is one drawing, not a row of independent boxes: the white keys,
// the black keys sitting across their boundaries, and the note labels only look
// right in a fixed relationship to each other. Reflowing the bed thins the
// white keys while the black keys and the labels keep their own sizing, so a
// narrow block gets black keys wider than the white keys they sit between.
// Scaling the finished keyboard keeps every one of those relationships exact.
//
// It is also the only approach that cannot drift: the keyboard is painted at
// exactly the width its black keys were measured against when it was built.
function fitKeyboards(flow) {
  flow.querySelectorAll(".lb-body .piano-scroll").forEach((scroller) => {
    const piano = scroller.querySelector(".piano");
    if (!piano) return;

    // Reset, or each pass compounds the previous pass's scaling.
    piano.style.transform = "";
    scroller.style.height = "";

    const natural = piano.offsetWidth;
    const naturalH = piano.offsetHeight;
    const available = scroller.clientWidth;
    if (!natural || !available) return;

    // Only ever scale down. A block wider than the keyboard leaves it at its
    // natural size rather than blowing it up to fill the column.
    const k = Math.min(1, available / natural);

    // The transform goes on the *piano*, and the height on its untransformed
    // parent. Scaling the scroller instead would scale the height set on it
    // too, so the box ended up k² tall while the keyboard inside it was k —
    // and the difference was clipped off the bottom of every keyboard.
    if (k < 1) {
      piano.style.transformOrigin = "top left";
      piano.style.transform = `scale(${k})`;
    }
    // A transform does not affect layout, so the parent has to be told what the
    // scaled keyboard occupies or the block keeps the unscaled height.
    scroller.style.height = `${naturalH * k}px`;
  });
}

function measureBoxes(flow) {
  const scale = pxPerMm();
  return doc.blocks.map((block) => {
    const el = flow.querySelector(`[data-block-id="${block.id}"]`);
    return {
      blockId: block.id,
      span: clampSpan(block.span),
      // offsetHeight, never getBoundingClientRect: the flow sits inside a
      // transform: scale() wrapper, and getBoundingClientRect would multiply
      // every height by it.
      heightMm: el ? el.offsetHeight / scale : 0,
      pageBreakBefore: !!block.pageBreakBefore,
      isPageBreak: block.type === "pagebreak",
    };
  });
}

// Lay the page boundaries over the flow, and push the first block of each page
// down so the editor shows the same gaps the PDF will have.
function repaginate() {
  if (!els || !els.flow) return;
  const flow = els.flow;

  // Clear last pass's spacing before measuring, or the gaps compound.
  flow.querySelectorAll(".layout-block").forEach((el) => {
    el.style.marginTop = "";
  });

  // Order matters: scaling changes block heights, so it settles first.
  fitKeyboards(flow);

  const boxes = measureBoxes(flow);
  const pages = paginateRows(packRows(boxes, {}), {});
  const scale = pxPerMm();

  // Push each page's first row down to where the page actually starts.
  // The cursor starts at the flow's own top padding, which is the page margin —
  // starting it at 0 would over-report every gap by 10mm.
  let domY = PAGE_MARGIN_MM * scale;
  pages.forEach((rows, pageIndex) => {
    rows.forEach((row, rowIndex) => {
      const targetPx = (pageIndex * PAGE_H_MM + row.yMm) * scale;
      if (pageIndex > 0 && rowIndex === 0) {
        const gap = Math.max(0, targetPx - domY);
        row.blocks.forEach((b) => {
          const el = flow.querySelector(`[data-block-id="${b.blockId}"]`);
          if (el) el.style.marginTop = `${gap}px`;
        });
        domY = targetPx;
      }
      domY += row.heightMm * scale + DEFAULT_ROW_GAP_MM * scale;
    });
  });

  drawPageGuides(pages.length);
  if (els.pageCount) {
    els.pageCount.textContent = `${pages.length} page${
      pages.length === 1 ? "" : "s"
    }`;
  }
}

function drawPageGuides(pageCount) {
  const host = els.guides;
  if (!host) return;
  host.innerHTML = "";
  const scale = pxPerMm();
  for (let i = 0; i < pageCount; i += 1) {
    const page = document.createElement("div");
    page.className = "layout-page-guide";
    page.style.top = `${i * PAGE_H_MM * scale}px`;
    page.style.height = `${PAGE_H_MM * scale}px`;

    const label = document.createElement("span");
    label.className = "layout-page-label";
    label.textContent = `Page ${i + 1}`;
    page.appendChild(label);
    host.appendChild(page);
  }
  host.style.height = `${pageCount * PAGE_H_MM * scale}px`;
}

// How much the fit-to-screen wrapper is shrinking the sheet by.
function currentDisplayScale() {
  if (!els || !els.stage || !els.sheet) return 1;
  const available = els.stage.clientWidth - 32;
  const natural = PAGE_W_MM * pxPerMm();
  if (available <= 0 || natural <= 0) return 1;
  return Math.min(1, available / natural);
}

function applyDisplayScale() {
  if (!els || !els.sheet) return;
  const k = currentDisplayScale();
  els.sheet.style.transform = `scale(${k})`;
  els.sheet.style.transformOrigin = "top left";
  // The transform does not affect layout, so the wrapper has to be told what
  // the scaled sheet actually occupies or the page would not scroll correctly.
  if (els.sheetWrap) {
    els.sheetWrap.style.width = `${PAGE_W_MM * pxPerMm() * k}px`;
    els.sheetWrap.style.height = `${els.sheet.offsetHeight * k}px`;
  }
}

// ---- Library sidebar ----

function libraryItem(label, sub, template) {
  const el = document.createElement("div");
  el.className = "lib-item";
  el.dataset.blockTemplate = JSON.stringify(template);
  el.title = "Drag onto the sheet";

  const name = document.createElement("span");
  name.className = "lib-item-name";
  name.textContent = label;
  el.appendChild(name);

  if (sub) {
    const s = document.createElement("span");
    s.className = "lib-item-sub";
    s.textContent = sub;
    el.appendChild(s);
  }

  // Click adds to the end, for touch and for anyone who would rather not drag.
  el.addEventListener("click", () => {
    addBlockFromTemplate(template, doc.blocks.length);
  });
  return el;
}

function renderLibrary() {
  const host = els.sidebar;
  host.innerHTML = "";
  librarySortables.forEach((s) => s.destroy());
  librarySortables = [];

  const groups = [];

  const GROUP_TITLES = { piano: "Piano", guitar: "Guitar", drums: "Drums" };

  ["piano", "guitar", "drums"].forEach((instrument) => {
    const board = boards[instrument];
    const sections = (board && board.sections) || [];
    // Emptiness is decided at the END, on the items actually built: the drums
    // board never has sections, and testing for those here would hide its beats
    // entirely.
    const items = [];
    sections.forEach((section) => {
      if (!section || !section.id) return;
      const count = (section.chords || []).length;
      items.push(
        libraryItem(
          section.name || "Section",
          `${count} chord${count === 1 ? "" : "s"}`,
          { type: "section", ref: { instrument, sectionId: section.id } }
        )
      );
      (section.chords || []).forEach((chord) => {
        if (!chord || !chord.id) return;
        items.push(
          libraryItem(chord.sym || "?", section.name || "", {
            type: "chord",
            ref: { instrument, sectionId: section.id, chordId: chord.id },
          })
        );
      });
    });

    // Melodies sit alongside that board's sections because they are the same
    // kind of thing: content authored on the instrument's own tab, placed here
    // by reference. Written on piano→melody, guitar→melody or drums→beat.
    ((board && board.melodies) || []).forEach((melody) => {
      if (!melody || !melody.id) return;
      const n = (melody.events || []).length;
      const kind = melody.clef === "drums" ? "Beat" : "Melody";
      items.push(
        libraryItem(melody.name || kind, `${n} event${n === 1 ? "" : "s"}`, {
          type: "melody",
          ref: { instrument, melodyId: melody.id },
        })
      );
    });

    if (!items.length) return;
    groups.push({ title: GROUP_TITLES[instrument] || instrument, items });
  });

  groups.push({
    title: "Add",
    items: [
      libraryItem("Text note", "A comment or instruction", {
        type: "text",
        text: "",
        style: "body",
      }),
      libraryItem("Heading", "A larger line of text", {
        type: "text",
        text: "",
        style: "heading",
      }),
      libraryItem("Fretboard", "A scale shape or the whole neck", {
        type: "fretboard",
        scale: currentGuitarTabScale(),
      }),
      libraryItem("Page break", "Start a new page here", { type: "pagebreak" }),
    ],
  });

  if (!groups.some((g) => g.items.length)) {
    const empty = document.createElement("p");
    empty.className = "layout-lib-empty";
    empty.textContent =
      "Nothing to place yet. Add chords on the Piano or Guitar tab first.";
    host.appendChild(empty);
    return;
  }

  groups.forEach((group) => {
    if (!group.items.length) return;
    const title = document.createElement("h3");
    title.className = "layout-lib-title";
    title.textContent = group.title;
    host.appendChild(title);

    const list = document.createElement("div");
    list.className = "layout-lib-list";
    group.items.forEach((i) => list.appendChild(i));
    host.appendChild(list);

    if (window.Sortable) {
      librarySortables.push(
        window.Sortable.create(list, {
          // Clone out, never accept: the library is a palette, not a bin.
          group: { name: "layout", pull: "clone", put: false },
          sort: false,
          animation: 150,
          draggable: ".lib-item",
        })
      );
    }
  });
}

// ---- Drag wiring ----

// A two-hands keyboard is a three-octave keybed — around 756px of white keys.
// In a three-column block that is unreadable, so piano content starts full
// width whenever two-hands mode is on. It can still be resized down; the
// keybed is fluid inside a block, so it stays legible rather than clipped.
function spanForTemplate(template) {
  const isPianoBoardBlock =
    (template.type === "chord" || template.type === "section") &&
    template.ref &&
    template.ref.instrument === "piano";
  if (isPianoBoardBlock && deps.isTwoHandsMode()) return LAYOUT_COLUMNS;
  return defaultSpan(template.type);
}

function addBlockFromTemplate(template, index) {
  const block = createBlock(template.type, {
    ...template,
    span: spanForTemplate(template),
  });
  const at = Math.max(0, Math.min(doc.blocks.length, index));
  doc.blocks.splice(at, 0, block);
  saveLayout();
  render();
}

function wireFlowSortable() {
  if (!window.Sortable || !els.flow) return;
  if (flowSortable) flowSortable.destroy();

  flowSortable = window.Sortable.create(els.flow, {
    group: { name: "layout", pull: true, put: true },
    animation: 150,
    draggable: ".layout-block",
    handle: ".lb-handle",
    // `.no-drag` is the codebase's existing convention for "a control, not a
    // drag target" — the chord cards' play button already relies on it.
    filter: ".no-drag, .lb-resize, [contenteditable='true']",
    preventOnFilter: false,

    onAdd: (evt) => {
      // The node Sortable cloned in has no block id and no handlers. Take its
      // template, drop the node, and re-render from the model instead.
      let template = null;
      try {
        template = JSON.parse(evt.item.dataset.blockTemplate || "null");
      } catch (_) {}
      const index = Array.from(els.flow.children).indexOf(evt.item);
      evt.item.remove();
      if (template) addBlockFromTemplate(template, index);
      else render();
    },

    onUpdate: (evt) => {
      const order = Array.from(
        els.flow.querySelectorAll(".layout-block")
      ).map((el) => el.dataset.blockId);
      doc.blocks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      saveLayout();
      render();
    },
  });
}

// ---- Export ----

function twoFrames() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
}

// Rasterize each block once. The slider then only re-runs the mm arithmetic,
// never html2canvas — the same discipline the auto-flow export keeps.
async function prepareLayoutExport() {
  const flow = els.flow;
  if (!flow || !doc.blocks.length) return { blocks: [], isEmpty: true };

  const clone = flow.cloneNode(true);
  clone.classList.add("pdf-capture", "layout-export-clone");
  // Editor chrome never prints, and the page-gap margins belong to the editor's
  // WYSIWYG spacing rather than to the block's own height.
  clone
    .querySelectorAll(".lb-chrome, .lb-resize, .lb-controls")
    .forEach((el) => el.remove());
  clone.querySelectorAll(".layout-block").forEach((el) => {
    el.style.marginTop = "";
  });

  const holder = document.createElement("div");
  holder.style.position = "fixed";
  holder.style.top = "-9999px";
  holder.style.left = "-9999px";
  holder.style.opacity = "0";
  holder.style.width = `${PAGE_W_MM * pxPerMm()}px`;
  holder.appendChild(clone);
  document.body.appendChild(holder);

  try {
    // Fonts must be resolved before rasterizing, or html2canvas captures a
    // fallback face and the PDF disagrees with the preview.
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await twoFrames();

    // Re-fit against the clone's own widths so an export is correct even if the
    // sheet has not been repaginated since the last change.
    fitKeyboards(clone);
    await twoFrames();

    const scale = pxPerMm();
    const out = [];

    for (const block of doc.blocks) {
      const el = clone.querySelector(`[data-block-id="${block.id}"]`);
      if (!el) continue;

      const box = {
        blockId: block.id,
        span: clampSpan(block.span),
        heightMm: el.offsetHeight / scale,
        pageBreakBefore: !!block.pageBreakBefore,
        isPageBreak: block.type === "pagebreak",
      };

      if (block.type === "pagebreak") {
        out.push({ box, capture: null });
        continue;
      }

      if (block.type === "text") {
        // Text stays real text in the PDF: crisp at any zoom and selectable,
        // which a rasterized paragraph would not be.
        out.push({
          box,
          text: {
            content: block.text || "",
            sizePt: block.style === "heading" ? 16 : 11,
            bold: block.style === "heading",
          },
          capture: null,
        });
        continue;
      }

      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        backgroundColor: null,
      });
      out.push({
        box,
        capture: { canvas, dataUrl: canvas.toDataURL("image/png") },
      });
    }

    return { blocks: out, isEmpty: out.every((b) => !b.capture && !b.text) };
  } finally {
    document.body.removeChild(holder);
  }
}

const PT_TO_MM = 25.4 / 72;

// Convert paginated rects into the placement vocabulary the shared PDF modal
// already speaks, so renderPdfPreview and savePdfFromLayout consume them
// unchanged.
function layoutExportPages(ctx, scale) {
  const byId = new Map(ctx.blocks.map((b) => [b.box.blockId, b]));
  const boxes = ctx.blocks.map((b) => b.box);
  const pages = paginateRows(packRows(boxes, { scale }), { scale });

  return pages
    .map((rows) => {
      const placements = [];
      rows.forEach((row) => {
        row.blocks.forEach((rect) => {
          const entry = byId.get(rect.blockId);
          if (!entry) return;

          if (entry.text) {
            if (!entry.text.content.trim()) return;
            placements.push({
              type: "text",
              text: entry.text.content,
              sizePt: entry.text.sizePt * scale,
              bold: entry.text.bold,
              x: rect.xMm,
              baselineY: rect.yMm + entry.text.sizePt * scale * PT_TO_MM,
            });
            return;
          }

          if (!entry.capture) return;
          placements.push({
            type: "image",
            capture: entry.capture,
            // A composed block is always placed whole — banding is the
            // auto-flow export's job, not this one's.
            sourceY: 0,
            sourceHeight: entry.capture.canvas.height,
            x: rect.xMm,
            y: rect.yMm,
            width: rect.wMm,
            height: rect.hMm,
          });
        });
      });
      return placements;
    })
    .filter((p) => p.length > 0);
}

function exportSheet() {
  deps.openPdfPreviewModal({
    scaleKey: LAYOUT_SCALE_KEY,
    fileName: "sheet.pdf",
    prepare: prepareLayoutExport,
    layout: layoutExportPages,
  });
}

// ---- Entry points ----

function render() {
  renderFlow();
  wireFlowSortable();
  applyDisplayScale();
  // Heights are only real once the browser has laid the blocks out — and the
  // piano's black keys are positioned a frame late, so wait for two.
  twoFrames().then(() => {
    repaginate();
    applyDisplayScale();
  });
}

export function refreshLayout() {
  if (!els) return;
  readBoards();
  renderLibrary();
  render();
}

export function initLayout(injected) {
  deps = { ...deps, ...injected };

  els = {
    panel: document.getElementById("layoutPanel"),
    sidebar: document.getElementById("layoutSidebar"),
    stage: document.getElementById("layoutStage"),
    sheetWrap: document.getElementById("layoutSheetWrap"),
    sheet: document.getElementById("layoutSheet"),
    flow: document.getElementById("layoutFlow"),
    guides: document.getElementById("layoutGuides"),
    pageCount: document.getElementById("layoutPageCount"),
    exportBtn: document.getElementById("layoutExport"),
    clearBtn: document.getElementById("layoutClear"),
  };

  if (!els.panel || !els.flow) {
    els = null;
    return;
  }

  loadLayout();

  if (els.exportBtn) els.exportBtn.addEventListener("click", exportSheet);
  if (els.clearBtn) {
    els.clearBtn.addEventListener("click", () => {
      if (!doc.blocks.length) return;
      if (!confirm("Remove every block from this sheet?")) return;
      doc.blocks = [];
      saveLayout();
      render();
    });
  }

  window.addEventListener("resize", () => {
    applyDisplayScale();
  });
}
