/**
 * Ruled tables in digital PDFs. Quotations exported from Excel, Tally or Word usually draw
 * their tables as boxes: a "To / Ref" box, a ruled item table, a "Total Amount" box. The
 * drawn lines say exactly where every cell is, which is far more reliable than guessing
 * columns from text gaps, so they are read from the PDF's drawing operators here.
 *
 * Units are page units with y growing downwards (same as `Word`).
 */

/** A horizontal (y0 === y1) or vertical (x0 === x1) line segment. */
export interface Rule {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Cell {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Grid {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cells: Cell[];
}

// pdf.js operator numbers (stable since pdf.js 2.x).
const OP = {
  setLineWidth: 2,
  save: 10,
  restore: 11,
  transform: 12,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  setStrokeGray: 56,
  setFillGray: 57,
  setStrokeRGBColor: 58,
  setFillRGBColor: 59,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  constructPath: 91,
} as const;

// pdf.js path drawing ops inside constructPath data.
const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const;

const STROKES = new Set<number>([OP.stroke, OP.closeStroke, OP.fillStroke, OP.eoFillStroke, OP.closeFillStroke, OP.closeEOFillStroke]);
const FILLS = new Set<number>([OP.fill, OP.eoFill, OP.fillStroke, OP.eoFillStroke, OP.closeFillStroke, OP.closeEOFillStroke]);

type M = [number, number, number, number, number, number];
const IDENTITY: M = [1, 0, 0, 1, 0, 0];
const mul = (a: M, b: number[]): M => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** True for white or nearly white paint (cover-ups and page backgrounds are not lines). */
function isWhite(args: unknown): boolean {
  const a = args as unknown[] | null;
  if (!a) return false;
  const v = a[0];
  if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) {
    const n = parseInt(v.slice(1), 16);
    return (n >> 16) > 235 && ((n >> 8) & 255) > 235 && (n & 255) > 235;
  }
  const nums = a.filter((x): x is number => typeof x === 'number');
  if (!nums.length) return false;
  const max = Math.max(...nums) > 1 ? 255 : 1;
  return nums.every((x) => x / max > 0.92);
}

interface OperatorListLike {
  fnArray: number[];
  argsArray: unknown[];
}

/**
 * Horizontal and vertical lines drawn on the page: stroked paths and thin filled
 * rectangles (Excel draws its borders as hairline rectangles).
 * @param viewport pdf.js viewport transform (scale 1) that flips y downwards.
 */
export function rulesFromOperatorList(ops: OperatorListLike, viewport: number[]): Rule[] {
  const rules: Rule[] = [];
  const stack: { ctm: M; strokeWhite: boolean; fillWhite: boolean }[] = [];
  let ctm: M = mul(viewport as M, IDENTITY);
  let strokeWhite = false;
  let fillWhite = false;

  const addSegment = (ax: number, ay: number, bx: number, by: number) => {
    const [x0, y0] = apply(ctm, ax, ay);
    const [x1, y1] = apply(ctm, bx, by);
    if (Math.abs(y0 - y1) < 0.6 && Math.abs(x1 - x0) >= 3) rules.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: (y0 + y1) / 2, y1: (y0 + y1) / 2 });
    else if (Math.abs(x0 - x1) < 0.6 && Math.abs(y1 - y0) >= 3) rules.push({ y0: Math.min(y0, y1), y1: Math.max(y0, y1), x0: (x0 + x1) / 2, x1: (x0 + x1) / 2 });
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[] | null;
    switch (fn) {
      case OP.save:
        stack.push({ ctm, strokeWhite, fillWhite });
        break;
      case OP.restore: {
        const s = stack.pop();
        if (s) ({ ctm, strokeWhite, fillWhite } = s);
        break;
      }
      case OP.transform:
        if (args && args.length >= 6) ctm = mul(ctm, args as number[]);
        break;
      case OP.paintFormXObjectBegin:
        stack.push({ ctm, strokeWhite, fillWhite });
        if (Array.isArray(args?.[0]) && (args[0] as number[]).length >= 6) ctm = mul(ctm, args[0] as number[]);
        break;
      case OP.paintFormXObjectEnd: {
        const s = stack.pop();
        if (s) ({ ctm, strokeWhite, fillWhite } = s);
        break;
      }
      case OP.setStrokeRGBColor:
      case OP.setStrokeGray:
        strokeWhite = isWhite(args);
        break;
      case OP.setFillRGBColor:
      case OP.setFillGray:
        fillWhite = isWhite(args);
        break;
      case OP.constructPath: {
        if (!args) break;
        const paint = args[0] as number;
        const raw = (args[1] as ArrayLike<number>[] | undefined)?.[0];
        if (!raw) break;
        const stroked = STROKES.has(paint) && !strokeWhite;
        const filled = FILLS.has(paint) && !fillWhite;
        if (!stroked && !filled) break;

        // Split the path into sub-paths of straight points.
        const subpaths: number[][] = [];
        let cur: number[] = [];
        for (let k = 0; k < raw.length; ) {
          const op = raw[k++];
          if (op === DRAW.moveTo) {
            if (cur.length) subpaths.push(cur);
            cur = [raw[k++], raw[k++]];
          } else if (op === DRAW.lineTo) {
            cur.push(raw[k++], raw[k++]);
          } else if (op === DRAW.curveTo) {
            if (cur.length) subpaths.push(cur);
            cur = [raw[k + 4], raw[k + 5]];
            k += 6;
          } else if (op === DRAW.quadraticCurveTo) {
            if (cur.length) subpaths.push(cur);
            cur = [raw[k + 2], raw[k + 3]];
            k += 4;
          } else if (op === DRAW.closePath) {
            if (cur.length >= 4) cur.push(cur[0], cur[1]);
          } else {
            break;
          }
        }
        if (cur.length) subpaths.push(cur);

        for (const pts of subpaths) {
          if (stroked) {
            for (let k = 0; k + 3 < pts.length; k += 2) addSegment(pts[k], pts[k + 1], pts[k + 2], pts[k + 3]);
          } else if (filled && pts.length >= 8) {
            // A filled thin rectangle is a line; a big filled area is shading, not a rule.
            const xs: number[] = [];
            const ys: number[] = [];
            for (let k = 0; k + 1 < pts.length; k += 2) {
              const [x, y] = apply(ctm, pts[k], pts[k + 1]);
              xs.push(x);
              ys.push(y);
            }
            const x0 = Math.min(...xs);
            const x1 = Math.max(...xs);
            const y0 = Math.min(...ys);
            const y1 = Math.max(...ys);
            if (y1 - y0 <= 2.5 && x1 - x0 >= 3) rules.push({ x0, x1, y0: (y0 + y1) / 2, y1: (y0 + y1) / 2 });
            else if (x1 - x0 <= 2.5 && y1 - y0 >= 3) rules.push({ y0, y1, x0: (x0 + x1) / 2, x1: (x0 + x1) / 2 });
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return rules;
}

// ---------------------------------------------------------------------------------------
// Lines -> cells -> grids
// ---------------------------------------------------------------------------------------

const TOL = 2;

interface Edge {
  /** Fixed coordinate (y for horizontal, x for vertical). */
  at: number;
  lo: number;
  hi: number;
}

/** Snaps nearly-equal positions together and joins touching or overlapping pieces. */
function mergeEdges(edges: Edge[]): Edge[] {
  const sorted = [...edges].sort((a, b) => a.at - b.at || a.lo - b.lo);
  // Snap the fixed coordinate.
  const groups: Edge[][] = [];
  for (const e of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(e.at - g[0].at) <= TOL) g.push(e);
    else groups.push([e]);
  }
  const out: Edge[] = [];
  for (const g of groups) {
    const at = g.reduce((s, e) => s + e.at, 0) / g.length;
    const spans = g.map((e) => [e.lo, e.hi]).sort((a, b) => a[0] - b[0]);
    let [lo, hi] = spans[0];
    for (const [a, b] of spans.slice(1)) {
      if (a <= hi + TOL) hi = Math.max(hi, b);
      else {
        out.push({ at, lo, hi });
        [lo, hi] = [a, b];
      }
    }
    out.push({ at, lo, hi });
  }
  return out;
}

/**
 * Finds the smallest closed boxes formed by the lines (the same idea as pdfplumber's
 * lattice mode), then groups boxes that touch into grids.
 */
export function findGrids(rules: Rule[]): Grid[] {
  const hs = mergeEdges(rules.filter((r) => r.y0 === r.y1).map((r) => ({ at: r.y0, lo: r.x0, hi: r.x1 })));
  const vs = mergeEdges(rules.filter((r) => r.x0 === r.x1 && r.y0 !== r.y1).map((r) => ({ at: r.x0, lo: r.y0, hi: r.y1 })));
  if (hs.length < 2 || vs.length < 2) return [];

  // Intersections, keyed by position, remembering which edges pass through them.
  interface Pt {
    x: number;
    y: number;
    h: Set<number>;
    v: Set<number>;
  }
  const pts: Pt[] = [];
  hs.forEach((h, hi) => {
    vs.forEach((v, vi) => {
      if (v.at >= h.lo - TOL && v.at <= h.hi + TOL && h.at >= v.lo - TOL && h.at <= v.hi + TOL) {
        pts.push({ x: v.at, y: h.at, h: new Set([hi]), v: new Set([vi]) });
      }
    });
  });
  if (pts.length > 4000) return []; // A hatched drawing, not a table.

  const shares = (a: Set<number>, b: Set<number>) => {
    for (const x of a) if (b.has(x)) return true;
    return false;
  };
  const byRow = new Map<number, Pt[]>();
  const byCol = new Map<number, Pt[]>();
  for (const p of pts) {
    const hKey = [...p.h][0];
    const vKey = [...p.v][0];
    if (!byRow.has(hKey)) byRow.set(hKey, []);
    if (!byCol.has(vKey)) byCol.set(vKey, []);
    byRow.get(hKey)!.push(p);
    byCol.get(vKey)!.push(p);
  }
  for (const list of byRow.values()) list.sort((a, b) => a.x - b.x);
  for (const list of byCol.values()) list.sort((a, b) => a.y - b.y);
  const at = (hIndex: number, vIndex: number) => byRow.get(hIndex)?.find((p) => p.v.has(vIndex));

  const cells: Cell[] = [];
  for (const p of pts) {
    const hIndex = [...p.h][0];
    const vIndex = [...p.v][0];
    const right = (byRow.get(hIndex) ?? []).filter((q) => q.x > p.x + TOL);
    const below = (byCol.get(vIndex) ?? []).filter((q) => q.y > p.y + TOL);
    let found: Cell | null = null;
    for (const b of below) {
      // Both points lie on the same vertical edge by construction; check the edge is continuous.
      const v = vs[vIndex];
      if (!(v.lo <= p.y + TOL && v.hi >= b.y - TOL)) break;
      for (const r of right) {
        const h = hs[hIndex];
        if (!(h.lo <= p.x + TOL && h.hi >= r.x - TOL)) break;
        const corner = at([...b.h][0], [...r.v][0]);
        if (!corner) continue;
        const vr = vs[[...r.v][0]];
        const hb = hs[[...b.h][0]];
        if (vr.lo <= r.y + TOL && vr.hi >= corner.y - TOL && hb.lo <= b.x + TOL && hb.hi >= corner.x - TOL && shares(corner.h, b.h) && shares(corner.v, r.v)) {
          found = { x0: p.x, y0: p.y, x1: r.x, y1: b.y };
          break;
        }
      }
      if (found) break;
    }
    if (found && found.x1 - found.x0 >= 6 && found.y1 - found.y0 >= 6) cells.push(found);
  }

  // A box that contains other boxes (a page border, a frame around a grid) is not a cell.
  const inner = cells.filter(
    (c) => !cells.some((d) => d !== c && d.x0 >= c.x0 - TOL && d.x1 <= c.x1 + TOL && d.y0 >= c.y0 - TOL && d.y1 <= c.y1 + TOL && (d.x1 - d.x0) * (d.y1 - d.y0) < (c.x1 - c.x0) * (c.y1 - c.y0) * 0.98),
  );

  // Boxes that share an edge belong to the same grid.
  const parent = inner.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touch = (a: Cell, b: Cell) => {
    const xOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const yOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    return (xOverlap > -TOL && yOverlap > -TOL) || (Math.abs(xOverlap) <= TOL && yOverlap > 0) || (Math.abs(yOverlap) <= TOL && xOverlap > 0);
  };
  for (let i = 0; i < inner.length; i++) for (let j = i + 1; j < inner.length; j++) if (touch(inner[i], inner[j])) parent[find(i)] = find(j);
  const groups = new Map<number, Cell[]>();
  inner.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(c);
  });
  return [...groups.values()]
    .map((cs) => ({
      x0: Math.min(...cs.map((c) => c.x0)),
      y0: Math.min(...cs.map((c) => c.y0)),
      x1: Math.max(...cs.map((c) => c.x1)),
      y1: Math.max(...cs.map((c) => c.y1)),
      cells: cs.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0),
    }))
    .sort((a, b) => a.y0 - b.y0);
}
