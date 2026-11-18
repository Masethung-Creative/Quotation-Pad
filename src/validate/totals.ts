import type { CanonicalDoc, TableBlock, TotalsBlock } from '@/schema/canonical';
import { amountInWords, decimalsOf, formatIndian, parseAmount, parsePercent, parseQuantity, wordsKey } from '@/lib/format';

/**
 * Arithmetic checker. It recomputes qty x rate per row, the sub total, each GST line,
 * the grand total and the amount in words - and ONLY reports what does not add up.
 * It never changes a number: numbers are sacred, a human decides.
 */

export type IssueKind = 'row' | 'subtotal' | 'tax' | 'grand_total' | 'amount_in_words';

export interface Issue {
  kind: IssueKind;
  /** Index of the block in doc.blocks. */
  block: number;
  /** Table cell (row/col) for row issues. */
  row?: number;
  col?: number;
  /** Totals item index for subtotal / tax / grand total issues. */
  item?: number;
  message: string;
  expected?: number;
  found?: number;
}

export interface TotalsReport {
  issues: Issue[];
  rowsChecked: number;
  totalsChecked: number;
}

const SERIAL_RE = /^(s\.?\s*no\.?|sl\.?\s*no\.?|sr\.?\s*no\.?|s\.?\s*n\.?|#|no\.?|item\s*no\.?|sl\.?|sr\.?)$/i;
const QTY_RE = /\b(qty|quantity|qnty|nos|units?|pcs|pieces)\b/i;
const RATE_RE = /\b(rate|price|mrp|cost)\b/i;
const AMOUNT_RE = /\b(amount|amt|total|value)\b/i;
const DISC_RE = /\bdisc/i;
const TAX_COL_RE = /\b(gst|igst|cgst|sgst|tax|vat)\b/i;

export interface TableColumns {
  qty: number;
  rate: number;
  amounts: number[];
  discPct: number;
  taxPct: number;
}

export function detectColumns(table: TableBlock): TableColumns {
  let qty = -1;
  let rate = -1;
  let discPct = -1;
  let taxPct = -1;
  const amounts: number[] = [];
  table.columns.forEach((raw, i) => {
    const h = raw.trim();
    if (!h || SERIAL_RE.test(h)) return;
    const pct = /%/.test(h);
    if (DISC_RE.test(h)) {
      if (pct && discPct < 0) discPct = i;
      return;
    }
    if (TAX_COL_RE.test(h) && !/\b(amount|amt|value|total)\b/i.test(h)) {
      if (taxPct < 0) taxPct = i;
      return;
    }
    if (RATE_RE.test(h) && rate < 0) {
      rate = i;
      return;
    }
    if (QTY_RE.test(h) && qty < 0) {
      qty = i;
      return;
    }
    if (AMOUNT_RE.test(h) && !TAX_COL_RE.test(h)) amounts.push(i);
  });
  return { qty, rate, amounts, discPct, taxPct };
}

/** Allowed rounding slack, based on how precisely the number was written. */
function tolerance(text: string): number {
  const d = decimalsOf(text);
  if (d >= 2) return 0.011;
  if (d === 1) return 0.06;
  return 0.51;
}

function close(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

type ItemKind = 'subtotal' | 'taxable' | 'discount' | 'addon' | 'tax' | 'roundoff' | 'grand' | 'total' | 'other';

export function classifyTotalsLabel(label: string): ItemKind {
  const l = label.toLowerCase();
  if (/round/.test(l)) return 'roundoff';
  if (/sub[\s-]*total|total\s*before|before\s*tax|basic\s*(amount|value|total)|gross\s*(amount|total|value)/.test(l)) return 'subtotal';
  if (/taxable/.test(l)) return 'taxable';
  if (/grand|net\s*(amount|total|payable|value)|total\s*(amount|payable|value|incl|inc\b|with|rs|inr|₹)|amount\s*payable|final\s*(amount|total)|total\s*[:.]?\s*$/.test(l) && !/total\s*(gst|tax|cgst|sgst|igst)/.test(l)) {
    return /^\s*total\s*[:.]?\s*$/.test(l) ? 'total' : 'grand';
  }
  if (/\b(c\.?gst|s\.?gst|i\.?gst|ut\.?gst|gst|vat|cess|tax)\b/.test(l)) return 'tax';
  if (/disc|rebate|\bless\b/.test(l)) return 'discount';
  if (/freight|transport|packing|forward|p\s*&\s*f|loading|delivery|install|courier|insurance|handling|charges|labou?r/.test(l)) return 'addon';
  return 'other';
}

interface TableSums {
  /** Sum of every candidate amount column (a table may show both taxable and gross totals). */
  sums: number[];
}

function checkTable(table: TableBlock, blockIndex: number, issues: Issue[]): { rows: number; sums: TableSums } {
  const cols = detectColumns(table);
  const sums: number[] = cols.amounts.map(() => 0);
  const seen: boolean[] = cols.amounts.map(() => false);
  let rows = 0;

  table.rows.forEach((row, r) => {
    cols.amounts.forEach((c, k) => {
      const v = parseAmount(row[c]);
      if (v !== null) {
        sums[k] += v;
        seen[k] = true;
      }
    });
    if (cols.qty < 0 || cols.rate < 0 || cols.amounts.length === 0) return;
    const qty = parseQuantity(row[cols.qty]);
    const rate = parseAmount(row[cols.rate]);
    if (qty === null || rate === null) return;

    let base = qty * rate;
    if (cols.discPct >= 0) {
      const d = parsePercent(`${row[cols.discPct]}%`) ?? 0;
      base *= 1 - d / 100;
    }
    const taxPct = cols.taxPct >= 0 ? (parsePercent(`${row[cols.taxPct]}%`) ?? 0) : 0;
    const candidates = [base, base * (1 + taxPct / 100)];

    let anyParsed = false;
    let anyMatch = false;
    for (const c of cols.amounts) {
      const found = parseAmount(row[c]);
      if (found === null) continue;
      anyParsed = true;
      if (candidates.some((exp) => close(found, exp, tolerance(row[c])))) anyMatch = true;
    }
    if (!anyParsed) return;
    rows++;
    if (!anyMatch) {
      const c = cols.amounts.find((i) => parseAmount(row[i]) !== null)!;
      const found = parseAmount(row[c])!;
      issues.push({
        kind: 'row',
        block: blockIndex,
        row: r,
        col: c,
        expected: base,
        found,
        message: `Row ${r + 1}: ${row[cols.qty].trim()} x ${row[cols.rate].trim()} = ${formatIndian(base)}, but the amount says ${row[c].trim()}.`,
      });
    }
  });

  return { rows, sums: { sums: sums.filter((_, k) => seen[k]) } };
}

function checkTotals(totals: TotalsBlock, blockIndex: number, table: TableSums | null, issues: Issue[]): number {
  let checked = 0;
  const sums = table?.sums ?? [];
  const firstSum = sums.length ? sums[0] : null;
  const kinds = totals.items.map((it) => classifyTotalsLabel(it.label));
  const lastAmountIdx = totals.items.reduce((acc, it, i) => (parseAmount(it.value) !== null ? i : acc), -1);
  const hasTaxAfter = (i: number) => kinds.slice(i + 1).some((k) => k === 'tax');

  let running: number | null = null;
  let taxBase: number | null = null;
  let taxSum = 0;
  let postTax = 0;
  let seenTax = false;
  let seenRound = false;
  let grand: number | null = null;

  totals.items.forEach((item, i) => {
    const v = parseAmount(item.value);
    if (v === null) return;
    let kind = kinds[i];
    if (kind === 'total') kind = i === lastAmountIdx || !hasTaxAfter(i) ? 'grand' : 'subtotal';
    const tol = tolerance(item.value);

    switch (kind) {
      case 'subtotal': {
        if (sums.length) {
          checked++;
          if (!sums.some((s) => close(v, s, tol))) {
            issues.push({
              kind: 'subtotal',
              block: blockIndex,
              item: i,
              expected: firstSum!,
              found: v,
              message: `${item.label.trim()}: the rows add up to ${formatIndian(firstSum!)}, but it says ${item.value.trim()}.`,
            });
          }
        }
        running = v;
        break;
      }
      case 'taxable': {
        if (running !== null) {
          checked++;
          if (!close(v, running, tol)) {
            issues.push({
              kind: 'subtotal',
              block: blockIndex,
              item: i,
              expected: running,
              found: v,
              message: `${item.label.trim()}: expected ${formatIndian(running)}, but it says ${item.value.trim()}.`,
            });
          }
        }
        running = v;
        break;
      }
      case 'discount': {
        if (running === null) running = firstSum;
        const amount = Math.abs(v);
        const pct = parsePercent(item.label);
        if (pct !== null && running !== null) {
          checked++;
          const exp = (running * pct) / 100;
          if (!close(amount, exp, tol)) {
            issues.push({
              kind: 'tax',
              block: blockIndex,
              item: i,
              expected: exp,
              found: amount,
              message: `${item.label.trim()}: ${pct}% of ${formatIndian(running)} is ${formatIndian(exp)}, but it says ${item.value.trim()}.`,
            });
          }
        }
        if (running !== null) running -= amount;
        break;
      }
      case 'addon': {
        if (seenTax) postTax += v;
        else running = (running ?? firstSum ?? 0) + v;
        break;
      }
      case 'tax': {
        if (!seenTax) {
          taxBase = running ?? firstSum;
          seenTax = true;
        }
        const pct = parsePercent(item.label);
        if (pct !== null && taxBase !== null) {
          checked++;
          const exp = (taxBase * pct) / 100;
          if (!close(v, exp, tol)) {
            issues.push({
              kind: 'tax',
              block: blockIndex,
              item: i,
              expected: exp,
              found: v,
              message: `${item.label.trim()}: ${pct}% of ${formatIndian(taxBase)} is ${formatIndian(exp)}, but it says ${item.value.trim()}.`,
            });
          }
        }
        taxSum += v;
        break;
      }
      case 'roundoff': {
        seenRound = true;
        postTax += v;
        break;
      }
      case 'grand': {
        grand = v;
        const base = seenTax ? taxBase : (running ?? firstSum);
        if (base === null) break;
        checked++;
        const exp = base + taxSum + postTax;
        const implicitRounding = !seenRound && Number.isInteger(v) && Math.abs(v - exp) <= 0.5;
        if (!close(v, exp, tol) && !implicitRounding) {
          issues.push({
            kind: 'grand_total',
            block: blockIndex,
            item: i,
            expected: exp,
            found: v,
            message: `${item.label.trim()}: the lines above add up to ${formatIndian(exp)}, but it says ${item.value.trim()}.`,
          });
        }
        break;
      }
      default:
        break;
    }
  });

  const words = totals.amount_in_words?.trim();
  if (words && grand !== null && /^[\x00-\x7F₹]+$/.test(words)) {
    const key = wordsKey(words);
    if (key) {
      checked++;
      const expected = amountInWords(grand);
      if (key !== wordsKey(expected)) {
        issues.push({
          kind: 'amount_in_words',
          block: blockIndex,
          expected: grand,
          message: `Amount in words does not match the total ${formatIndian(grand)} ("${expected}").`,
        });
      }
    }
  }
  return checked;
}

export function checkDocument(doc: CanonicalDoc): TotalsReport {
  const issues: Issue[] = [];
  let rowsChecked = 0;
  let totalsChecked = 0;
  let lastTable: TableSums | null = null;

  doc.blocks.forEach((block, index) => {
    if (block.type === 'table') {
      const res = checkTable(block, index, issues);
      rowsChecked += res.rows;
      lastTable = res.sums.sums.length ? res.sums : null;
    } else if (block.type === 'totals') {
      totalsChecked += checkTotals(block, index, lastTable, issues);
    }
  });

  return { issues, rowsChecked, totalsChecked };
}

/** The grand total of a totals block, if one can be identified. Used by "write amount in words". */
export function findGrandTotal(totals: TotalsBlock): number | null {
  const kinds = totals.items.map((it) => classifyTotalsLabel(it.label));
  for (let i = totals.items.length - 1; i >= 0; i--) {
    if (kinds[i] === 'grand' || kinds[i] === 'total') {
      const v = parseAmount(totals.items[i].value);
      if (v !== null) return v;
    }
  }
  return null;
}
