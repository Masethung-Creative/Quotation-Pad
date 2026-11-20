import type { Content, ContentText, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { Align, Block, CanonicalDoc, Run, SignatureBlock, TableBlock, TotalsBlock } from '@/schema/canonical';
import { blockText, normaliseTable } from '@/schema/canonical';
import { amountColumn, amountWidth, BODY, columnAligns, columnKinds, columnWidths, isPartyBox, labelCase, splitCompanyName, splitPairs, tint, TO_LABEL_RE, totalsAmountWidth } from './body';
import { tokenize } from '@/validate/coverage';
import { designFor, fillPlaceholders, PAGE_MM, resolveColour, type SafeArea, type TemplateDef, type TemplateElement } from '@/templates/schema';
import type { PageMasks } from '@/templates/marker';
import { BUILTIN_ASCENDER, BUILTIN_FONTS, readAscender, type FontFiles } from './fonts';

/**
 * Canonical JSON + company template -> pdfmake document definition.
 * The template's header and footer are drawn as vector layers behind every page
 * (page 1 design, then the continuation design from page 2). Content stays inside the
 * template's safe areas, so it can never run into the header or footer.
 */

export const mm = (value: number): number => (value * 72) / 25.4;
export const toMm = (pt: number): number => (pt * 25.4) / 72;

/** Page size in PDF points. */
export const PAGE_PT: Record<'A4', [number, number]> = { A4: [mm(PAGE_MM.A4[0]), mm(PAGE_MM.A4[1])] };

/** Where the signature image goes: page (1-based) and box in points, origin top-left. */
export interface SignatureSlot {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Area the signature may be moved within (the content safe area of that page). */
  bounds: { x: number; y: number; w: number; h: number };
}

/** A template plus the bytes of its files (logos, fonts, background PDFs). */
export interface TemplateInput {
  def: TemplateDef;
  files: Record<string, Uint8Array>;
  /** Placeholder text on the background PDF to cover with paper white (see templates/marker.ts). */
  masks?: PageMasks;
}

export interface FontSource {
  /** Name in pdfmake's virtual file system. */
  vfsName: string;
  /** A file in /public/fonts, or a file inside the template folder. */
  from: 'public' | 'template';
  file: string;
}

export interface FontPlan {
  families: Record<string, FontFiles>;
  sources: FontSource[];
}

export interface BuiltDocument {
  definition: TDocumentDefinitions;
  fontPlan: FontPlan;
  /** Filled in by pdfmake while it lays out the pages. */
  slot: { value: SignatureSlot | null };
  safeFirst: SafeArea;
  safeNext: SafeArea;
}

const SLOT_ID = 'qp-signature-slot';

const TAMIL_RE = /[\u{B80}-\u{BFF}]/u;
const DEVANAGARI_RE = /[\u{900}-\u{97F}\u{A8E0}-\u{A8FF}]/u;
// Splits text into runs of one script. Joiners stay with the Indic run they belong to.
const SCRIPT_SPLIT_RE = /([\u{B80}-\u{BFF}][\u{B80}-\u{BFF}\u{200C}\u{200D}]*|[\u{900}-\u{97F}\u{A8E0}-\u{A8FF}][\u{900}-\u{97F}\u{A8E0}-\u{A8FF}\u{200C}\u{200D}]*)/u;

type StyleKey = keyof FontFiles;

class FontUse {
  readonly used = new Map<string, Set<StyleKey>>();
  constructor(private families: Record<string, FontFiles>) {}
  mark(family: string, style: StyleKey): void {
    if (!this.families[family]) throw new Error(`Unknown font "${family}". Add it to the template's fonts.custom list.`);
    if (!this.used.has(family)) this.used.set(family, new Set());
    this.used.get(family)!.add(style);
  }
}

interface Style {
  bold?: boolean;
  italics?: boolean;
  underline?: boolean;
}

const styleKey = (s: Style): StyleKey => (s.bold ? (s.italics ? 'bolditalics' : 'bold') : s.italics ? 'italics' : 'normal');

/** Text with the right embedded font for each script (Latin, Tamil, Devanagari). */
function styled(text: string, style: Style, fonts: FontUse, base: string): ContentText[] {
  const out: ContentText[] = [];
  for (const part of text.split(SCRIPT_SPLIT_RE)) {
    if (!part) continue;
    const node: ContentText = { text: part };
    let family = base;
    if (TAMIL_RE.test(part)) family = 'NotoSansTamil';
    else if (DEVANAGARI_RE.test(part)) family = 'NotoSansDevanagari';
    if (family !== base) node.font = family;
    fonts.mark(family, styleKey(style));
    if (style.bold) node.bold = true;
    if (style.italics) node.italics = true;
    if (style.underline) node.decoration = 'underline';
    out.push(node);
  }
  return out;
}

const pdfAlign = (a: Align | undefined): 'left' | 'center' | 'right' | 'justify' => a ?? 'left';

interface Ctx {
  fonts: FontUse;
  body: string;
  f: number;
  available: number;
  def: TemplateDef;
  accent: string;
  /** Light company colour for table headings and the grand total. */
  shade: string;
  /** Size of table / totals text. */
  tf: number;
  /** Width of the amount column shared by every table and the totals (text width). */
  amountW: number;
  /** Spacing factor of the current density (1 = normal). */
  sp: number;
  padX: number;
  padY: number;
  /** Space after a block (pt). */
  gap: number;
  grid: ReturnType<typeof gridLayoutFor>;
  /** The document title (first heading), so the details box does not repeat it. */
  title: string;
}

/**
 * Tables and totals that follow each other form one framed box: each part is pulled up by
 * one line width so its top border lies exactly on the previous part's bottom border.
 */
export interface BoxJoin {
  /** Joined to the part above. */
  top: boolean;
  /** Another part follows below. */
  more: boolean;
}

const NO_JOIN: BoxJoin = { top: false, more: false };
const boxMargin = (join: BoxJoin, ctx: Ctx): [number, number, number, number] => [0, join.top ? -BODY.line : 0, 0, join.more ? 0 : ctx.gap];

/**
 * An empty code column ("SAC Code" with nothing under it) is folded into the heading of the
 * column before it - "Category of Service (SAC Code)" - instead of printing an empty column.
 */
export function foldEmptyCodeColumns(table: TableBlock): TableBlock {
  const kinds = columnKinds(table);
  let t = table;
  for (let c = t.columns.length - 1; c >= 1; c--) {
    const empty = t.rows.every((r) => !(r[c] ?? '').trim());
    const header = t.columns[c].trim();
    if (!empty || !header || kinds[c] !== 'short' || !t.columns[c - 1].trim() || t.columns.length <= 2) continue;
    const drop = <T,>(arr: T[]) => [...arr.slice(0, c), ...arr.slice(c + 1)];
    t = {
      ...t,
      columns: drop(t.columns).map((h, i) => (i === c - 1 ? `${h}\n(${header})` : h)),
      col_align: drop(t.col_align),
      rows: t.rows.map(drop),
      col_width: t.col_width ? drop(t.col_width) : undefined,
    };
  }
  return t;
}

/**
 * How tightly the body is set. Level 0 is the normal, airy layout. When the result runs to
 * more pages than the original quotation, the renderer tries the next levels (less space
 * first, then slightly smaller text, never below about 8 pt) until it fits.
 */
export const DENSITIES = [
  { font: 1, space: 1, pad: 1 },
  { font: 1, space: 0.6, pad: 0.75 },
  { font: 0.94, space: 0.45, pad: 0.6 },
  { font: 0.88, space: 0.3, pad: 0.45 },
  { font: 0.82, space: 0.2, pad: 0.35 },
] as const;

function gridLayoutFor(padX: number, padY: number) {
  return {
    hLineWidth: () => BODY.line,
    vLineWidth: () => BODY.line,
    hLineColor: () => BODY.border,
    vLineColor: () => BODY.border,
    paddingLeft: () => padX,
    paddingRight: () => padX,
    paddingTop: () => padY,
    paddingBottom: () => padY,
  };
}

/** Room for cell text once padding and lines are taken off. */
const innerWidth = (available: number, n: number, padX: number = BODY.padX) => available - n * 2 * padX - (n + 1) * BODY.line;

function tableContent(input: TableBlock, ctx: Ctx, join: BoxJoin = NO_JOIN): Content {
  const normal = normaliseTable(input);
  if (isPartyBox(normal)) return partyBox(normal, ctx, join);
  const table = foldEmptyCodeColumns(normal);
  const n = table.columns.length;
  const size = n >= 8 ? ctx.tf * 0.88 : n >= 6 ? ctx.tf * 0.94 : ctx.tf;
  const hasHeader = table.columns.some((c) => c.trim() !== '');
  const aligns = columnAligns(table);
  const body: TableCell[][] = [];
  if (hasHeader) {
    body.push(
      table.columns.map((c, i) => ({
        text: styled(c, { bold: true }, ctx.fonts, ctx.body),
        alignment: pdfAlign(aligns[i]),
        fillColor: ctx.shade,
        verticalAlignment: 'middle',
      })),
    );
  }
  for (const row of table.rows) {
    body.push(row.map((cell, i) => ({ text: styled(cell, {}, ctx.fonts, ctx.body), alignment: pdfAlign(aligns[i]), verticalAlignment: 'middle' })) as TableCell[]);
  }
  if (!body.length) return { text: '' };
  const shared = amountColumn(table) >= 0 ? ctx.amountW * (size / ctx.tf) : 0;
  return {
    fontSize: size,
    lineHeight: ctx.sp < 1 ? 1.1 : 1.15,
    margin: boxMargin(join, ctx),
    table: {
      headerRows: hasHeader ? 1 : 0,
      // Never split a row across pages; never leave the header alone at a page bottom.
      dontBreakRows: true,
      keepWithHeaderRows: hasHeader ? 1 : 0,
      widths: columnWidths(table, innerWidth(ctx.available, n, ctx.padX), size, shared),
      body,
    },
    layout: ctx.grid,
  };
}

/** Label : value rows inside the details box: no lines, tight rows. */
const pairLayout = {
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingLeft: (i: number) => (i === 0 ? 0 : 3),
  paddingRight: () => 0,
  paddingTop: () => 1,
  paddingBottom: () => 1,
};

/** Customer address | document details, side by side in one framed box. */
function partyBox(table: TableBlock, ctx: Ctx, join: BoxJoin = NO_JOIN): Content {
  const size = ctx.tf;
  const grey = (text: string, extra: Partial<ContentText> = {}): ContentText => ({ text: styled(text, { bold: true }, ctx.fonts, ctx.body), color: BODY.muted, ...extra });

  const sideStack = (cell: string, customer: boolean): Content[] => {
    const lines = cell
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const out: Content[] = [];
    let nameDone = !customer;
    // Details as an aligned "Label : value" list; empty values are left out.
    const pairRows: { label: string; row: TableCell[] }[] = [];
    const flushPairs = () => {
      if (!pairRows.length) return;
      // The document's own number and date first, then the rest in their original order.
      const rank = (label: string) =>
        /\b(invoice|bill|quotation|quote|estimate|proforma)\b.*\b(no|number)\b/i.test(label) ? 0 : /\b(invoice|bill|quotation|quote|estimate|proforma)\b.*\bdate\b|^date$/i.test(label) ? 1 : 2;
      const rows = pairRows
        .splice(0)
        .map((r, i) => ({ ...r, i }))
        .sort((a, b) => rank(a.label) - rank(b.label) || a.i - b.i)
        .map((r) => r.row);
      out.push({ table: { widths: ['auto', 'auto', '*'], body: rows }, layout: pairLayout, margin: [0, 1, 0, 1] } as Content);
    };
    lines.forEach((line, i) => {
      if (customer && i === 0 && TO_LABEL_RE.test(line)) {
        out.push(grey(line.replace(/[\s,:.-]+$/, '').toUpperCase(), { fontSize: size * 0.82, characterSpacing: 0.4, margin: [0, 0, 0, 2] }));
        return;
      }
      const pairs = splitPairs(line);
      if (pairs && (!customer || nameDone)) {
        for (const p of pairs) {
          // "Type: INVOICE" when the title above the box already says it (INVOICE, TAX INVOICE).
          if (/^(document\s+)?type$/i.test(p.label.trim()) && ctx.title && ctx.title.toUpperCase().includes(p.value.trim().toUpperCase())) continue;
          pairRows.push({
            label: p.label,
            row: [{ ...grey(labelCase(p.label)) }, { text: ':', color: BODY.muted }, { text: p.value ? styled(p.value, {}, ctx.fonts, ctx.body) : [] }],
          });
        }
        return;
      }
      flushPairs();
      if (!nameDone) {
        nameDone = true;
        const [name, rest] = splitCompanyName(line);
        out.push({ text: styled(name, { bold: true }, ctx.fonts, ctx.body), fontSize: size * 1.05, margin: [0, 0, 0, 1.5] });
        if (rest) out.push({ text: styled(rest, {}, ctx.fonts, ctx.body) });
        return;
      }
      out.push({ text: styled(line, {}, ctx.fonts, ctx.body) });
    });
    flushPairs();
    // A details list padded with the cell layout: its own cells already have no padding.
    return out;
  };

  const [left, right] = table.rows[0];
  const leftIsCustomer = !(splitPairs(left.split('\n')[0] ?? '') && !TO_LABEL_RE.test(left.split('\n')[0] ?? ''));
  const cells: TableCell[] = [
    { stack: sideStack(left, leftIsCustomer), margin: [2, 2, 2, 2] },
    { stack: sideStack(right, false), margin: [2, 2, 2, 2] },
  ];
  const inner = innerWidth(ctx.available, 2, ctx.padX);
  const given = table.col_width && table.col_width.length === 2 ? table.col_width : [1, 1];
  const share = Math.min(0.62, Math.max(0.38, given[0] / (given[0] + given[1] || 1)));
  return {
    fontSize: size,
    lineHeight: ctx.sp < 1 ? 1.1 : 1.18,
    margin: boxMargin(join, ctx),
    table: { dontBreakRows: true, widths: [inner * share, inner * (1 - share)], body: [cells] },
    layout: ctx.grid,
  };
}

/** The signature lines as they print on this template: the template's own lines unless the user wrote custom ones. */
export function signatureLines(block: SignatureBlock, def: TemplateDef): string[] {
  if (!block.auto) return block.lines;
  const s = def.signature;
  return [fillPlaceholders(s.for_line, def), '', fillPlaceholders(s.name, def), fillPlaceholders(s.designation, def)].filter((line, i) => i === 1 || line.trim() !== '');
}

function signatureContent(block: SignatureBlock, ctx: Ctx): Content {
  const lines = signatureLines(block, ctx.def);
  const boxH = mm(ctx.def.signature.box_mm.h);
  let slotAt = lines.findIndex((l) => !l.trim());
  if (slotAt < 0) slotAt = Math.min(1, lines.length);
  const stack: Content[] = [];
  lines.forEach((line, i) => {
    if (i === slotAt && !line.trim()) return;
    if (line.trim()) stack.push({ text: styled(line, { bold: i === 0 }, ctx.fonts, ctx.body) });
    else stack.push({ text: ' ', fontSize: ctx.f, margin: [0, ctx.f * 0.6, 0, 0] });
  });
  // The room for the signature: a blank line whose position pdfmake reports back (see SLOT_ID).
  const lineH = 2;
  stack.splice(slotAt, 0, { text: ' ', id: SLOT_ID, fontSize: lineH, lineHeight: 1, margin: [0, 2, 0, Math.max(0, boxH - lineH)] });
  return { stack, alignment: pdfAlign(signatureAlign(block, ctx.def)), margin: [0, 14 * ctx.sp, 0, 0], unbreakable: true };
}

/** The template decides where its own signature block sits; a custom one keeps its place. */
export function signatureAlign(block: SignatureBlock | undefined, def: TemplateDef): Align {
  if (!block || block.auto) return def.signature.align;
  return block.align ?? def.signature.align;
}

/**
 * Totals as the closing rows of the box: the label spans the left part, the figure sits in
 * the Amount column (same width as every table's), the final total is shaded with ₹, and
 * the amount in words is the last full-width row.
 */
function totalsContent(block: TotalsBlock, ctx: Ctx, join: BoxJoin): Content {
  const size = ctx.tf;
  const last = block.items.length - 1;
  const body: TableCell[][] = block.items.map((item, i) => {
    const grand = i === last;
    const cell = (text: string): TableCell => ({
      text: styled(text, { bold: grand }, ctx.fonts, ctx.body),
      alignment: 'right',
      ...(grand ? { fillColor: ctx.shade } : {}),
    });
    return [cell(item.label), cell(grand ? `₹ ${item.value}` : item.value)];
  });
  // "(Rupees ... Only)" or "Amount in words: Rupees ... Only" -> "Rupees ... Only" (the label is printed once).
  const words = block.amount_in_words
    ?.trim()
    .replace(/^\(\s*/, '')
    .replace(/\s*\)\s*$/, '')
    .replace(/^(total\s+)?amount\s+(chargeable\s+)?in\s+words\s*[:\-–]?\s*/i, '')
    .trim();
  if (words) {
    body.push([
      { text: [{ text: 'Amount in words: ', color: BODY.muted, bold: true }, ...styled(words, { bold: true }, ctx.fonts, ctx.body)], colSpan: 2 },
      {},
    ]);
  }
  if (!body.length) return { text: '' };
  return {
    fontSize: size,
    lineHeight: ctx.sp < 1 ? 1.1 : 1.15,
    margin: boxMargin(join, ctx),
    table: { dontBreakRows: true, widths: ['*', Math.max(ctx.amountW, totalsAmountWidth(block, size))], body },
    layout: ctx.grid,
  };
}

function blockContent(block: Block, ctx: Ctx, join: BoxJoin = NO_JOIN): Content | null {
  const { f } = ctx;
  switch (block.type) {
    case 'heading': {
      const scale = block.level === 1 ? 1.5 : block.level === 2 ? 1.25 : 1.1;
      return {
        text: styled(block.text, { bold: block.bold !== false }, ctx.fonts, ctx.body),
        fontSize: f * scale,
        alignment: pdfAlign(block.align),
        margin: [0, (block.level === 1 ? 2 : 4) * ctx.sp, 0, (block.level === 1 ? 8 : 4) * ctx.sp],
      };
    }
    case 'meta': {
      const cell = (item: { label: string; value: string }, alignment: 'left' | 'right'): ContentText => ({
        text: [...styled(`${item.label}: `, { bold: true }, ctx.fonts, ctx.body), ...styled(item.value, {}, ctx.fonts, ctx.body)],
        alignment,
      });
      // Group items by their original line: items on the same line stay together.
      const hasBreaks = block.items.some((item) => item.break);
      const groups: { label: string; value: string }[][] = [];
      if (hasBreaks) {
        for (const item of block.items) {
          if (item.break || !groups.length) groups.push([]);
          groups[groups.length - 1].push(item);
        }
      } else {
        // No line info (old data or single-line block): pair items two at a time.
        for (let i = 0; i < block.items.length; i += 2) {
          const pair = [block.items[i]];
          if (block.items[i + 1]) pair.push(block.items[i + 1]);
          groups.push(pair);
        }
      }
      const rows: Content[] = [];
      for (const group of groups) {
        if (group.length === 1) {
          rows.push(cell(group[0], 'left'));
        } else if (group.length === 2) {
          rows.push({ columns: [{ ...cell(group[0], 'left'), width: '*' }, { ...cell(group[1], 'right'), width: 'auto' }], columnGap: 12 });
        } else {
          const cols = group.map((item, i) => ({ ...cell(item, i === 0 ? 'left' : 'right'), width: i === 0 ? ('*' as const) : ('auto' as const) }));
          rows.push({ columns: cols, columnGap: 12 });
        }
      }
      return { stack: rows, margin: [0, 0, 0, 6 * ctx.sp] };
    }
    case 'paragraph':
      return {
        text: block.runs.flatMap((r: Run) => styled(r.text, { bold: r.bold, italics: r.italic, underline: r.underline }, ctx.fonts, ctx.body)),
        alignment: pdfAlign(block.align),
        preserveLeadingSpaces: true,
        margin: [0, 0, 0, 5 * ctx.sp],
      };
    case 'table':
      return tableContent(block, ctx, join);
    case 'totals':
      return totalsContent(block, ctx, join);
    case 'list': {
      const items = block.items.map((item) => ({ text: styled(item, {}, ctx.fonts, ctx.body) }));
      return block.ordered ? { ol: items, margin: [0, 0, 0, 6 * ctx.sp] } : { ul: items, margin: [0, 0, 0, 6 * ctx.sp] };
    }
    case 'signature':
      return signatureContent(block, ctx);
    case 'spacer':
      return { text: '', margin: [0, mm(Math.max(0, block.mm)) * ctx.sp, 0, 0] };
  }
}

/** Rough line count, to decide whether totals + signature are small enough to pin together. */
function estimateLines(block: Block): number {
  switch (block.type) {
    case 'totals':
      return block.items.length + (block.amount_in_words ? 2 : 0) + 1;
    case 'signature':
      return 7;
    case 'table':
      return (block.rows.length + 1) * 1.6;
    case 'spacer':
      return block.mm / 4;
    case 'list':
      return block.items.reduce((n, it) => n + 1 + Math.floor(it.length / 85), 0);
    default:
      return blockText(block)
        .split('\n')
        .reduce((n, line) => n + 1 + Math.floor(line.length / 85), 0);
  }
}

function familiesFor(def: TemplateDef): Record<string, FontFiles> {
  const families: Record<string, FontFiles> = { ...BUILTIN_FONTS };
  for (const custom of def.fonts.custom) {
    const tpl = (file: string | undefined) => `tpl/${def.id}/${file ?? custom.normal}`;
    families[custom.family] = {
      normal: tpl(custom.normal),
      bold: tpl(custom.bold),
      italics: tpl(custom.italics),
      bolditalics: tpl(custom.bolditalics ?? custom.bold),
    };
  }
  return families;
}

const base64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** One template element -> one absolutely positioned pdfmake node (keeps the drawing order). */
function elementContent(el: TemplateElement, tpl: TemplateInput, fonts: FontUse, families: Record<string, FontFiles>, images: Record<string, string>): Content | null {
  const { def } = tpl;
  const [pageW] = PAGE_PT.A4;
  const colour = (c: string | undefined, fallback?: string) => (c ? resolveColour(c, def) : fallback);
  const vector = (shape: Record<string, unknown>): Content => ({ canvas: [shape as never], absolutePosition: { x: 0, y: 0 } }) as Content;
  const strokeProps = (stroke?: string, width?: number) => (stroke ? { lineColor: colour(stroke), lineWidth: mm(width ?? 0.3) } : {});

  switch (el.type) {
    case 'rect':
      if (!el.fill && !el.stroke) return null;
      return vector({ type: 'rect', x: mm(el.x), y: mm(el.y), w: mm(el.w), h: mm(el.h), r: el.radius ? mm(el.radius) : undefined, color: colour(el.fill), ...strokeProps(el.stroke, el.stroke_width) });
    case 'ellipse':
      if (!el.fill && !el.stroke) return null;
      return vector({ type: 'ellipse', x: mm(el.cx), y: mm(el.cy), r1: mm(el.rx), r2: mm(el.ry), color: colour(el.fill), ...strokeProps(el.stroke, el.stroke_width) });
    case 'polygon':
      if (!el.fill && !el.stroke) return null;
      return vector({ type: 'polyline', points: el.points.map(([x, y]) => ({ x: mm(x), y: mm(y) })), closePath: el.closed, color: colour(el.fill), ...strokeProps(el.stroke, el.stroke_width) });
    case 'line':
      return vector({
        type: 'line',
        x1: mm(el.x1),
        y1: mm(el.y1),
        x2: mm(el.x2),
        y2: mm(el.y2),
        lineWidth: mm(el.width),
        lineColor: colour(el.colour, '#111111'),
        dash: el.dash ? { length: mm(el.dash[0]), space: mm(el.dash[1]) } : undefined,
      });
    case 'image': {
      const bytes = tpl.files[el.src];
      if (!bytes) throw new Error(`Template ${def.id}: ${el.src} was not loaded.`);
      const box = { width: mm(el.w), height: mm(el.h), absolutePosition: { x: mm(el.x), y: mm(el.y) } };
      if (/\.svg$/i.test(el.src)) return { svg: new TextDecoder().decode(bytes), ...box } as Content;
      const key = `tpl-${def.id}-${el.src}`;
      images[key] = `data:image/${/\.png$/i.test(el.src) ? 'png' : 'jpeg'};base64,${base64(bytes)}`;
      return { image: key, ...box } as Content;
    }
    case 'text': {
      const text = fillPlaceholders(el.text, def);
      if (!text.trim()) return null;
      const family = el.font ?? def.fonts.body;
      const style: Style = { bold: el.bold, italics: el.italic };
      const runs = styled(text, style, fonts, family);
      // Baseline placement: pdfmake puts the baseline one ascender below the top of the line.
      const files = new Set(runs.map((r) => families[(r.font as string | undefined) ?? family][styleKey(style)]));
      const ascender = Math.max(...[...files].map((file) => ascenderOf(file, tpl)));
      const top = mm(el.y) - (ascender / 1000) * el.size;
      const x = mm(el.x);
      let left = x;
      let width = pageW - x;
      if (el.align === 'right') {
        left = 0;
        width = x;
      } else if (el.align === 'center') {
        const half = Math.min(x, pageW - x);
        left = x - half;
        width = half * 2;
      }
      return {
        absolutePosition: { x: left, y: top },
        columns: [
          {
            width,
            text: runs,
            font: family,
            fontSize: el.size,
            color: colour(el.colour, '#111111'),
            alignment: el.align,
            characterSpacing: el.letter_spacing,
            // fontkit applies kerning and ligatures unless told not to; most letterheads have neither.
            fontFeatures: (el.kerning ?? def.fonts.kerning) ? undefined : { kern: false, liga: false },
            lineHeight: 1,
            noWrap: true,
          },
        ],
      } as Content;
    }
  }
}

function ascenderOf(file: string, tpl: TemplateInput): number {
  const known = BUILTIN_ASCENDER[file];
  if (known !== undefined) return known;
  if (file.startsWith('tpl/')) {
    const bytes = tpl.files[file.split('/').slice(2).join('/')];
    if (bytes) return readAscender(bytes);
  }
  // Script fonts (Tamil / Devanagari) and anything unknown: Noto's metrics.
  return file.includes('Tamil') ? 870 : file.includes('Devanagari') ? 896 : 1069;
}

export interface BuildOptions {
  title?: string;
  /** Index into DENSITIES (0 = normal). */
  density?: number;
}

export function buildDocDefinition(doc: CanonicalDoc, tpl: TemplateInput, options: BuildOptions = {}): BuiltDocument {
  const { def } = tpl;
  const families = familiesFor(def);
  const fonts = new FontUse(families);
  const images: Record<string, string> = {};
  const [pageW, pageH] = PAGE_PT.A4;
  const first = def.first_page.safe_area_mm;
  const next = (def.continuation ?? def.first_page).safe_area_mm;

  // pageMargins = continuation safe area. Page 1 gets a spacer for its taller header.
  const density = DENSITIES[Math.max(0, Math.min(DENSITIES.length - 1, options.density ?? 0))];
  const margins: [number, number, number, number] = [
    mm(Math.max(first.left, next.left)),
    mm(next.top + BODY.topGapMm * density.space),
    mm(Math.max(first.right, next.right)),
    mm(Math.max(first.bottom, next.bottom)),
  ];
  const available = pageW - margins[0] - margins[2];
  const accent = resolveColour('primary', def, '#1d3a6b');
  const f = def.fonts.size_pt * density.font;
  const tf = Math.min(def.fonts.size_pt, BODY.tableFont) * density.font;
  // One width for the amount column of every table and the totals, so all amounts line up.
  const amountW = Math.max(
    0,
    ...doc.blocks.map((b) => (b.type === 'table' && !isPartyBox(normaliseTable(b)) ? amountWidth(normaliseTable(b), tf) : b.type === 'totals' ? totalsAmountWidth(b, tf) : 0)),
  );
  const padX = BODY.padX * Math.max(0.6, density.pad);
  const padY = BODY.padY * density.pad;
  const ctx: Ctx = {
    fonts,
    body: def.fonts.body,
    f,
    available,
    def,
    accent,
    shade: tint(accent, 0.88),
    tf,
    amountW,
    sp: density.space,
    padX,
    padY,
    gap: BODY.blockGap * density.space,
    grid: gridLayoutFor(padX, padY),
    title: '',
  };

  const content: Content[] = [];
  const firstPageExtra = mm(Math.max(0, first.top - next.top));
  if (firstPageExtra > 0) content.push({ text: '', margin: [0, firstPageExtra, 0, 0] });

  const own = ownLetterheadBlocks(doc.blocks, def);
  const boxed = (b: Block | undefined) => b?.type === 'table' || b?.type === 'totals';
  const kept = doc.blocks.filter((_, i) => !own.has(i));
  // A space between two parts of the box would split it: drop it.
  const blocks = kept.filter((b, i) => {
    if (b.type !== 'spacer') return true;
    let p = i - 1;
    while (p >= 0 && kept[p].type === 'spacer') p--;
    let n = i + 1;
    while (n < kept.length && kept[n].type === 'spacer') n++;
    return !(boxed(kept[p]) && boxed(kept[n]));
  });
  // Tables and totals that follow each other print as one joined box.
  const joinAt = (i: number): BoxJoin => (boxed(blocks[i]) ? { top: boxed(blocks[i - 1]), more: boxed(blocks[i + 1]) } : NO_JOIN);
  const title = blocks.find((b) => b.type === 'heading');
  ctx.title = title?.type === 'heading' ? title.text : '';

  // Tight layouts: the terms (text just before the signature) and the signature side by
  // side, as many printed quotations do, instead of the signature alone on a new page.
  const sigAt = blocks.findIndex((b) => b.type === 'signature');
  let tailFrom = -1;
  if (density.space <= 0.45 && sigAt > 0) {
    let k = sigAt - 1;
    while (k >= 0 && blocks[k].type === 'spacer') k--;
    let from = sigAt;
    for (let n = 0; k >= 0 && n < 4 && (blocks[k].type === 'paragraph' || blocks[k].type === 'list' || blocks[k].type === 'spacer'); k--, n++) from = k;
    if (from < sigAt && blocks.slice(from, sigAt).some((b) => b.type !== 'spacer')) tailFrom = from;
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (i === tailFrom) {
      const left = blocks
        .slice(tailFrom, sigAt)
        .filter((b) => b.type !== 'spacer')
        .map((b) => blockContent(b, ctx))
        .filter((c): c is Content => c !== null);
      const sig = blockContent(blocks[sigAt], ctx) as Content & { margin?: number[] };
      sig.margin = [0, 0, 0, 0];
      content.push({ columns: [{ stack: left, width: '*' }, { stack: [sig], width: mm(def.signature.box_mm.w) + 60 }], columnGap: 12, unbreakable: true, margin: [0, 4 * ctx.sp, 0, 0] } as Content);
      i = sigAt;
      continue;
    }
    // Keep totals + signature together on one page when the group is small enough.
    if (block.type === 'totals') {
      let end = -1;
      for (let j = i + 1; j < blocks.length && j <= i + 3; j++) {
        if (blocks[j].type === 'table') break;
        if (blocks[j].type === 'signature') {
          end = j;
          break;
        }
      }
      if (end > 0) {
        const group = blocks.slice(i, end + 1);
        // Only when the signature follows closely; pinning a long tail together would
        // push everything to the next page and leave this one half empty.
        if (group.reduce((n, b) => n + estimateLines(b), 0) <= 20) {
          const stack = group.map((b, k) => blockContent(b, ctx, joinAt(i + k))).filter((c): c is Content => c !== null);
          content.push({ stack, unbreakable: true });
          i = end;
          continue;
        }
      }
    }
    const c = blockContent(block, ctx, joinAt(i));
    if (!c) continue;
    content.push(block.type === 'totals' ? { stack: [c], unbreakable: true } : c);
  }

  // Template header / footer, drawn behind the content of every page.
  const layer = (page: number): Content[] => {
    const design = designFor(def, page);
    return [...design.header, ...design.footer].map((el) => elementContent(el, tpl, fonts, families, images)).filter((c): c is Content => c !== null);
  };
  const firstLayer = layer(1);
  const nextLayer = def.continuation ? layer(2) : firstLayer;

  const slot: BuiltDocument['slot'] = { value: null };
  const box = def.signature.box_mm;
  fonts.mark(def.fonts.body, 'normal');
  fonts.mark(def.fonts.body, 'bold');

  const definition: TDocumentDefinitions = {
    pageSize: { width: pageW, height: pageH },
    pageMargins: margins,
    content,
    background: (page: number) => (page === 1 ? firstLayer : nextLayer),
    images,
    defaultStyle: { font: def.fonts.body, fontSize: f, lineHeight: density.space < 1 ? 1.12 : 1.2, color: '#111111' },
    info: { title: options.title ?? 'Quotation', creator: 'Quotation Pad', producer: 'Quotation Pad' },
    compress: true,
    // Never breaks a page; only records where the signature slot ended up.
    pageBreakBefore: (node) => {
      const info = node as unknown as { id?: string; startPosition?: { pageNumber: number; left: number; top: number } };
      if (info.id === SLOT_ID && info.startPosition) {
        const page = info.startPosition.pageNumber;
        const safe = page === 1 ? first : next;
        const w = mm(box.w);
        const h = mm(box.h);
        const contentLeft = margins[0];
        const contentRight = pageW - margins[2];
        const align = signatureAlign(doc.blocks.find((b) => b.type === 'signature') as SignatureBlock | undefined, def);
        // Side by side with the terms, the signature sits in a right-hand column.
        const colLeft = tailFrom >= 0 ? contentRight - (w + 60) : contentLeft;
        const x = align === 'left' ? colLeft : align === 'center' ? (colLeft + contentRight - w) / 2 : contentRight - w;
        const top = mm(safe.top);
        const bottom = pageH - mm(safe.bottom);
        slot.value = {
          page,
          x,
          y: info.startPosition.top,
          w,
          h,
          bounds: { x: contentLeft, y: top, w: contentRight - contentLeft, h: bottom - top },
        };
      }
      return false;
    },
  };

  // Only the font files that are really used get downloaded and embedded.
  const sources = new Map<string, FontSource>();
  const usedFamilies: Record<string, FontFiles> = {};
  for (const [family, styles] of fonts.used) {
    const files = families[family];
    const pick = (key: StyleKey): string => (styles.has(key) ? files[key] : files.normal);
    usedFamilies[family] = { normal: files.normal, bold: pick('bold'), italics: pick('italics'), bolditalics: pick('bolditalics') };
    for (const file of Object.values(usedFamilies[family])) {
      if (file.startsWith('tpl/')) sources.set(file, { vfsName: file, from: 'template', file: file.split('/').slice(2).join('/') });
      else sources.set(file, { vfsName: file, from: 'public', file });
    }
  }
  return { definition, fontPlan: { families: usedFamilies, sources: [...sources.values()] }, slot, safeFirst: first, safeNext: next };
}

/** The document exactly as it will print on a template (signature block filled in from the template). */
export function resolveForTemplate(doc: CanonicalDoc, def: TemplateDef): CanonicalDoc {
  const own = ownLetterheadBlocks(doc.blocks, def);
  return {
    ...doc,
    blocks: doc.blocks
      .filter((_, i) => !own.has(i))
      .map((b) => (b.type === 'signature' && b.auto ? { ...b, lines: signatureLines(b, def), auto: false } : b)),
  };
}

/**
 * The company's own name / address / phone / e-mail typed at the very top or bottom of the
 * source file (its old letterhead). The template prints them already, so they are not
 * printed a second time. Only text made almost entirely of the template's own details counts.
 */
export function ownLetterheadBlocks(blocks: Block[], def: TemplateDef): Set<number> {
  const c = def.company as Record<string, string | undefined>;
  const identity = new Set(tokenize([c.name, c.address, c.gstin, c.phone, c.email, c.website].filter(Boolean).join(' ')));
  const out = new Set<number>();
  if (identity.size < 3) return out;
  const isOwn = (b: Block) => {
    if (b.type !== 'paragraph' && b.type !== 'heading') return false;
    const tokens = tokenize(blockText(b));
    if (!tokens.length) return false;
    const hits = tokens.filter((t) => identity.has(t)).length;
    // "Cell No 96776..." / "Email: ..." : allow a couple of label words.
    return hits >= 2 && hits >= tokens.length * 0.7;
  };
  const scan = (indexes: number[]) => {
    const found: number[] = [];
    for (const i of indexes) {
      if (blocks[i].type === 'spacer') continue;
      if (!isOwn(blocks[i])) break;
      found.push(i);
    }
    // One stray line is not a letterhead; the company name plus at least one more detail is.
    if (found.length >= 2) {
      found.forEach((i) => out.add(i));
      // Spacers between them go too.
      for (let i = Math.min(...found); i <= Math.max(...found); i++) if (blocks[i].type === 'spacer') out.add(i);
    }
  };
  const all = blocks.map((_, i) => i);
  scan(all);
  scan([...all].reverse());
  return out;
}
