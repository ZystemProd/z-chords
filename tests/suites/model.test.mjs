// layout-model.js is pure arithmetic, so it is tested directly — no browser.
//
// These assert the geometry invariants the grid depends on: columns fill the
// content box exactly, blocks never overlap, and an over-tall row shrinks to
// fit rather than being sliced in half.
import {
  packRows,
  paginateRows,
  clampSpan,
  normalizeLayout,
  CONTENT_W_MM,
  PAGE_H_MM,
  PAGE_MARGIN_MM,
} from "../../layout-model.js";

export const name = "Layout model";
export const needsBrowser = false;

const box = (blockId, span, heightMm, extra = {}) => ({ blockId, span, heightMm, ...extra });

export default async function run({ t }) {
  // --- packing ---
  let rows = packRows([box("a", 12, 50), box("b", 6, 30), box("c", 6, 40), box("d", 3, 20)]);
  t.ok("a span-12 block takes a row alone", rows[0].blocks.length === 1);
  t.ok("two span-6 blocks share a row", rows[1].blocks.length === 2);
  t.ok("row height is its tallest block", rows[1].heightMm === 40, `${rows[1].heightMm}`);
  t.ok("overflow starts a new row", rows[2].blocks[0].blockId === "d");

  // --- geometry ---
  const full = packRows([box("x", 12, 10)])[0].blocks[0];
  t.near("span 12 fills the content width", full.widthMm, CONTENT_W_MM, 1e-9, "mm");

  const four = packRows([1, 2, 3, 4].map((i) => box(`p${i}`, 3, 10)))[0].blocks;
  t.near(
    "four span-3 blocks reach the right margin",
    four[3].xMm + four[3].widthMm,
    PAGE_MARGIN_MM + CONTENT_W_MM,
    1e-9,
    "mm"
  );
  t.ok(
    "columns never overlap",
    four.every((b, i) => i === 0 || b.xMm >= four[i - 1].xMm + four[i - 1].widthMm - 1e-9)
  );

  rows = packRows([box("a", 6, 10), box("b", 6, 10, { pageBreakBefore: true })]);
  t.ok("pageBreakBefore closes the row", rows.length === 2 && rows[1].pageBreakBefore === true);

  // --- pagination ---
  t.ok("two tall rows split across pages", paginateRows(packRows([box("a", 12, 200), box("b", 12, 200)])).length === 2);
  t.ok("two short rows share a page", paginateRows(packRows([box("a", 12, 100), box("b", 12, 100)])).length === 1);

  const pages = paginateRows(packRows([box("a", 12, 200), box("b", 12, 200)]));
  t.ok("a new page starts at the top margin", pages[1][0].yMm === PAGE_MARGIN_MM, `${pages[1][0].yMm}`);

  // An over-tall row shrinks rather than being sliced: half a fretboard or half
  // a staff is unusable, unlike half a list of chord cards.
  const tall = paginateRows(packRows([box("tall", 12, 400)]))[0][0].blocks[0];
  t.ok("an over-tall row shrinks", tall.shrink > 0 && tall.shrink < 1, `${tall.shrink}`);
  t.ok("the shrunk row fits the page", tall.hMm <= PAGE_H_MM - 2 * PAGE_MARGIN_MM + 1e-9, `${tall.hMm}mm`);
  t.near("the shrunk row is centred", tall.xMm - PAGE_MARGIN_MM, (CONTENT_W_MM - tall.wMm) / 2, 1e-6, "mm");

  const broken = paginateRows(
    packRows([box("a", 12, 20), { blockId: "pb", span: 12, heightMm: 0, isPageBreak: true }, box("c", 12, 20)])
  );
  t.ok("an explicit page break forces a page", broken.length === 2, `${broken.length}`);

  // The export slider must change what fits, not just the final size.
  const at100 = paginateRows(packRows([box("a", 12, 150), box("b", 12, 150)], { scale: 1 }), { scale: 1 });
  const at50 = paginateRows(packRows([box("a", 12, 150), box("b", 12, 150)], { scale: 0.5 }), { scale: 0.5 });
  t.ok("scaling down fits more per page", at100.length === 2 && at50.length === 1, `${at100.length} vs ${at50.length}`);

  // --- normalize is total: a corrupt sheet degrades, never throws ---
  t.ok("null normalizes to an empty sheet", normalizeLayout(null).blocks.length === 0);
  t.ok("junk blocks are dropped", normalizeLayout({ blocks: [{ type: "text" }, null, 42, { nope: 1 }] }).blocks.length === 1);
  t.ok("span is clamped on load", normalizeLayout({ blocks: [{ type: "text", span: 99 }] }).blocks[0].span === 12);
  t.ok("clampSpan has a floor of 1", clampSpan(-5) === 1 && clampSpan(0) === 1);
}
