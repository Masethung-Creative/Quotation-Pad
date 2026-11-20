import { looksNumeric } from '@/lib/format';
import type { Align, LabelValue, Run, TotalsItem } from '@/schema/canonical';
import { classifyTotalsLabel } from '@/validate/totals';
import { removeHeaderFooter } from './headerFooter';
import { findGrids, type Cell, type Grid } from './rules';
import { inferColAlign } from './tableUtil';
import { LOW_CONFIDENCE, type PageWords, type Word, type XBlock } from './types';

/**
 * Rebuilds document structure (lines, paragraphs, tables, lists, totals) from positioned
 * words. Shared by the digital-PDF path (pdf.js text items) and the OCR path (Tesseract
 * words), so both produce the same canonical blocks.
 */

export interface Seg {
  x0: number;
  x1: number;
  words: Word[];
  text: string;
}

export interface Line {
  page: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Approximate font size (em) in page units. */
  size: number;
  segs: Seg[];
  text: string;
  ocr: boolean;
}

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

function separator(prev: Word, next: Word, size: number, ocr: boolean): string {
  if (ocr) return ' ';
  if (/\s$/.test(prev.text) || /^\s/.test(next.text)) return '';
  return next.x0 - prev.x1 > size * 0.12 ? ' ' : '';
}

function joinWords(words: Word[], size: number, ocr: boolean): string {
  let out = '';
  words.forEach((w, i) => {
    if (i > 0) out += separator(words[i - 1], w, size, ocr);
    out += w.text;
  });
  return clean(out);
}

/** Gap (in em) that separates two columns / segments on the same line. */
const SEGMENT_GAP_EM = 1.0;

export function buildLines(page: PageWords, pageIndex: number): Line[] {
  const words = page.words
    .filter((w) => w.text.trim() !== '')
    .sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));

  interface Acc {
    words: Word[];
    y0: number;
    y1: number;
  }
  const accs: Acc[] = [];
  for (const w of words) {
    const h = Math.max(w.y1 - w.y0, 1e-6);
    let best: Acc | null = null;
    let bestRatio = 0;
    for (let k = accs.length - 1; k >= 0 && k >= accs.length - 8; k--) {
      const a = accs[k];
      const overlap = Math.min(a.y1, w.y1) - Math.max(a.y0, w.y0);
      const ratio = overlap / Math.min(h, Math.max(a.y1 - a.y0, 1e-6));
      if (ratio > 0.5 && ratio > bestRatio) {
        best = a;
        bestRatio = ratio;
      }
    }
    if (best) {
      const bandH = best.y1 - best.y0;
      best.words.push(w);
      // Only full-height words refine the band; punctuation would squeeze it.
      if (h >= bandH * 0.6) {
        const n = best.words.length;
        best.y0 += (w.y0 - best.y0) / n;
        best.y1 += (w.y1 - best.y1) / n;
      }
    } else {
      accs.push({ words: [w], y0: w.y0, y1: w.y1 });
    }
  }

  const lines: Line[] = [];
  for (const acc of accs) {
    const ws = acc.words.sort((a, b) => a.x0 - b.x0);
    const size = Math.max(percentile(ws.map((w) => w.y1 - w.y0), 0.9), 1e-6);
    const segs: Seg[] = [];
    let cur: Word[] = [];
    const flush = () => {
      if (!cur.length) return;
      const text = joinWords(cur, size, page.ocr);
      if (text) segs.push({ x0: cur[0].x0, x1: Math.max(...cur.map((w) => w.x1)), words: cur, text });
      cur = [];
    };
    for (const w of ws) {
      if (cur.length && w.x0 - Math.max(...cur.map((c) => c.x1)) > size * SEGMENT_GAP_EM) flush();
      cur.push(w);
    }
    flush();
    if (!segs.length) continue;
    lines.push({
      page: pageIndex,
      x0: segs[0].x0,
      x1: Math.max(...segs.map((s) => s.x1)),
      y0: Math.min(...ws.map((w) => w.y0)),
      y1: Math.max(...ws.map((w) => w.y1)),
      size,
      segs,
      text: segs.map((s) => s.text).join(' '),
      ocr: page.ocr,
    });
  }
  return lines.sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
}

// ---------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------

interface Col {
  x0: number;
  x1: number;
  lo: number;
  hi: number;
}

interface Region {
  start: number;
  end: number;
  cols: Col[];
}

function inferColumns(strong: Line[], em: number): Col[] {
  const compute = (segs: Seg[]): number[][] => {
    const iv = segs.map((s) => [s.x0, s.x1]).sort((a, b) => a[0] - b[0]);
    const merged: number[][] = [];
    for (const [a, b] of iv) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + em * 0.3) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    return merged;
  };
  const all = strong.flatMap((l) => l.segs);
  let merged = compute(all);
  if (merged.length < 3 && strong.length >= 4) {
    // A few very wide cells can bridge every gap; ignore the widest 10% and try again.
    const byWidth = [...all].sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0));
    merged = compute(byWidth.slice(Math.ceil(all.length * 0.1)));
  }
  return merged.map((m, i) => ({
    x0: m[0],
    x1: m[1],
    lo: i === 0 ? -Infinity : (merged[i - 1][1] + m[0]) / 2,
    hi: i === merged.length - 1 ? Infinity : (m[1] + merged[i + 1][0]) / 2,
  }));
}

function colIndex(seg: Seg, cols: Col[]): number {
  const c = (seg.x0 + seg.x1) / 2;
  for (let i = 0; i < cols.length; i++) if (c >= cols[i].lo && c < cols[i].hi) return i;
  return cols.length - 1;
}

function fits(line: Line, cols: Col[], em: number): boolean {
  return line.segs.every((s) => {
    const col = cols[colIndex(s, cols)];
    return s.x0 >= col.lo - em * 0.5 && s.x1 <= col.hi + em * 0.5;
  });
}

function detectTables(lines: Line[], em: number): Region[] {
  const regions: Region[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].segs.length < 3) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].y0 - lines[j].y1 < 4 * Math.max(em, lines[j].size)) j++;
    const window = lines.slice(i, j + 1);
    let region: Region | null = null;

    for (const candidate of [window, leadingRun(window)]) {
      const strong = candidate.filter((l) => l.segs.length >= 3);
      if (strong.length < 2) continue;
      const cols = inferColumns(strong, em);
      if (cols.length < 3) continue;
      let lastStrong = -1;
      let strongCount = 0;
      let k = 0;
      for (; k < window.length; k++) {
        if (!fits(window[k], cols, em)) break;
        if (window[k].segs.length >= 3) {
          lastStrong = k;
          strongCount++;
        }
      }
      if (strongCount < 2) continue;
      // After the last full row, keep only wrapped-cell continuations and totals-like lines.
      let end = lastStrong;
      for (let t = lastStrong + 1; t < k; t++) {
        const line = window[t];
        const firstCol = colIndex(line.segs[0], cols) === 0;
        const lastNumeric = looksNumeric(line.segs[line.segs.length - 1].text);
        const allText = line.segs.every((s) => !looksNumeric(s.text));
        if (lastNumeric || (!firstCol && allText)) end = t;
        else break;
      }
      region = { start: i, end: i + end, cols };
      break;
    }

    if (region) {
      regions.push(region);
      i = region.end + 1;
    } else {
      i++;
    }
  }
  return regions;
}

/** The first run of multi-column lines, tolerating up to two single-column lines in between. */
function leadingRun(window: Line[]): Line[] {
  const out: Line[] = [];
  let weak = 0;
  for (const line of window) {
    if (line.segs.length >= 3) {
      weak = 0;
      out.push(line);
    } else if (++weak > 2) {
      break;
    } else {
      out.push(line);
    }
  }
  return out;
}

function lowOf(words: Word[]): boolean {
  return words.some((w) => w.conf !== undefined && w.conf < LOW_CONFIDENCE);
}

function confOf(words: Word[]): number {
  const cs = words.map((w) => w.conf ?? 1);
  return cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 1;
}

/**
 * A centred header over right-aligned numbers ("Qty" above "3") can look like two columns.
 * Neighbouring columns that are never both filled on the same line are really one column.
 */
function mergeComplementaryColumns(lines: Line[], input: Col[], em: number): Col[] {
  let cols = input;
  let merged = true;
  while (merged && cols.length > 3) {
    merged = false;
    const occupancy = lines.map((line) => {
      const set = new Set<number>();
      for (const seg of line.segs) set.add(colIndex(seg, cols));
      return set;
    });
    for (let i = 0; i < cols.length - 1; i++) {
      const gap = cols[i + 1].x0 - cols[i].x1;
      const clash = occupancy.some((set) => set.has(i) && set.has(i + 1));
      const used = (c: number) => occupancy.filter((set) => set.has(c)).length;
      if (!clash && gap < em * 3.5 && used(i) > 0 && used(i + 1) > 0) {
        const joined: Col = { x0: cols[i].x0, x1: cols[i + 1].x1, lo: cols[i].lo, hi: cols[i + 1].hi };
        cols = [...cols.slice(0, i), joined, ...cols.slice(i + 2)];
        merged = true;
        break;
      }
    }
  }
  return cols;
}

function buildTable(lines: Line[], inputCols: Col[], em: number): XBlock {
  const cols = mergeComplementaryColumns(lines, inputCols, em);
  const n = cols.length;
  interface Row {
    cells: string[];
    low: boolean[];
  }
  const rows: Row[] = [];
  const allWords: Word[] = [];

  const strong = lines.filter((l) => l.segs.length >= 3);
  const serialHits = strong.filter((l) => {
    const first = l.segs[0];
    return colIndex(first, cols) === 0 && /^\(?\d{1,4}[.)]?$/.test(first.text);
  }).length;
  const hasSerialCol = serialHits >= Math.max(1, strong.length * 0.4);

  for (const line of lines) {
    const cells = Array<string>(n).fill('');
    const low = Array<boolean>(n).fill(false);
    for (const seg of line.segs) {
      const c = colIndex(seg, cols);
      cells[c] = cells[c] ? `${cells[c]} ${seg.text}` : seg.text;
      if (lowOf(seg.words)) low[c] = true;
      allWords.push(...seg.words);
    }
    const filled = cells.map((c, idx) => (c ? idx : -1)).filter((idx) => idx >= 0);
    const prev = rows[rows.length - 1];
    const textOnly = filled.every((c) => !looksNumeric(cells[c]));
    const continuation =
      prev !== undefined &&
      textOnly &&
      filled.length <= Math.max(1, Math.floor(n / 2)) &&
      filled.every((c) => prev.cells[c] !== '') &&
      (hasSerialCol ? cells[0] === '' : true);
    if (continuation) {
      for (const c of filled) {
        prev.cells[c] = `${prev.cells[c]} ${cells[c]}`;
        prev.low[c] = prev.low[c] || low[c];
      }
    } else {
      rows.push({ cells, low });
    }
  }

  let columns = Array<string>(n).fill('');
  let body = rows;
  const first = rows[0];
  if (first && !first.cells.some((c) => looksNumeric(c)) && first.cells.filter(Boolean).length >= Math.ceil(n / 2)) {
    columns = first.cells;
    body = rows.slice(1);
  }

  const col_align = inferColAlign(columns, body.map((r) => r.cells));

  const lowCells: string[] = [];
  if (body !== rows) first.low.forEach((l, c) => l && lowCells.push(`-1:${c}`));
  body.forEach((r, ri) => r.low.forEach((l, c) => l && lowCells.push(`${ri}:${c}`)));

  return {
    type: 'table',
    columns,
    col_align,
    rows: body.map((r) => r.cells),
    col_width: cols.map((c) => Math.max(c.x1 - c.x0, 1)),
    _conf: confOf(allWords),
    _lowCells: lowCells,
    _page: lines[0]?.page,
  };
}

// ---------------------------------------------------------------------------------------
// Text lines -> headings, reference details, paragraphs, lists, totals
// ---------------------------------------------------------------------------------------

interface PageContext {
  left: number;
  right: number;
  /** Body font size of the document in page units. */
  body: number;
  mmPerUnit: number;
  state: { tableSeen: boolean; headingSeen: boolean };
}

const META_LABEL_RE =
  /^(our\s+|your\s+)?(ref(erence)?|quotation|quote|qtn|enquiry|inquiry|enq|date|dated|valid(ity)?(\s+(up\s*to|until|till))?|p\.?o\.?|order|offer)(\s*(no|number|ref|date|#))?\.?$/i;
const META_RE = /^([A-Za-z][A-Za-z0-9 .\/&'#-]{1,30}?)\s*[:\uFF1A]\s*(.*)$/;

export function metaOf(text: string): LabelValue | null {
  const m = text.match(META_RE);
  if (!m) return null;
  const label = m[1].trim();
  const value = m[2].trim();
  if (!META_LABEL_RE.test(label) || value.length > 60) return null;
  return { label, value };
}

const LIST_NUM_RE = /^\(?(\d{1,2})[.)]\s+(\S.*)$/;
const LIST_BULLET_RE = /^([•●▪■◦‣·⁃➢✓*\-–—])\s+(\S.*)$/;

const TITLE_RE = /\b(quotation|quote|estimate|proforma|pro-forma|offer|proposal|invoice)\b/i;

function lineAlign(line: Line, ctx: PageContext): Align {
  const width = Math.max(ctx.right - ctx.left, 1);
  const leftOff = line.x0 - ctx.left;
  const rightOff = ctx.right - line.x1;
  if (leftOff > width * 0.12 && Math.abs(leftOff - rightOff) < Math.max(2 * line.size, width * 0.05)) return 'center';
  if (leftOff > width * 0.4 && rightOff < 2.5 * line.size) return 'right';
  return 'left';
}

function lineRuns(line: Line, segs: Seg[]): Run[] {
  const runs: Run[] = [];
  const push = (text: string, bold: boolean, italic: boolean) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && !!last.bold === bold && !!last.italic === italic) last.text += text;
    else runs.push({ text, bold, italic, underline: false });
  };
  segs.forEach((seg, si) => {
    if (si > 0) push('    ', false, false);
    seg.words.forEach((w, wi) => {
      const sep = wi > 0 ? separator(seg.words[wi - 1], w, line.size, line.ocr) : '';
      push(sep + w.text.replace(/\s+/g, ' '), !!w.bold, !!w.italic);
    });
  });
  return runs;
}

function tidyRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const text = r.text.replace(/[ \t]{5,}/g, '    ');
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && !!last.bold === !!r.bold && !!last.italic === !!r.italic && !!last.underline === !!r.underline) last.text += text;
    else out.push({ ...r, text });
  }
  if (out.length) {
    out[0].text = out[0].text.replace(/^\s+/, '');
    out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
  }
  // Bold/italic that covers only whitespace is noise.
  return out.filter((r) => r.text !== '');
}

function isAllBold(line: Line): boolean {
  const ws = line.segs.flatMap((s) => s.words);
  return ws.length > 0 && ws.every((w) => w.bold);
}

interface Group {
  lines: Line[];
  segs: Seg[][];
  align: Align;
  bold: boolean;
}

interface ListItem {
  marker: string;
  num: number | null;
  text: string;
  x0: number;
  textX: number;
  words: Word[];
}

function textLinesToBlocks(lines: Line[], ctx: PageContext, out: XBlock[]): void {
  let group: Group | null = null;
  let meta: LabelValue[] = [];
  let metaWords: Word[] = [];
  let list: ListItem[] = [];
  let listLastLine: Line | null = null;
  let totals: TotalsItem[] = [];
  let totalsWords: Word[] = [];
  let lastBottom: number | null = null;

  const emit = (block: XBlock, top: number, bottom: number) => {
    if (lastBottom !== null) {
      const gap = top - lastBottom;
      if (gap > ctx.body * 2.5) {
        const mm = Math.min(10, Math.max(2, Math.round(gap * ctx.mmPerUnit * 0.5)));
        out.push({ type: 'spacer', mm, _page: block._page });
      }
    }
    out.push(block);
    lastBottom = bottom;
  };

  const flushMeta = (top: number, bottom: number) => {
    if (!meta.length) return;
    emit(
      { type: 'meta', items: meta, _conf: confOf(metaWords), _low: metaWords.filter((w) => lowOf([w])).map((w) => w.text), _page: lines[0]?.page },
      top,
      bottom,
    );
    meta = [];
    metaWords = [];
  };

  const flushGroup = () => {
    if (!group) return;
    const g = group;
    group = null;
    const top = g.lines[0].y0;
    const bottom = g.lines[g.lines.length - 1].y1;
    flushMeta(top, top);

    const words = g.segs.flat().flatMap((s) => s.words);
    const base = {
      _conf: confOf(words),
      _low: words.filter((w) => lowOf([w])).map((w) => w.text),
      _indent: (Math.min(...g.lines.map((l) => l.x0)) - ctx.left) / Math.max(ctx.right - ctx.left, 1),
      _page: g.lines[0].page,
    };
    const text = g.segs.map((segs) => segs.map((s) => s.text).join(' ')).join(' ');
    const size = median(g.lines.map((l) => l.size));

    // Heading: one short line that is clearly larger, or centred and bold / ALL CAPS.
    if (g.lines.length === 1 && text.length <= 70) {
      const bigger = size >= ctx.body * 1.18;
      const caps = /[A-Z]/.test(text) && text === text.toUpperCase() && !/\d{3,}/.test(text);
      const centredTitle = g.align === 'center' && (g.bold || caps) && text.length <= 50;
      if (bigger || centredTitle) {
        const level = size >= ctx.body * 1.4 || TITLE_RE.test(text) || !ctx.state.headingSeen ? 1 : 2;
        ctx.state.headingSeen = true;
        emit({ type: 'heading', text, level, align: g.align === 'justify' ? 'left' : g.align, ...base }, top, bottom);
        return;
      }
    }

    // Join lines: soft wrap (space) when the next word would not have fitted, else keep the break.
    // Lines that stop well short of the right margin (an address, "Dear Sir,") are separate lines.
    const groupRight = Math.max(...g.lines.map((l) => l.x1));
    const wraps = groupRight >= ctx.right - (ctx.right - ctx.left) * 0.15;
    const runs: Run[] = [];
    let justified = g.align === 'left' && wraps && g.lines.length >= 3;
    g.lines.forEach((line, i) => {
      runs.push(...lineRuns(line, g.segs[i]));
      const next = g.lines[i + 1];
      if (!next) return;
      const nextFirst = g.segs[i + 1][0].words[0];
      const firstWord = nextFirst.text.trim().split(/\s+/)[0] ?? '';
      const charW = (nextFirst.x1 - nextFirst.x0) / Math.max(nextFirst.text.trim().length, 1);
      const wouldFit = line.x1 + line.size * 0.3 + firstWord.length * charW < groupRight - line.size * 0.2;
      const hard = g.align !== 'left' || !wraps || wouldFit || /[:;]$/.test(line.text.trim());
      runs.push({ text: hard ? '\n' : ' ' });
      if (line.x1 < groupRight - line.size) justified = false;
    });
    emit({ type: 'paragraph', runs: tidyRuns(runs), align: justified ? 'justify' : g.align, ...base }, top, bottom);
  };

  const flushList = () => {
    if (!list.length) return;
    const items = list;
    list = [];
    listLastLine = null;
    const words = items.flatMap((it) => it.words);
    const base = { _conf: confOf(words), _low: words.filter((w) => lowOf([w])).map((w) => w.text), _page: lines[0]?.page };
    const top = Math.min(...words.map((w) => w.y0));
    const bottom = Math.max(...words.map((w) => w.y1));
    const numbered = items.every((it) => it.num !== null);
    const sequential = numbered && items.every((it, i) => it.num === i + 1);
    const bullets = items.every((it) => it.num === null);
    if ((sequential && items.length >= 2) || bullets) {
      emit({ type: 'list', ordered: sequential, items: items.map((it) => it.text), ...base }, top, bottom);
    } else {
      // Not a clean 1,2,3 list: keep the original markers so nothing is lost.
      emit(
        { type: 'paragraph', runs: [{ text: items.map((it) => `${it.marker} ${it.text}`).join('\n') }], align: 'left', ...base },
        top,
        bottom,
      );
    }
  };

  const flushTotals = () => {
    if (!totals.length) return;
    const top = Math.min(...totalsWords.map((w) => w.y0));
    const bottom = Math.max(...totalsWords.map((w) => w.y1));
    emit(
      {
        type: 'totals',
        items: totals,
        _conf: confOf(totalsWords),
        _low: totalsWords.filter((w) => lowOf([w])).map((w) => w.text),
        _page: lines[0]?.page,
      },
      top,
      bottom,
    );
    totals = [];
    totalsWords = [];
  };

  const flushAll = () => {
    flushGroup();
    flushList();
    flushTotals();
  };

  for (const line of lines) {
    const text = line.text.trim();

    // Totals written as plain lines under a table: "Sub Total        3,000.00".
    if (ctx.state.tableSeen) {
      let label = '';
      let value = '';
      if (line.segs.length >= 2 && looksNumeric(line.segs[line.segs.length - 1].text)) {
        label = line.segs.slice(0, -1).map((s) => s.text).join(' ');
        value = line.segs[line.segs.length - 1].text;
      } else {
        const m = text.match(/^(.*?[A-Za-z%)])\s*[:\-–]?\s+((?:₹|rs\.?|inr)?\s*-?\d[\d,]*\.\d{1,2}(?:\/-)?)$/i);
        if (m) [, label, value] = m;
      }
      if (label && value && classifyTotalsLabel(label) !== 'other') {
        flushGroup();
        flushList();
        const kind = classifyTotalsLabel(label);
        totals.push({ label: label.replace(/\s*[:\-–]\s*$/, ''), value, ...(kind === 'grand' ? { bold: true } : {}) });
        totalsWords.push(...line.segs.flatMap((s) => s.words));
        continue;
      }
    }
    flushTotals();

    // Lists.
    const num = text.match(LIST_NUM_RE);
    const bullet = num ? null : text.match(LIST_BULLET_RE);
    if (num || bullet) {
      flushGroup();
      const marker = (num ? text.slice(0, text.length - num[2].length) : bullet![1]).trim();
      const body = num ? num[2] : bullet![2];
      const family = num ? 'n' : 'b';
      const prevFamily = list.length ? (list[0].num !== null ? 'n' : 'b') : family;
      if (family !== prevFamily) flushList();
      const firstSegWords = line.segs[0].words;
      const textWord = firstSegWords.length > 1 ? firstSegWords[1] : firstSegWords[0];
      list.push({
        marker,
        num: num ? Number(num[1]) : null,
        text: clean(body),
        x0: line.x0,
        textX: firstSegWords.length > 1 ? textWord.x0 : line.x0 + line.size,
        words: line.segs.flatMap((s) => s.words),
      });
      listLastLine = line;
      continue;
    }
    if (list.length && listLastLine) {
      const last = list[list.length - 1];
      const gap = line.y0 - listLastLine.y1;
      if (gap < line.size * 0.9 && line.x0 >= last.x0 + line.size * 0.6) {
        last.text = `${last.text} ${text}`;
        last.words.push(...line.segs.flatMap((s) => s.words));
        listLastLine = line;
        continue;
      }
      flushList();
    }

    // Reference details ("Ref No: ...", "Date: ...") before the first table.
    let segs = line.segs;
    if (!ctx.state.tableSeen) {
      const metas = segs.map((s) => metaOf(s.text));
      if (metas.every(Boolean)) {
        flushGroup();
        const items = metas as LabelValue[];
        if (meta.length && items.length) items[0] = { ...items[0], break: true };
        meta.push(...items);
        metaWords.push(...segs.flatMap((s) => s.words));
        continue;
      }
      // "To,                Ref No: Q/45"  ->  the right-hand part is a reference detail.
      let cut = segs.length;
      while (cut > 1 && metas[cut - 1]) cut--;
      if (cut < segs.length) {
        const items = metas.slice(cut) as LabelValue[];
        if (meta.length && items.length) items[0] = { ...items[0], break: true };
        meta.push(...items);
        metaWords.push(...segs.slice(cut).flatMap((s) => s.words));
        segs = segs.slice(0, cut);
      }
    }

    // Paragraph grouping.
    const sub: Line = segs === line.segs ? line : { ...line, segs, x1: segs[segs.length - 1].x1, text: segs.map((s) => s.text).join(' ') };
    const align = lineAlign(sub, ctx);
    const bold = isAllBold(sub);
    if (group) {
      const prev: Line = group.lines[group.lines.length - 1];
      const gap = sub.y0 - prev.y1;
      const sameSize = Math.abs(sub.size - prev.size) <= Math.max(sub.size, prev.size) * 0.15;
      const sameLeft = align !== 'left' || Math.abs(sub.x0 - prev.x0) < 3 * sub.size;
      if (!(gap < sub.size * 0.9 && sameSize && sameLeft && align === group.align && bold === group.bold)) flushGroup();
    }
    if (!group) group = { lines: [], segs: [], align, bold };
    group.lines.push(sub);
    group.segs.push(segs);
  }
  flushAll();
  if (meta.length) {
    const y = lines.length ? lines[lines.length - 1].y1 : 0;
    flushMeta(y, y);
  }
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------
// Ruled boxes (digital PDFs whose tables are drawn with lines)
// ---------------------------------------------------------------------------------------

const centreIn = (w: Word, c: Cell) => {
  const x = (w.x0 + w.x1) / 2;
  const y = (w.y0 + w.y1) / 2;
  return x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1;
};
const inGrid = (w: Word, g: Grid) => g.cells.some((c) => centreIn(w, c));

const cellText = (lines: Line[], sep: string) =>
  lines
    .map((l) => clean(l.text))
    .filter(Boolean)
    .join(sep);

interface BoxCell {
  cell: Cell;
  lines: Line[];
}

/** One row of boxes in a grid: the boxes that start at the same height. */
function gridBands(grid: Grid, words: Word[], page: PageWords, p: number): BoxCell[][] {
  const bands: BoxCell[][] = [];
  const cells = [...grid.cells].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  for (const cell of cells) {
    const ws = words.filter((w) => centreIn(w, cell));
    const box = { cell, lines: ws.length ? buildLines({ ...page, words: ws }, p) : [] };
    const band = bands[bands.length - 1];
    if (band && Math.abs(band[0].cell.y0 - cell.y0) <= 2) band.push(box);
    else bands.push([box]);
  }
  for (const band of bands) band.sort((a, b) => a.cell.x0 - b.cell.x0);
  return bands;
}

const sameColumns = (a: BoxCell[], b: BoxCell[]) =>
  a.length === b.length && a.every((box, i) => Math.abs(box.cell.x0 - b[i].cell.x0) <= 2 && Math.abs(box.cell.x1 - b[i].cell.x1) <= 2);

const numericLines = (lines: Line[]) => lines.filter((l) => looksNumeric(l.text.trim()));

/** Consecutive boxed rows with the same columns -> one table. Rows inside one box are split at the amounts. */
function bandsToTable(bands: BoxCell[][], p: number): XBlock {
  const n = bands[0].length;
  let columns = Array<string>(n).fill('');
  let body = bands;
  const first = bands[0];
  if (bands.length > 1 && first.every((b) => numericLines(b.lines).length === 0) && first.some((b) => b.lines.length)) {
    columns = first.map((b) => cellText(b.lines, ' '));
    body = bands.slice(1);
  }

  const rows: string[][] = [];
  body.forEach((band, bandIndex) => {
    const counts = band.map((b) => numericLines(b.lines).length);
    const most = Math.max(...counts);
    if (most <= 1) {
      // One boxed row = one table row, however many lines its text wraps to.
      rows.push(band.map((b) => cellText(b.lines, ' ')));
      return;
    }
    // Several rows inside one box (columns ruled, rows not): split at the amounts.
    const key = counts.indexOf(most);
    const anchors = numericLines(band[key].lines).sort((a, b) => a.y0 - b.y0);
    const allLines = band.flatMap((b) => b.lines);
    const top = Math.min(...allLines.map((l) => l.y0));
    const size = median(allLines.map((l) => l.size)) || 10;
    const keyFirst = [...band[key].lines].sort((a, b) => a.y0 - b.y0)[0];
    // A text line above the first amount in the amount column is the heading row.
    const headerCut = bandIndex === 0 && columns.every((c) => !c) && !looksNumeric(keyFirst.text.trim()) ? (keyFirst.y1 + anchors[0].y0) / 2 : null;
    const firstTop = headerCut === null ? top : Math.min(...allLines.filter((l) => (l.y0 + l.y1) / 2 > headerCut).map((l) => l.y0));
    const topAligned = Math.abs(firstTop - anchors[0].y0) < size * 0.6;
    const bounds = anchors.slice(1).map((a, t) => (topAligned ? a.y0 - size * 0.3 : (anchors[t].y1 + a.y0) / 2));
    const head = Array<string>(n).fill('');
    const split = anchors.map(() => Array<string>(n).fill(''));
    band.forEach((b, c) => {
      for (const line of [...b.lines].sort((x, y) => x.y0 - y.y0)) {
        const y = (line.y0 + line.y1) / 2;
        const text = clean(line.text);
        if (headerCut !== null && y < headerCut) {
          head[c] = head[c] ? head[c] + ' ' + text : text;
          continue;
        }
        const r = bounds.filter((bound) => y > bound).length;
        split[r][c] = split[r][c] ? split[r][c] + ' ' + text : text;
      }
    });
    if (head.some(Boolean)) columns = head;
    rows.push(...split);
  });

  return {
    type: 'table',
    columns,
    col_align: inferColAlign(columns, rows),
    rows,
    col_width: first.map((b) => Math.max(b.cell.x1 - b.cell.x0, 1)),
    _conf: 1,
    _lowCells: [],
    _page: p,
  };
}

function gridToBlocks(
  grid: Grid,
  words: Word[],
  page: PageWords,
  p: number,
  ctx: PageContext,
  flow: (lines: Line[], ctx: PageContext) => void,
  out: XBlock[],
): void {
  const allBands = gridBands(grid, words, page, p);
  for (let i = 0; i < allBands.length; i++) {
    const band = allBands[i];
    const filled = band.filter((b) => b.lines.length);

    if (band.length >= 3) {
      let j = i;
      while (j + 1 < allBands.length && sameColumns(allBands[j + 1], band)) j++;
      out.push(bandsToTable(allBands.slice(i, j + 1), p));
      ctx.state.tableSeen = true;
      i = j;
      continue;
    }

    if (!filled.length) continue;

    if (band.length === 2 && filled.length === 2) {
      const left = cellText(band[0].lines, ' ');
      const right = cellText(band[1].lines, ' ');
      const kind = classifyTotalsLabel(left);
      if (looksNumeric(right) && kind !== 'other') {
        // "Total Amount | 38,092.09"
        out.push({
          type: 'totals',
          items: [{ label: left.replace(/\s*:\s*$/, ''), value: right, ...(kind === 'grand' || kind === 'total' ? { bold: true } : {}) }],
          _conf: 1,
          _low: [],
          _page: p,
        });
        continue;
      }
      // Two boxes side by side (customer address | quotation details): keep them side by side.
      out.push({
        type: 'table',
        columns: ['', ''],
        col_align: ['left', looksNumeric(right) ? 'right' : 'left'],
        rows: [[cellText(band[0].lines, '\n'), cellText(band[1].lines, '\n')]],
        col_width: band.map((b) => Math.max(b.cell.x1 - b.cell.x0, 1)),
        _conf: 1,
        _lowCells: [],
        _page: p,
      });
      continue;
    }

    // One box across the page: whatever is inside reads like normal text.
    flow(
      filled.flatMap((b) => b.lines).sort((a, b) => a.y0 - b.y0),
      ctx,
    );
  }
}

export interface Reconstruction {
  blocks: XBlock[];
  removed: string[];
  sourceText: string;
}

export function reconstruct(pages: PageWords[]): Reconstruction {
  const rawLines = pages.map((p, i) => buildLines(p, i));
  const { pages: pageLines, removed } = removeHeaderFooter(
    rawLines,
    pages.map((p) => p.height),
  );
  const sourceText = pageLines.map((ls) => ls.map((l) => l.text).join('\n')).join('\n');

  const allLines = pageLines.flat();
  const body = median(allLines.map((l) => l.size)) || 10;
  const state = { tableSeen: false, headingSeen: false };
  const blocks: XBlock[] = [];

  /** Lines without drawn table lines: tables are found from the text layout. */
  const flow = (lines: Line[], ctx: PageContext) => {
    const regions = detectTables(lines, body);
    let cursor = 0;
    for (const region of regions) {
      if (region.start > cursor) textLinesToBlocks(lines.slice(cursor, region.start), ctx, blocks);
      blocks.push(buildTable(lines.slice(region.start, region.end + 1), region.cols, body));
      state.tableSeen = true;
      cursor = region.end + 1;
    }
    if (cursor < lines.length) textLinesToBlocks(lines.slice(cursor), ctx, blocks);
  };

  pageLines.forEach((lines, p) => {
    if (!lines.length) return;
    const page = pages[p];
    const ctx: PageContext = {
      left: percentile(lines.map((l) => l.x0), 0.03),
      right: percentile(lines.map((l) => l.x1), 0.97),
      body,
      mmPerUnit: 210 / Math.max(page.width, 1),
      state,
    };
    const words = lines.flatMap((l) => l.segs.flatMap((s) => s.words));
    const grids = !page.ocr && page.rules?.length ? findGrids(page.rules).filter((g) => words.some((w) => inGrid(w, g))) : [];
    if (!grids.length) {
      flow(lines, ctx);
      return;
    }
    // Text outside the drawn boxes flows as usual, in reading order around the boxes.
    const outside = buildLines({ ...page, words: words.filter((w) => !grids.some((g) => inGrid(w, g))) }, p);
    let next = 0;
    for (const grid of grids) {
      const before: Line[] = [];
      while (next < outside.length && (outside[next].y0 + outside[next].y1) / 2 < grid.y0) before.push(outside[next++]);
      if (before.length) flow(before, ctx);
      gridToBlocks(grid, words, page, p, ctx, flow, blocks);
    }
    if (next < outside.length) flow(outside.slice(next), ctx);
  });

  return { blocks, removed, sourceText };
}
