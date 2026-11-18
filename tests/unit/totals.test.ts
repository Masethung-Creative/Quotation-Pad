import { describe, expect, it } from 'vitest';
import type { Block, CanonicalDoc, TableBlock, TotalsBlock } from '@/schema/canonical';
import { checkDocument, classifyTotalsLabel, detectColumns, findGrandTotal } from '@/validate/totals';

const table = (rows: string[][], columns = ['S.No', 'Description', 'Qty', 'Rate (Rs)', 'Amount (Rs)']): TableBlock => ({
  type: 'table',
  columns,
  col_align: columns.map(() => 'left'),
  rows,
});
const totals = (items: [string, string][], words?: string): TotalsBlock => ({
  type: 'totals',
  items: items.map(([label, value]) => ({ label, value })),
  ...(words ? { amount_in_words: words } : {}),
});
const doc = (...blocks: Block[]): CanonicalDoc => ({ blocks, confidence: {} });

const GOOD_ROWS = [
  ['1', 'LED Flood Light 100W', '10', '1,850.00', '18,500.00'],
  ['2', 'MCB 32A Double Pole', '24', '420.00', '10,080.00'],
  ['3', 'Installation', '1', '7,500.00', '7,500.00'],
];
const GOOD_TOTALS: [string, string][] = [
  ['Sub Total', '36,080.00'],
  ['CGST 9%', '3,247.20'],
  ['SGST 9%', '3,247.20'],
  ['Grand Total', '42,574.40'],
];

describe('column detection', () => {
  it('finds qty, rate and amount columns and ignores the serial number', () => {
    expect(detectColumns(table([]))).toMatchObject({ qty: 2, rate: 3, amounts: [4] });
    expect(detectColumns(table([], ['Sl No', 'Item', 'HSN', 'Quantity', 'Unit Price', 'Disc %', 'GST %', 'Taxable Value', 'Total']))).toMatchObject({
      qty: 3,
      rate: 4,
      discPct: 5,
      taxPct: 6,
      amounts: [7, 8],
    });
  });
});

describe('totals label classification', () => {
  it.each([
    ['Sub Total', 'subtotal'],
    ['Sub-total', 'subtotal'],
    ['Taxable Value', 'taxable'],
    ['CGST 9%', 'tax'],
    ['IGST @ 18%', 'tax'],
    ['Discount 5%', 'discount'],
    ['Freight', 'addon'],
    ['Packing & Forwarding', 'addon'],
    ['Round Off', 'roundoff'],
    ['Grand Total', 'grand'],
    ['Net Amount Payable', 'grand'],
    ['Total', 'total'],
    ['Remarks', 'other'],
  ])('%s -> %s', (label, kind) => {
    expect(classifyTotalsLabel(label)).toBe(kind);
  });
});

describe('checkDocument', () => {
  it('passes a correct quotation and reports what it checked', () => {
    const report = checkDocument(doc(table(GOOD_ROWS), totals(GOOD_TOTALS, 'Rupees Forty Two Thousand Five Hundred Seventy Four and Paise Forty Only')));
    expect(report.issues).toEqual([]);
    expect(report.rowsChecked).toBe(3);
    expect(report.totalsChecked).toBe(5);
  });

  it('accepts the example from the specification', () => {
    const report = checkDocument(
      doc(
        table([['1', 'Item description', '2', '1,500.00', '3,000.00']]),
        totals(
          [
            ['Sub Total', '3,000.00'],
            ['CGST 9%', '270.00'],
            ['SGST 9%', '270.00'],
            ['Grand Total', '3,540.00'],
          ],
          'Rupees Three Thousand Five Hundred Forty Only',
        ),
      ),
    );
    expect(report.issues).toEqual([]);
  });

  it('flags a row where qty x rate is not the amount, with its cell position', () => {
    const rows = GOOD_ROWS.map((r) => [...r]);
    rows[1][4] = '10,800.00';
    const report = checkDocument(doc(table(rows)));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({ kind: 'row', block: 0, row: 1, col: 4, expected: 10080, found: 10800 });
  });

  it('flags a wrong sub total, GST line and grand total separately', () => {
    const report = checkDocument(
      doc(
        table(GOOD_ROWS),
        totals([
          ['Sub Total', '36,800.00'],
          ['CGST 9%', '3,247.20'],
          ['SGST 9%', '3,312.00'],
          ['Grand Total', '50,000.00'],
        ]),
      ),
    );
    const kinds = report.issues.map((i) => `${i.kind}:${i.item}`);
    // CGST is wrong against the (wrong) printed sub total; SGST happens to match it.
    expect(kinds).toEqual(['subtotal:0', 'tax:1', 'grand_total:3']);
  });

  it('flags amount in words that do not match the grand total', () => {
    const report = checkDocument(doc(table(GOOD_ROWS), totals(GOOD_TOTALS, 'Rupees Forty Two Thousand Only')));
    expect(report.issues.map((i) => i.kind)).toEqual(['amount_in_words']);
  });

  it('never changes any number', () => {
    const rows = GOOD_ROWS.map((r) => [...r]);
    rows[0][4] = '99,999.00';
    const input = doc(table(rows), totals(GOOD_TOTALS));
    const before = JSON.stringify(input);
    checkDocument(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('understands discount, freight and round off', () => {
    const report = checkDocument(
      doc(
        table([['1', 'Pump', '2', '10,000.00', '20,000.00']]),
        totals([
          ['Sub Total', '20,000.00'],
          ['Discount 5%', '1,000.00'],
          ['Freight', '333.00'],
          ['IGST 18%', '3,479.94'],
          ['Round Off', '0.06'],
          ['Grand Total', '22,813.00'],
        ]),
      ),
    );
    expect(report.issues).toEqual([]);
  });

  it('accepts a whole-rupee grand total when no round-off line is shown', () => {
    const report = checkDocument(
      doc(
        table([['1', 'Cable', '3', '33.33', '99.99']]),
        totals([
          ['Sub Total', '99.99'],
          ['GST 18%', '18.00'],
          ['Total', '118'],
        ]),
      ),
    );
    expect(report.issues).toEqual([]);
  });

  it('checks rows with a discount percentage and GST-inclusive totals', () => {
    const t = table(
      [
        ['1', 'Motor', '2', '5,000.00', '10', '18', '9,000.00', '10,620.00'],
        ['2', 'Starter', '1', '2,000.00', '0', '18', '2,000.00', '2,400.00'],
      ],
      ['S.No', 'Item', 'Qty', 'Rate', 'Disc %', 'GST %', 'Taxable Value', 'Total'],
    );
    const report = checkDocument(doc(t));
    expect(report.rowsChecked).toBe(2);
    expect(report.issues).toEqual([]);
  });

  it('skips rows without numbers and quantities with units', () => {
    const report = checkDocument(
      doc(
        table([
          ['', 'Electrical works', '', '', ''],
          ['1', 'Wire', '5 Nos', '100.00', '500.00'],
          ['2', 'Lump sum work', 'LS', '2,000.00', '2,000.00'],
        ]),
        totals([['Total', '2,500.00']]),
      ),
    );
    expect(report.rowsChecked).toBe(1);
    expect(report.issues).toEqual([]);
  });

  it('does nothing for documents without tables', () => {
    expect(checkDocument(doc({ type: 'paragraph', runs: [{ text: 'Hello' }], align: 'left' }))).toEqual({ issues: [], rowsChecked: 0, totalsChecked: 0 });
  });
});

describe('findGrandTotal', () => {
  it('picks the grand total line', () => {
    expect(findGrandTotal(totals(GOOD_TOTALS))).toBe(42574.4);
    expect(findGrandTotal(totals([['Total', '1,180.00']]))).toBe(1180);
    expect(findGrandTotal(totals([['Sub Total', '100.00']]))).toBeNull();
  });
});
