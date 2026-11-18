import { looksNumeric } from '@/lib/format';
import type { Align, LabelValue, Run } from '@/schema/canonical';
import { metaOf } from './reconstruct';
import { refineBlocks } from './refine';
import { classifyTotalsLabel } from '@/validate/totals';
import { subtractTokens } from '@/validate/coverage';
import { inferColAlign } from './tableUtil';
import { finalizeBlocks, type ExtractResult, type XBlock } from './types';

/**
 * Word (.docx) -> canonical blocks.
 * mammoth.js turns the document into clean HTML (paragraphs, bold/italic/underline,
 * tables, lists). Paragraph alignment is carried through a document transform because
 * mammoth ignores it by default.
 */

const ALIGNS = ['left', 'center', 'right', 'both'] as const;

function styleMap(): string[] {
  const map = ['u => u', 'strike => s'];
  for (const a of ALIGNS) {
    map.push(`p[style-name='qp-p-${a}'] => p.qp-${a}:fresh`);
    for (const n of [1, 2, 3]) map.push(`p[style-name='qp-h${n}-${a}'] => h${n}.qp-${a}:fresh`);
  }
  return map;
}

interface MammothParagraph {
  type: 'paragraph';
  styleId?: string | null;
  styleName?: string | null;
  alignment?: string | null;
  numbering?: unknown;
}

function headingLevel(styleName: string | null | undefined): number | null {
  if (!styleName) return null;
  const m = styleName.match(/^heading\s*(\d)/i);
  if (m) return Math.min(3, Math.max(1, Number(m[1])));
  if (/^title$/i.test(styleName)) return 1;
  if (/^subtitle$/i.test(styleName)) return 2;
  return null;
}

function tagAlignment(p: MammothParagraph): MammothParagraph {
  if (p.numbering) return p;
  const level = headingLevel(p.styleName);
  let align = (p.alignment ?? '').toLowerCase();
  if (align === 'justify' || align === 'distribute') align = 'both';
  if (align === 'start') align = 'left';
  if (align === 'end') align = 'right';
  if (!ALIGNS.includes(align as (typeof ALIGNS)[number])) align = level !== null && /^title$/i.test(p.styleName ?? '') ? 'center' : '';
  if (!align && level === null) return p;
  if (!align) align = 'left';
  const name = level !== null ? `qp-h${level}-${align}` : `qp-p-${align}`;
  return { ...p, styleId: name, styleName: name };
}

export interface DocxHtml {
  html: string;
  messages: string[];
}

type MammothLib = {
  convertToHtml: (input: { arrayBuffer: ArrayBuffer }, options?: Record<string, unknown>) => Promise<{ value: string; messages: { message: string }[] }>;
  images: { imgElement: (f: () => Promise<{ src: string }>) => unknown };
  transforms: { paragraph: (f: (p: MammothParagraph) => MammothParagraph) => (el: unknown) => unknown };
};

/** Runs mammoth. Has no DOM dependency, so it can run inside a web worker. */
export async function docxToHtml(arrayBuffer: ArrayBuffer): Promise<DocxHtml> {
  const mod = (await import('mammoth/mammoth.browser.js')) as unknown as { default?: MammothLib } & MammothLib;
  const mammoth: MammothLib = mod.default ?? mod;
  const result = await mammoth.convertToHtml(
    { arrayBuffer },
    {
      styleMap: styleMap(),
      includeDefaultStyleMap: true,
      ignoreEmptyParagraphs: false,
      // Pictures are not copied; an empty marker lets us count and report them.
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
      transformDocument: mammoth.transforms.paragraph(tagAlignment),
    },
  );
  return { html: result.value, messages: result.messages.map((m) => m.message) };
}

function alignOf(el: Element, fallback: Align = 'left'): Align {
  if (el.classList.contains('qp-center')) return 'center';
  if (el.classList.contains('qp-right')) return 'right';
  if (el.classList.contains('qp-both')) return 'justify';
  if (el.classList.contains('qp-left')) return 'left';
  return fallback;
}

function collectRuns(node: Node, style: { bold: boolean; italic: boolean; underline: boolean }, out: Run[]): void {
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      const text = (child.textContent ?? '').replace(/\xA0/g, ' ');
      if (text) out.push({ text, ...style });
      return;
    }
    if (child.nodeType !== 1) return;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') {
      out.push({ text: '\n', bold: false, italic: false, underline: false });
      return;
    }
    if (tag === 'img') return;
    collectRuns(
      el,
      {
        bold: style.bold || tag === 'strong' || tag === 'b',
        italic: style.italic || tag === 'em' || tag === 'i',
        underline: style.underline || tag === 'u',
      },
      out,
    );
  });
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && !!last.bold === !!r.bold && !!last.italic === !!r.italic && !!last.underline === !!r.underline) last.text += r.text;
    else out.push({ ...r });
  }
  if (out.length) {
    out[0].text = out[0].text.replace(/^[ \t]+/, '');
    out[out.length - 1].text = out[out.length - 1].text.replace(/[ \t\n]+$/, '');
  }
  return out.filter((r) => r.text !== '');
}

/** Text of a table cell / list item: paragraphs become line breaks. */
function cellText(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Node, acc: string[]) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) acc.push((child.textContent ?? '').replace(/\xA0/g, ' '));
      else if (child.nodeType === 1) {
        const tag = (child as Element).tagName.toLowerCase();
        if (tag === 'br') acc.push('\n');
        else if (['p', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div'].includes(tag)) {
          const inner: string[] = [];
          walk(child, inner);
          const text = inner.join('').trim();
          if (text) parts.push(text);
        } else if (tag === 'td' || tag === 'th') {
          const inner: string[] = [];
          walk(child, inner);
          acc.push(inner.join('') + ' ');
        } else if (tag !== 'img') walk(child, acc);
      }
    });
  };
  const loose: string[] = [];
  walk(el, loose);
  const direct = loose.join('').trim();
  if (direct) parts.unshift(direct);
  return parts
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

const rowsOf = (table: Element) => Array.from(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table);

function tableBlock(table: Element, only?: Element[]): XBlock | null {
  const trs = only ?? rowsOf(table);
  if (!trs.length) return null;
  let headerMarked = false;
  const grid: string[][] = trs.map((tr, r) => {
    const cells: string[] = [];
    Array.from(tr.children).forEach((cell) => {
      if (r === 0 && cell.tagName.toLowerCase() === 'th') headerMarked = true;
      cells.push(cellText(cell));
      const span = Number(cell.getAttribute('colspan') ?? '1');
      for (let k = 1; k < span; k++) cells.push('');
    });
    return cells;
  });
  const n = Math.max(...grid.map((r) => r.length));
  const rect = grid.map((r) => [...r, ...Array<string>(n - r.length).fill('')]);

  let columns = Array<string>(n).fill('');
  let rows = rect;
  const first = rect[0];
  const looksLikeHeader = !first.some((c) => looksNumeric(c)) && first.filter((c) => c.trim()).length >= Math.ceil(n / 2);
  if (rect.length > 1 && (headerMarked || looksLikeHeader)) {
    columns = first.map((c) => c.replace(/\n/g, ' '));
    rows = rect.slice(1);
  }
  return { type: 'table', columns, col_align: inferColAlign(columns, rows), rows };
}

const TITLE_RE = /\b(quotation|quote|estimate|proforma|pro-forma|offer|proposal)\b/i;

export interface HtmlBlocks {
  blocks: XBlock[];
  text: string;
  images: number;
}

/** Mammoth HTML -> blocks. Needs a DOM (main thread, or jsdom in tests). */
export function htmlToBlocks(html: string): HtmlBlocks {
  const dom = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  const blocks: XBlock[] = [];
  let emptyRun = 0;

  const flushEmpty = () => {
    if (emptyRun > 0 && blocks.length) blocks.push({ type: 'spacer', mm: Math.min(12, emptyRun * 4) });
    emptyRun = 0;
  };

  const paragraph = (el: Element) => {
    const runs: Run[] = [];
    collectRuns(el, { bold: false, italic: false, underline: false }, runs);
    const merged = mergeRuns(runs);
    const text = merged.map((r) => r.text).join('');
    if (!text.trim()) {
      emptyRun++;
      return;
    }
    const emptyBefore = emptyRun;
    flushEmpty();

    // "Ref No: Q/45 <tab> Date: 17-11-2026" and similar lines become reference details.
    const parts = text
      .split(/\t+|\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    const metas = parts.map((p) => metaOf(p));
    if (parts.length && metas.every(Boolean)) {
      blocks.push({ type: 'meta', items: metas as LabelValue[] });
      return;
    }
    const tidy = merged.map((r) => ({ ...r, text: r.text.replace(/\t+/g, '    ') }));
    // Columns typed with tabs ("ABC <tab> 17 <tab> No <tab> 349.33"): remember the parts.
    const tabbed = text.includes('\t') && !text.includes('\n') ? text.split(/\t+/).map((p) => p.trim()).filter(Boolean) : [];
    const align = alignOf(el);

    // Address lines ("To," / "The Manager," / "ABC Ltd,") are separate paragraphs in Word;
    // keep them together as one block of lines instead of five spaced-out paragraphs.
    const prev = blocks[blocks.length - 1];
    if (emptyBefore === 0 && prev?.type === 'paragraph' && prev.align === align && text.length <= 60 && !text.includes('\n')) {
      const prevText = prev.runs.map((r) => r.text).join('');
      const lastLine = prevText.split('\n').pop() ?? '';
      if (lastLine.length <= 60 && /,\s*$/.test(lastLine)) {
        prev.runs.push({ text: '\n' }, ...tidy);
        return;
      }
    }
    blocks.push({ type: 'paragraph', runs: tidy, align, ...(tabbed.length >= 2 ? { _cells: tabbed } : {}) });
  };

  /**
   * A table used for page layout (Excel / PDF converted to Word): rows of merged boxes.
   * Rows with 3+ boxes are a real table; two boxes side by side are an address | details
   * pair or a "Total Amount | 38,092.09" line; one box across is ordinary text.
   */
  const layoutTable = (table: Element) => {
    const trs = rowsOf(table);
    const cellsOf = (tr: Element) => Array.from(tr.children).filter((c) => ['td', 'th'].includes(c.tagName.toLowerCase()));
    if (trs.every((tr) => cellsOf(tr).length >= 3)) {
      const t = tableBlock(table);
      if (t) blocks.push(t);
      return;
    }
    for (let i = 0; i < trs.length; i++) {
      const cells = cellsOf(trs[i]);
      const filled = cells.filter((c) => cellText(c));
      if (!filled.length) continue;
      if (cells.length >= 3) {
        let j = i;
        // Rows with fewer boxes under a table ("Sub Total" spanning the first columns) stay in it.
        while (j + 1 < trs.length && cellsOf(trs[j + 1]).length >= 2) j++;
        flushEmpty();
        const t = tableBlock(table, trs.slice(i, j + 1));
        if (t) blocks.push(t);
        i = j;
        continue;
      }
      if (cells.length === 2 && filled.length === 2) {
        flushEmpty();
        const left = cellText(cells[0]);
        const right = cellText(cells[1]);
        const label = left.replace(/\n/g, ' ');
        const kind = classifyTotalsLabel(label);
        if (looksNumeric(right) && kind !== 'other') {
          blocks.push({ type: 'totals', items: [{ label: label.replace(/\s*:\s*$/, ''), value: right, ...(kind === 'grand' || kind === 'total' ? { bold: true } : {}) }] });
        } else {
          blocks.push({ type: 'table', columns: ['', ''], col_align: ['left', looksNumeric(right) ? 'right' : 'left'], rows: [[left, right]] });
        }
        continue;
      }
      // One box across the page: its paragraphs are ordinary text.
      emptyRun = 0;
      for (const cell of filled) Array.from(cell.children).forEach(visit);
      emptyRun = 0;
    }
  };

  const visit = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const text = cellText(el).replace(/\n/g, ' ');
      if (!text) return;
      flushEmpty();
      const level = Math.min(3, Number(tag[1])) as 1 | 2 | 3;
      blocks.push({ type: 'heading', text, level, align: alignOf(el, level === 1 ? 'center' : 'left') });
    } else if (tag === 'p') {
      paragraph(el);
    } else if (tag === 'table') {
      flushEmpty();
      layoutTable(el);
    } else if (tag === 'ul' || tag === 'ol') {
      flushEmpty();
      const items = Array.from(el.children)
        .filter((li) => li.tagName.toLowerCase() === 'li')
        .map((li) => cellText(li).replace(/\n/g, ' '))
        .filter(Boolean);
      if (items.length) blocks.push({ type: 'list', ordered: tag === 'ol', items });
    } else {
      Array.from(el.children).forEach(visit);
    }
  };
  Array.from(dom.body.children).forEach(visit);

  // No heading style used: promote an obvious centred / bold title line.
  if (!blocks.some((b) => b.type === 'heading')) {
    const idx = blocks.findIndex((b) => b.type !== 'spacer');
    const limit = Math.min(blocks.length, idx + 6);
    for (let i = Math.max(idx, 0); i < limit; i++) {
      const b = blocks[i];
      if (b.type !== 'paragraph') continue;
      const text = b.runs.map((r) => r.text).join('').trim();
      const allBold = b.runs.every((r) => r.bold || !r.text.trim());
      const caps = /[A-Z]/.test(text) && text === text.toUpperCase();
      if (text.length <= 50 && !text.includes('\n') && TITLE_RE.test(text) && (b.align === 'center' || allBold || caps)) {
        blocks[i] = { type: 'heading', text, level: 1, align: b.align === 'justify' ? 'center' : b.align };
        break;
      }
    }
  }

  // Put a break after every block-level element so neighbouring cells do not fuse into one word.
  const spaced = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(td|th|p|li|tr|h[1-6])>/gi, (m) => `${m}\n`);
  const textDom = new DOMParser().parseFromString(`<!doctype html><html><body>${spaced}</body></html>`, 'text/html');
  const text = (textDom.body.textContent ?? '').replace(/\xA0/g, ' ');
  return { blocks: tabTables(blocks), text, images: dom.body.querySelectorAll('img').length };
}

/** Paragraphs whose columns are separated by tabs -> one table. */
function tabTables(blocks: XBlock[]): XBlock[] {
  const out: XBlock[] = [];
  const partsOf = (b: XBlock | undefined) => (b?.type === 'paragraph' ? (b._cells ?? []) : []);
  for (let i = 0; i < blocks.length; i++) {
    const run: string[][] = [];
    for (let j = i; j < blocks.length && partsOf(blocks[j]).length >= (run.length ? 2 : 3); j++) run.push(partsOf(blocks[j]));
    const wide = run.filter((p) => p.length >= 3);
    if (wide.length < 2) {
      out.push(blocks[i]);
      continue;
    }
    // Most common number of columns among the rows (the first row may be odd, see below).
    const counts = new Map<number, number>();
    for (const p of wide.slice(1)) counts.set(p.length, (counts.get(p.length) ?? 0) + 1);
    const k = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    const rows = run.map((p) => [...p]);
    // The heading and the first row fused into one paragraph ("... AMOUNT HMB <tab> 278 ..."),
    // which happens when a PDF was converted to Word: split them again.
    if (rows[0].length === 2 * k - 1) {
      const mid = rows[0][k - 1];
      const cut = mid.lastIndexOf(' ');
      if (cut > 0) {
        const fused = rows.shift()!;
        rows.unshift([...fused.slice(0, k - 1), mid.slice(0, cut)], [mid.slice(cut + 1), ...fused.slice(k)]);
      }
    }
    const fit = (p: string[]) =>
      p.length === k ? p : p.length < k ? [p[0], ...Array<string>(k - p.length).fill(''), ...p.slice(1)] : [p.slice(0, p.length - k + 1).join(' '), ...p.slice(p.length - k + 1)];
    const grid = rows.map(fit);
    const header = !grid[0].some((c) => looksNumeric(c));
    const columns = header ? grid[0] : Array<string>(k).fill('');
    const body = header ? grid.slice(1) : grid;
    out.push({ type: 'table', columns, col_align: inferColAlign(columns, body), rows: body });
    i += run.length - 1;
  }
  return out;
}

/**
 * The page count Word saved in the file (docProps/app.xml, `<Pages>`), or null. Used to
 * keep a one-page Word quotation on one page. Reads just that one entry of the zip.
 */
export async function docxPageCount(buffer: ArrayBuffer): Promise<number | null> {
  try {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const entries = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    for (let n = 0; n < entries && p + 46 <= bytes.length; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) return null;
      const method = view.getUint16(p + 10, true);
      const size = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const skip = nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
      const local = view.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + skip;
      if (name !== 'docProps/app.xml') continue;
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const raw = bytes.slice(start, start + size);
      let xml: string;
      if (method === 0) xml = new TextDecoder().decode(raw);
      else if (method === 8 && typeof DecompressionStream !== 'undefined') {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        xml = await new Response(stream).text();
      } else return null;
      const m = /<Pages>\s*(\d+)\s*<\/Pages>/.exec(xml);
      const pages = m ? Number(m[1]) : 0;
      return pages > 0 && pages < 1000 ? pages : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function finishDocx(html: DocxHtml, pages = 0): ExtractResult {
  const { blocks, text, images } = htmlToBlocks(html.html);
  const warnings: string[] = [];
  if (images > 0) {
    warnings.push(`${images} picture${images > 1 ? 's' : ''} in the Word file (logo, stamp or signature image) ${images > 1 ? 'were' : 'was'} not copied.`);
  }
  const repeated: string[] = [];
  const doc = finalizeBlocks(refineBlocks(blocks, repeated));
  return {
    doc,
    sourceText: subtractTokens(text, repeated.join(' ')),
    removed: repeated,
    warnings,
    method: 'docx',
    pages,
  };
}
