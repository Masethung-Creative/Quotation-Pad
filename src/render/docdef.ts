import type { Content, ContentText, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { Align, Block, CanonicalDoc, Run, SignatureBlock, TableBlock } from '@/schema/canonical';
import { blockText, normaliseTable } from '@/schema/canonical';
import { looksNumeric } from '@/lib/format';
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

/** Rough text width in points - only used to choose sensible column widths. */
function estimateWidth(text: string, fontSize: number): number {
  let longest = 0;
  for (const line of text.split('\n')) longest = Math.max(longest, line.length);
  return longest * fontSize * 0.52;
}

function tableWidths(table: TableBlock, available: number, fontSize: number): (number | 'auto' | '*')[] {
  const n = table.columns.length;
  if (table.col_width && table.col_width.length === n && n > 1) {
    // Column widths measured from the source: keep its proportions, but never squeeze a
    // column below its longest word (or a whole amount).
    const inner = available - n * 9;
    const sum = table.col_width.reduce((a, b) => a + b, 0) || 1;
    const longestWord = (text: string) => Math.max(0, ...text.split(/\s+/).map((w) => w.length));
    const min = table.columns.map((header, c) => {
      let chars = longestWord(header);
      for (const row of table.rows) chars = Math.max(chars, looksNumeric(row[c] ?? '') ? (row[c] ?? '').trim().length : longestWord(row[c] ?? ''));
      return chars * fontSize * 0.58 + 2;
    });
    const widths = table.col_width.map((w, c) => Math.max((w / sum) * inner, min[c]));
    // Give back what the minimums took, from the columns that have room to spare.
    let excess = widths.reduce((a, b) => a + b, 0) - inner;
    while (excess > 0.5) {
      const spare = widths.map((w, c) => Math.max(0, w - min[c]));
      const total = spare.reduce((a, b) => a + b, 0);
      if (total <= 0.5) break;
      const take = Math.min(excess, total);
      widths.forEach((w, c) => (widths[c] = w - (spare[c] / total) * take));
      excess -= take;
    }
    if (excess <= 0.5) return widths;
  }
  const desired = table.columns.map((header, c) => {
    let w = estimateWidth(header, fontSize);
    for (const row of table.rows) w = Math.max(w, estimateWidth(row[c] ?? '', fontSize));
    return w + 10;
  });
  const narrowLimit = available * (n <= 4 ? 0.3 : 0.22);
  const widths: (number | 'auto' | '*')[] = desired.map((w) => (w <= narrowLimit ? 'auto' : '*'));
  if (!widths.includes('*')) {
    // Nothing is wide: let the widest column stretch so the table fills the line.
    const widest = desired.indexOf(Math.max(...desired));
    widths[widest] = '*';
  }
  return widths;
}

interface Ctx {
  fonts: FontUse;
  body: string;
  f: number;
  available: number;
  def: TemplateDef;
  accent: string;
}

function tableContent(input: TableBlock, ctx: Ctx): Content {
  const table = normaliseTable(input);
  const n = table.columns.length;
  const size = n >= 8 ? ctx.f * 0.85 : n >= 6 ? ctx.f * 0.92 : ctx.f;
  const hasHeader = table.columns.some((c) => c.trim() !== '');
  const body: TableCell[][] = [];
  if (hasHeader) {
    body.push(
      table.columns.map((c, i) => ({
        text: styled(c, { bold: true }, ctx.fonts, ctx.body),
        alignment: pdfAlign(table.col_align[i]),
        fillColor: '#eef0f3',
      })),
    );
  }
  for (const row of table.rows) {
    body.push(row.map((cell, i) => ({ text: styled(cell, {}, ctx.fonts, ctx.body), alignment: pdfAlign(table.col_align[i]) })));
  }
  if (!body.length) return { text: '' };
  return {
    fontSize: size,
    margin: [0, 2, 0, 6],
    table: {
      headerRows: hasHeader ? 1 : 0,
      // Never split a row across pages; never leave the header alone at a page bottom.
      dontBreakRows: true,
      keepWithHeaderRows: hasHeader ? 1 : 0,
      widths: tableWidths(table, ctx.available, size),
      body,
    },
    layout: {
      hLineWidth: () => 0.6,
      vLineWidth: () => 0.6,
      hLineColor: () => '#4b5563',
      vLineColor: () => '#4b5563',
      paddingLeft: () => 4,
      paddingRight: () => 4,
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
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
  return { stack, alignment: pdfAlign(block.align ?? ctx.def.signature.align), margin: [0, 12, 0, 0], unbreakable: true };
}

function blockContent(block: Block, ctx: Ctx): Content | null {
  const { f } = ctx;
  switch (block.type) {
    case 'heading': {
      const scale = block.level === 1 ? 1.5 : block.level === 2 ? 1.25 : 1.1;
      return {
        text: styled(block.text, { bold: true }, ctx.fonts, ctx.body),
        fontSize: f * scale,
        alignment: pdfAlign(block.align),
        margin: [0, block.level === 1 ? 2 : 4, 0, block.level === 1 ? 8 : 4],
      };
    }
    case 'meta': {
      const cell = (item: { label: string; value: string }, alignment: 'left' | 'right'): ContentText => ({
        text: [...styled(`${item.label}: `, { bold: true }, ctx.fonts, ctx.body), ...styled(item.value, {}, ctx.fonts, ctx.body)],
        alignment,
      });
      const rows: Content[] = [];
      for (let i = 0; i < block.items.length; i += 2) {
        const left = block.items[i];
        const right = block.items[i + 1];
        // Two details share a line: the first on the left, the second on the right (Ref No ... Date).
        rows.push(right ? { columns: [{ ...cell(left, 'left'), width: '*' }, { ...cell(right, 'right'), width: 'auto' }], columnGap: 12 } : cell(left, 'left'));
      }
      return { stack: rows, margin: [0, 0, 0, 6] };
    }
    case 'paragraph':
      return {
        text: block.runs.flatMap((r: Run) => styled(r.text, { bold: r.bold, italics: r.italic, underline: r.underline }, ctx.fonts, ctx.body)),
        alignment: pdfAlign(block.align),
        preserveLeadingSpaces: true,
        margin: [0, 0, 0, 5],
      };
    case 'table':
      return tableContent(block, ctx);
    case 'totals': {
      const body: TableCell[][] = block.items.map((item) => [
        { text: '', border: [false, false, false, false] },
        { text: styled(item.label, { bold: item.bold }, ctx.fonts, ctx.body), alignment: 'right', border: [false, !!item.bold, false, false] },
        { text: styled(item.value, { bold: item.bold }, ctx.fonts, ctx.body), alignment: 'right', border: [false, !!item.bold, false, false] },
      ]);
      const stack: Content[] = [];
      if (body.length) {
        stack.push({
          table: { widths: ['*', 'auto', 'auto'], body },
          layout: {
            hLineWidth: () => 0.6,
            vLineWidth: () => 0,
            hLineColor: () => '#4b5563',
            paddingLeft: () => 8,
            paddingRight: () => 4,
            paddingTop: () => 2,
            paddingBottom: () => 2,
          },
        });
      }
      if (block.amount_in_words?.trim()) {
        stack.push({ text: styled(block.amount_in_words.trim(), { bold: true }, ctx.fonts, ctx.body), margin: [0, 5, 0, 0] });
      }
      return { stack, margin: [0, 0, 0, 8] };
    }
    case 'list': {
      const items = block.items.map((item) => ({ text: styled(item, {}, ctx.fonts, ctx.body) }));
      return block.ordered ? { ol: items, margin: [0, 0, 0, 6] } : { ul: items, margin: [0, 0, 0, 6] };
    }
    case 'signature':
      return signatureContent(block, ctx);
    case 'spacer':
      return { text: '', margin: [0, mm(Math.max(0, block.mm)), 0, 0] };
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
  const margins: [number, number, number, number] = [
    mm(Math.max(first.left, next.left)),
    mm(next.top),
    mm(Math.max(first.right, next.right)),
    mm(Math.max(first.bottom, next.bottom)),
  ];
  const available = pageW - margins[0] - margins[2];
  const ctx: Ctx = { fonts, body: def.fonts.body, f: def.fonts.size_pt, available, def, accent: resolveColour('primary', def, '#1d3a6b') };

  const content: Content[] = [];
  const firstPageExtra = mm(Math.max(0, first.top - next.top));
  if (firstPageExtra > 0) content.push({ text: '', margin: [0, firstPageExtra, 0, 0] });

  const own = ownLetterheadBlocks(doc.blocks, def);
  const blocks = doc.blocks.filter((_, i) => !own.has(i));
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
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
          const stack = group.map((b) => blockContent(b, ctx)).filter((c): c is Content => c !== null);
          content.push({ stack, unbreakable: true });
          i = end;
          continue;
        }
      }
    }
    const c = blockContent(block, ctx);
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
    defaultStyle: { font: def.fonts.body, fontSize: def.fonts.size_pt, lineHeight: 1.2, color: '#111111' },
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
        const align = (doc.blocks.find((b) => b.type === 'signature') as SignatureBlock | undefined)?.align ?? def.signature.align;
        const x = align === 'left' ? contentLeft : align === 'center' ? (contentLeft + contentRight - w) / 2 : contentRight - w;
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
