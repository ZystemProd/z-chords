// Layout sheet: the document shape and the page arithmetic.
//
// Pure data and mm maths — no DOM, no imports, no app state. `layout.js` owns
// the DOM and hands measured heights in here; this module decides what lands on
// which page. Keeping the split means the scale and the page guides can be
// recomputed on every drag without touching the renderer.
//
// The counterpart of `layoutPdfPages` in script.js, for composed sheets rather
// than auto-flowed ones. The two differ in one deliberate way: that one *slices*
// an over-tall section into bands, because it is flowing a vertical list of
// cards where a clean break exists. A composed sheet shrinks instead — a
// fretboard or a grand staff cut in half is unusable.

export const LAYOUT_FORMAT = "z-chords-layout";
export const LAYOUT_VERSION = 1;
export const LAYOUT_COLUMNS = 12;

// A4 portrait, in mm — the same page the auto-flow export targets.
export const PAGE_W_MM = 210;
export const PAGE_H_MM = 297;
export const PAGE_MARGIN_MM = 10;
export const CONTENT_W_MM = PAGE_W_MM - PAGE_MARGIN_MM * 2; // 190
export const CONTENT_H_MM = PAGE_H_MM - PAGE_MARGIN_MM * 2; // 277

export const DEFAULT_GUTTER_MM = 4;
export const DEFAULT_ROW_GAP_MM = 4;

// Block types that exist today. `fretboard` and `melody` arrive in later
// phases; the model already tolerates them so a file written by a newer build
// does not lose blocks when an older one opens it.
export const BLOCK_TYPES = ["section", "chord", "text", "fretboard", "melody", "pagebreak"];

// Wide content — a two-hands keyboard, a fretboard — is unreadable in a narrow
// column, so those types start full width. Chord cards are small and square, so
// four to a row is the natural default.
const DEFAULT_SPANS = {
  section: 12,
  chord: 3,
  text: 12,
  fretboard: 12,
  melody: 12,
  pagebreak: 12,
};

export function defaultSpan(type) {
  return DEFAULT_SPANS[type] || 6;
}

export function clampSpan(span) {
  const n = Math.round(Number(span));
  if (!Number.isFinite(n)) return 6;
  return Math.min(LAYOUT_COLUMNS, Math.max(1, n));
}

function mintBlockId() {
  let rand = "";
  try {
    rand = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  } catch (_) {
    rand = Math.random().toString(36).slice(2, 12);
  }
  return `b_${rand}`;
}

export function createLayout() {
  return {
    format: LAYOUT_FORMAT,
    version: LAYOUT_VERSION,
    columns: LAYOUT_COLUMNS,
    gutterMm: DEFAULT_GUTTER_MM,
    rowGapMm: DEFAULT_ROW_GAP_MM,
    blocks: [],
  };
}

export function createBlock(type, props = {}) {
  return {
    id: mintBlockId(),
    type,
    span: clampSpan(props.span == null ? defaultSpan(type) : props.span),
    ...props,
    // id and type are ours to set, whatever props said.
    ...(props.id ? { id: props.id } : {}),
  };
}

// Never throws: a corrupt or half-written layout should degrade to an empty
// sheet rather than take the tab down with it.
export function normalizeLayout(raw) {
  const base = createLayout();
  if (!raw || typeof raw !== "object") return base;

  const blocks = Array.isArray(raw.blocks) ? raw.blocks : [];
  base.blocks = blocks
    .filter((b) => b && typeof b === "object" && typeof b.type === "string")
    .map((b) => ({
      ...b,
      id: b.id || mintBlockId(),
      span: clampSpan(b.span == null ? defaultSpan(b.type) : b.span),
      pageBreakBefore: !!b.pageBreakBefore,
    }));

  if (Number.isFinite(Number(raw.gutterMm))) base.gutterMm = Number(raw.gutterMm);
  if (Number.isFinite(Number(raw.rowGapMm))) base.rowGapMm = Number(raw.rowGapMm);
  return base;
}

// One column's width in mm, given the gutter between columns.
export function columnWidthMm(gutterMm = DEFAULT_GUTTER_MM, columns = LAYOUT_COLUMNS) {
  return (CONTENT_W_MM - (columns - 1) * gutterMm) / columns;
}

export function spanWidthMm(span, gutterMm = DEFAULT_GUTTER_MM, columns = LAYOUT_COLUMNS) {
  const col = columnWidthMm(gutterMm, columns);
  return span * col + (span - 1) * gutterMm;
}

// ---- Row packing ----
//
// Greedy left-to-right: accumulate spans until the next block would overflow
// twelve columns, then close the row. This is what "reflowing grid" means —
// reordering blocks repacks everything after them, and no block ever overlaps.
//
// boxes: [{ blockId, span, heightMm, pageBreakBefore, isPageBreak }]
export function packRows(boxes, opts = {}) {
  const columns = opts.columns || LAYOUT_COLUMNS;
  const gutterMm = opts.gutterMm == null ? DEFAULT_GUTTER_MM : opts.gutterMm;
  // `scale` is the export slider: the fraction of the content width the sheet is
  // drawn at, centred. It is applied here rather than to the finished rects
  // because it has to change what *fits* on a page, not just the final size.
  const scale = Number(opts.scale) > 0 ? Number(opts.scale) : 1;
  const colWMm = columnWidthMm(gutterMm, columns) * scale;
  const gutterScaled = gutterMm * scale;
  const offsetXMm = (CONTENT_W_MM * (1 - scale)) / 2;

  const rows = [];
  let cur = null;

  const flush = () => {
    if (!cur || !cur.blocks.length) return;
    cur.heightMm = cur.blocks.reduce((h, b) => Math.max(h, b.heightMm), 0);
    rows.push(cur);
    cur = null;
  };

  (boxes || []).forEach((box) => {
    // An explicit page-break block is not drawn; it only ends the page.
    if (box.isPageBreak) {
      flush();
      rows.push({ explicitBreak: true, blocks: [], heightMm: 0 });
      return;
    }

    const span = clampSpan(box.span);
    if (box.pageBreakBefore) flush();
    if (cur && cur.used + span > columns) flush();
    if (!cur) {
      cur = { blocks: [], used: 0, pageBreakBefore: !!box.pageBreakBefore, heightMm: 0 };
    }

    cur.blocks.push({
      blockId: box.blockId,
      span,
      colStart: cur.used,
      heightMm: (Number(box.heightMm) || 0) * scale,
      widthMm: span * colWMm + (span - 1) * gutterScaled,
      xMm: PAGE_MARGIN_MM + offsetXMm + cur.used * (colWMm + gutterScaled),
    });
    cur.used += span;
  });

  flush();
  return rows;
}

// ---- Pagination ----
//
// Walk packed rows down the page. Returns pages of placed rows, each block
// carrying its final mm rect plus the shrink factor applied to it (1 unless the
// row was taller than a whole page).
export function paginateRows(rows, opts = {}) {
  const rowGapMm = opts.rowGapMm == null ? DEFAULT_ROW_GAP_MM : opts.rowGapMm;
  const top = PAGE_MARGIN_MM;
  const bottom = PAGE_H_MM - PAGE_MARGIN_MM;
  const fullHeight = bottom - top;
  const headingsHeightMm = Number(opts.headingsHeightMm) || 0;

  const pages = [[]];
  // Headings occupy the top of page one but do not themselves count as content,
  // so a first block that forces a break still starts here.
  let cursorY = top + headingsHeightMm;
  let hasContent = false;

  const newPage = () => {
    pages.push([]);
    cursorY = top;
  };

  (rows || []).forEach((row) => {
    if (row.explicitBreak) {
      if (hasContent) {
        newPage();
        hasContent = false;
      }
      return;
    }
    if (!row.blocks.length) return;

    if (row.pageBreakBefore && hasContent) {
      newPage();
      hasContent = false;
    }

    let shrink = 1;
    const available = bottom - cursorY;

    if (row.heightMm > available) {
      if (row.heightMm <= fullHeight) {
        // Fits on a page, just not on what is left of this one.
        newPage();
      } else {
        // Taller than any page. Shrink to fit rather than slice it in half.
        if (hasContent) newPage();
        shrink = fullHeight / row.heightMm;
      }
    }

    const placedHeight = row.heightMm * shrink;
    // A shrunk row is narrower too, so centre it instead of leaving it hugging
    // the left margin looking like a mistake.
    const rowWidth = row.blocks.reduce(
      (w, b) => Math.max(w, b.xMm - PAGE_MARGIN_MM + b.widthMm),
      0
    );
    const offsetX =
      shrink < 1 ? (CONTENT_W_MM - rowWidth * shrink) / 2 : 0;

    pages[pages.length - 1].push({
      heightMm: placedHeight,
      yMm: cursorY,
      shrink,
      blocks: row.blocks.map((b) => ({
        blockId: b.blockId,
        span: b.span,
        shrink,
        xMm: PAGE_MARGIN_MM + offsetX + (b.xMm - PAGE_MARGIN_MM) * shrink,
        yMm: cursorY,
        wMm: b.widthMm * shrink,
        hMm: b.heightMm * shrink,
      })),
    });

    cursorY += placedHeight + rowGapMm;
    hasContent = true;
  });

  return pages.filter((page, i) => page.length > 0 || i === 0);
}

// Convenience: measure -> pack -> paginate in one call.
export function paginate(boxes, opts = {}) {
  return paginateRows(packRows(boxes, opts), opts);
}
