import type { Align, TableBlock, TotalsBlock } from '@/schema/canonical';
import { looksNumeric } from '@/lib/format';

/**
 * Pure layout decisions for the quotation body (no pdfmake here, so they are easy to test):
 * colours from the company's accent, column alignment and widths, the customer / details
 * box, and the shared width of the amount column.
 */

export const BODY = {
  /** Gap between the letterhead and the first line of the body, every page (mm). */
  topGapMm: 6,
  /** Space between body blocks (pt). */
  blockGap: 8,
  tableFont: 10,
  padX: 5,
  padY: 3.5,
  line: 0.6,
  border: '#9aa3b2',
  muted: '#5b6472',
  text: '#111111',
} as const;

/** Mixes a #rrggbb colour with white (amount 0 = colour, 1 = white). */
export function tint(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#eef0f3';
  const n = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const [r, g, b] = [mix(n >> 16), mix((n >> 8) & 255), mix(n & 255)];
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// ---------------------------------------------------------------------------------------
// Text width estimates (Noto Sans / Liberation Sans average advance widths)
// ---------------------------------------------------------------------------------------

export function textWidth(text: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of text) {
    if (/[0-9]/.test(ch)) w += 0.572;
    else if (/[.,:;' ]/.test(ch)) w += 0.27;
    else if (/[MWOQGDHNU]/.test(ch)) w += 0.76;
    else if (/[A-Z]/.test(ch)) w += 0.64;
    else if (/[a-z]/.test(ch)) w += 0.53;
    else w += 0.6;
  }
  // A little generous: a column that is too narrow breaks words, one too wide only looks airy.
  return w * size * (bold ? 1.12 : 1.05) + 2;
}

const longestWord = (text: string, size: number, bold = false) => Math.max(0, ...text.split(/\s+/).map((w) => textWidth(w, size, bold)));
const longestLine = (text: string, size: number, bold = false) => Math.max(0, ...text.split('\n').map((l) => textWidth(l, size, bold)));

// ---------------------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------------------

const SHORT_HEADER_RE = /^(s\.?\s*no\.?|sl\.?\s*no\.?|sr\.?\s*no\.?|#|uom|unit|units|sac(\s*code)?|hsn(\s*(code|\/sac))?|hsn\/sac|gst\s*%?|tax\s*%?|%)$/i;

/** Column kind: numbers (right), short codes (centre) or text (left). */
export function columnKinds(table: TableBlock): ('number' | 'short' | 'text')[] {
  return table.columns.map((header, c) => {
    const values = table.rows.map((r) => (r[c] ?? '').trim()).filter(Boolean);
    const h = header.trim();
    if (values.length && values.every((v) => looksNumeric(v)) && !SHORT_HEADER_RE.test(h)) return 'number';
    if (SHORT_HEADER_RE.test(h)) return 'short';
    const shortHeader = !h || textWidth(h, 10, true) < 50;
    if (shortHeader && values.length && values.every((v) => v.length <= 5 && !v.includes('\n'))) return 'short';
    if (!values.length && h && textWidth(h, 10) < 60) return 'short';
    return 'text';
  });
}

export function columnAligns(table: TableBlock): Align[] {
  const kinds = columnKinds(table);
  return kinds.map((k, c) => {
    if (k === 'number') return 'right';
    if (k === 'short') return 'center';
    const given = table.col_align[c];
    return given === 'right' && table.rows.every((r) => !(r[c] ?? '').trim() || looksNumeric(r[c])) ? 'right' : 'left';
  });
}

/** The table's last column holds the amounts (it is the one totals line up under). */
export function amountColumn(table: TableBlock): number {
  const kinds = columnKinds(table);
  const last = kinds.length - 1;
  return last >= 1 && kinds[last] === 'number' ? last : -1;
}

/** Width the amount column needs (value text only, no padding). */
export function amountWidth(table: TableBlock, size: number): number {
  const c = amountColumn(table);
  if (c < 0) return 0;
  return Math.max(longestWord(table.columns[c], size, true), ...table.rows.map((r) => textWidth((r[c] ?? '').trim(), size)));
}

export function totalsAmountWidth(block: TotalsBlock, size: number): number {
  return Math.max(0, ...block.items.map((item, i) => textWidth((i === block.items.length - 1 ? '₹ ' : '') + item.value, size, true)));
}

/**
 * Column widths (text widths, without cell padding) that add up to `inner`.
 * Numbers and short codes get what they need and never wrap; the amount column gets the
 * shared width so amounts line up across tables and with the totals; text columns share
 * the rest in proportion to their content.
 */
export function columnWidths(table: TableBlock, inner: number, size: number, sharedAmount = 0): number[] {
  const n = table.columns.length;
  const kinds = columnKinds(table);
  const amount = amountColumn(table);
  const header = (c: number) => longestWord(table.columns[c], size, true);
  const minW = table.columns.map((_, c) => Math.max(header(c), ...table.rows.map((r) => longestWord(r[c] ?? '', size)), size));
  const fullW = table.columns.map((h, c) => Math.max(longestLine(h, size, true) * 0.6, ...table.rows.map((r) => longestLine(r[c] ?? '', size)), size));

  const widths = Array<number>(n).fill(0);
  const fixed = kinds.map((k) => k !== 'text');
  // Short headings ("Rate (Rs)", "UOM") stay on one line; long ones may wrap at spaces.
  const headerLine = (c: number) => {
    const full = longestLine(table.columns[c], size, true);
    return full <= size * 7 ? full : header(c);
  };
  kinds.forEach((k, c) => {
    if (k === 'number') widths[c] = Math.max(minW[c], headerLine(c), ...table.rows.map((r) => textWidth((r[c] ?? '').trim(), size)));
    else if (k === 'short') widths[c] = Math.max(minW[c], headerLine(c));
  });
  if (amount >= 0) widths[amount] = Math.max(widths[amount], sharedAmount);

  const textCols = kinds.map((k, c) => (k === 'text' ? c : -1)).filter((c) => c >= 0);
  let free = inner - widths.reduce((a, b) => a + b, 0);
  if (!textCols.length) {
    // Only numbers / codes: spread the spare room evenly, keeping the amount column fixed.
    const others = widths.map((_, c) => c).filter((c) => c !== amount);
    const spread = others.length ? others : widths.map((_, c) => c);
    spread.forEach((c) => (widths[c] += free / spread.length));
    return widths;
  }
  if (free < textCols.reduce((s, c) => s + minW[c], 0)) {
    // Too tight: scale everything to fit, proportionally to what each column needs.
    const need = widths.map((w, c) => (fixed[c] ? w : minW[c]));
    const total = need.reduce((a, b) => a + b, 0) || 1;
    return need.map((w) => (w / total) * inner);
  }
  // Text columns: at least their longest word, then the rest in proportion to their content
  // (capped so one long description does not starve the others).
  textCols.forEach((c) => (widths[c] = minW[c]));
  free = inner - widths.reduce((a, b) => a + b, 0);
  const want = textCols.map((c) => Math.max(0, Math.min(fullW[c], inner * 0.7) - minW[c]));
  const wantTotal = want.reduce((a, b) => a + b, 0);
  if (wantTotal <= free) {
    textCols.forEach((c, i) => (widths[c] += want[i]));
    free -= wantTotal;
    // Whatever is left goes to the widest text column (usually the description).
    const widest = textCols.reduce((best, c) => (fullW[c] > fullW[best] ? c : best), textCols[0]);
    widths[widest] += free;
  } else {
    textCols.forEach((c, i) => (widths[c] += wantTotal ? (want[i] / wantTotal) * free : free / textCols.length));
  }
  return widths;
}

// ---------------------------------------------------------------------------------------
// Customer | details box
// ---------------------------------------------------------------------------------------

/** A two-box row without headings: the customer address next to the document details. */
export function isPartyBox(table: TableBlock): boolean {
  return table.columns.length === 2 && table.columns.every((c) => !c.trim()) && table.rows.length === 1 && table.rows[0].some((c) => c.includes('\n'));
}

const COMPANY_END_RE = /^(.*?\b(?:pvt\.?\s*ltd\.?|private\s+limited|limited|ltd\.?|llp|inc\.?|corporation|industries|enterprises|traders|agencies|& co\.?|and company))(?=[\s,]+\S)[\s,]*(.*)$/i;

/** "M/s.ABC PRODUCTS LTD PLOT NO. 14, ..." (one line in the source) -> name, rest of the address. */
export function splitCompanyName(line: string): [string, string] {
  const m = COMPANY_END_RE.exec(line.trim());
  return m && m[2] ? [m[1].trim(), m[2].trim()] : [line.trim(), ''];
}

export const TO_LABEL_RE = /^(to|bill(ed)?\s*to|ship(ped)?\s*to|buyer|consignee|customer|client|party)\b[\s,:.-]*$/i;

const ACRONYMS = new Set(['PO', 'GST', 'GSTIN', 'PAN', 'SAC', 'HSN', 'ID', 'UOM', 'IFSC', 'CIN', 'TIN', 'IGST', 'CGST', 'SGST', 'DC', 'WO', 'GRN']);
const LABEL_START = new Set([
  'PO', 'P.O.', 'INVOICE', 'BILL', 'GST', 'GSTIN', 'PAN', 'VENDOR', 'SUPPLIER', 'QUOTATION', 'QUOTE', 'REF', 'REFERENCE', 'DUE', 'ORDER', 'STATE',
  'PLACE', 'PAYMENT', 'DELIVERY', 'CUSTOMER', 'CONTACT', 'EMAIL', 'E-MAIL', 'MOBILE', 'PHONE', 'CELL', 'DATE', 'TYPE', 'ENQUIRY', 'ENQ', 'DC', 'WORK', 'JOB', 'VALID', 'VALIDITY', 'OUR', 'YOUR', 'CIN', 'TIN', 'IFSC', 'BANK', 'ACCOUNT', 'A/C',
]);

/** "PO NUMBER" -> "PO Number", "INVOICE NO" -> "Invoice No". Mixed-case labels are left alone. */
export function labelCase(label: string): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  if (clean !== clean.toUpperCase()) return clean;
  return clean
    .split(' ')
    .map((w) => (ACRONYMS.has(w.replace(/[.:]/g, '')) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
}

export interface Pair {
  label: string;
  value: string;
}

/**
 * Splits "PO NUMBER:5300256151 INVOICE NO:338" into its label: value pairs. Returns null
 * when the line is not made of label: value pairs.
 */
export function splitPairs(line: string): Pair[] | null {
  const text = line.trim();
  const colons: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === ':' && !/\d/.test(text[i - 1] ?? '') ) colons.push(i);
  // Times like 10:30 are not labels.
  if (!colons.length) return null;
  const starts: number[] = [];
  colons.forEach((colon, k) => {
    if (k === 0) {
      starts.push(0);
      return;
    }
    // Walk back over the words just before this colon (up to three).
    const before = text.slice(0, colon);
    const words = before.split(' ');
    let take = 0;
    for (let w = words.length - 1; w >= 0 && take < 3; w--) {
      if (!/^[A-Za-z][A-Za-z./&#-]*$/.test(words[w])) break;
      take++;
    }
    while (take > 1 && !LABEL_START.has(words[words.length - take].toUpperCase())) take--;
    if (!take) {
      starts.push(-1);
      return;
    }
    starts.push(before.length - words.slice(words.length - take).join(' ').length);
  });
  const pairs: Pair[] = [];
  let k = 0;
  while (k < colons.length) {
    if (starts[k] < 0) return null;
    let next = k + 1;
    while (next < colons.length && starts[next] < 0) next++;
    const label = text.slice(starts[k], colons[k]).trim();
    const end = next < colons.length ? starts[next] : text.length;
    const value = text.slice(colons[k] + 1, end).trim();
    if (!label || label.split(' ').length > 4 || !/^[A-Za-z]/.test(label)) return null;
    pairs.push({ label, value });
    k = next;
  }
  return pairs;
}
