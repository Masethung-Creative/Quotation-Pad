import { describe, expect, it } from 'vitest';
import { isPageNumber, removeHeaderFooter } from '@/extract/headerFooter';
import { buildLines, reconstruct } from '@/extract/reconstruct';
import { refineBlocks } from '@/extract/refine';
import { finalizeBlocks, type PageWords, type Word, type XBlock } from '@/extract/types';
import { docText, type Block } from '@/schema/canonical';
import { compareCoverage } from '@/validate/coverage';
import { row } from './helpers';

const page = (words: Word[], ocr = false): PageWords => ({ width: 600, height: 840, words, ocr });

/** A small quotation laid out with coordinates, the way pdf.js or OCR would report it. */
function quotationWords(): Word[] {
  return [
    ...row(60, [['QUOTATION', 260]], 16),
    ...row(100, [['Ref No: Q/2026-27/045', 50], ['Date: 17-11-2026', 440]]),
    ...row(130, [['To,', 50]]),
    ...row(143, [['The Manager,', 50]]),
    ...row(156, [['ABC Traders, Chennai', 50]]),
    ...row(200, [['S.No', 50], ['Description', 110], ['Qty', 360], ['Rate (Rs)', 420], ['Amount (Rs)', 495]]),
    ...row(220, [['1', 58], ['Item description one', 110], ['2', 372], ['1,500.00', 425], ['3,000.00', 510]]),
    ...row(240, [['2', 58], ['A much longer item description that', 110], ['10', 367], ['250.00', 435], ['2,500.00', 510]]),
    ...row(253, [['wraps onto a second line', 110]]),
    ...row(273, [['3', 58], ['Third item', 110], ['1', 372], ['500.00', 435], ['500.00', 520]]),
    ...row(300, [['Sub Total', 400], ['6,000.00', 510]]),
    ...row(315, [['CGST 9%', 400], ['540.00', 520]]),
    ...row(330, [['SGST 9%', 400], ['540.00', 520]]),
    ...row(345, [['Grand Total', 400], ['7,080.00', 510]]),
    ...row(375, [['Rupees Seven Thousand Eighty Only', 50]]),
    ...row(410, [['1. Validity: 30 days', 50]]),
    ...row(423, [['2. Payment: 50% advance', 50]]),
    ...row(470, [['For ABC Traders', 440]]),
    ...row(520, [['Authorised Signatory', 430]]),
  ];
}

const types = (blocks: Block[]) => blocks.map((b) => b.type);

describe('buildLines', () => {
  it('groups words into lines and splits far-apart words into segments', () => {
    const lines = buildLines(page([...row(100, [['Ref', 50], ['No:', 68], ['Q/45', 88], ['Date:', 400], ['17-11-2026', 430]])]), 0);
    expect(lines).toHaveLength(1);
    expect(lines[0].segs.map((s) => s.text)).toEqual(['Ref No: Q/45', 'Date: 17-11-2026']);
  });

  it('keeps separate rows apart even when OCR boxes jitter', () => {
    const jitter: Word[] = [
      { text: 'First', x0: 50, x1: 80, y0: 100, y1: 110 },
      { text: 'line', x0: 85, x1: 105, y0: 101.5, y1: 111 },
      { text: 'Second', x0: 50, x1: 90, y0: 114, y1: 124 },
      { text: 'line', x0: 95, x1: 115, y0: 113, y1: 123.5 },
    ];
    expect(buildLines(page(jitter, true), 0).map((l) => l.text)).toEqual(['First line', 'Second line']);
  });

  it('joins pdf text fragments of one word without inventing a space', () => {
    const lines = buildLines(page([{ text: 'Quot', x0: 50, x1: 70, y0: 100, y1: 110 }, { text: 'ation', x0: 70.4, x1: 95, y0: 100, y1: 110 }]), 0);
    expect(lines[0].text).toBe('Quotation');
  });
});

describe('reconstruct + refine', () => {
  const rebuilt = reconstruct([page(quotationWords())]);
  const doc = finalizeBlocks(refineBlocks(rebuilt.blocks));

  it('recognises every part of the quotation in order', () => {
    expect(types(doc.blocks).filter((t) => t !== 'spacer')).toEqual(['heading', 'meta', 'paragraph', 'table', 'totals', 'list', 'signature']);
  });

  it('reads the heading and the reference details', () => {
    expect(doc.blocks[0]).toMatchObject({ type: 'heading', text: 'QUOTATION', level: 1, align: 'center' });
    const meta = doc.blocks.find((b) => b.type === 'meta');
    expect(meta).toMatchObject({ items: [{ label: 'Ref No', value: 'Q/2026-27/045' }, { label: 'Date', value: '17-11-2026' }] });
  });

  it('keeps address lines as separate lines of one paragraph', () => {
    const para = doc.blocks.find((b) => b.type === 'paragraph');
    expect(para?.type === 'paragraph' && para.runs.map((r) => r.text).join('')).toBe('To,\nThe Manager,\nABC Traders, Chennai');
  });

  it('rebuilds the table with header, alignment and wrapped cells', () => {
    const table = doc.blocks.find((b) => b.type === 'table');
    if (table?.type !== 'table') throw new Error('no table');
    expect(table.columns).toEqual(['S.No', 'Description', 'Qty', 'Rate (Rs)', 'Amount (Rs)']);
    expect(table.col_align).toEqual(['center', 'left', 'right', 'right', 'right']);
    expect(table.rows).toEqual([
      ['1', 'Item description one', '2', '1,500.00', '3,000.00'],
      ['2', 'A much longer item description that wraps onto a second line', '10', '250.00', '2,500.00'],
      ['3', 'Third item', '1', '500.00', '500.00'],
    ]);
  });

  it('lifts the totals out of the table area and attaches the amount in words', () => {
    const totals = doc.blocks.find((b) => b.type === 'totals');
    expect(totals).toMatchObject({
      items: [
        { label: 'Sub Total', value: '6,000.00' },
        { label: 'CGST 9%', value: '540.00' },
        { label: 'SGST 9%', value: '540.00' },
        { label: 'Grand Total', value: '7,080.00', bold: true },
      ],
      amount_in_words: 'Rupees Seven Thousand Eighty Only',
    });
  });

  it('turns numbered lines into an ordered list and finds the signature', () => {
    expect(doc.blocks.find((b) => b.type === 'list')).toMatchObject({ ordered: true, items: ['Validity: 30 days', 'Payment: 50% advance'] });
    expect(doc.blocks.find((b) => b.type === 'signature')).toMatchObject({ lines: ['For ABC Traders', '', 'Authorised Signatory'], align: 'right' });
  });

  it('never drops a word: every source token is in the result', () => {
    // List numbers ("1.", "2.") are regenerated by the renderer, so they are not part of the text.
    const source = quotationWords()
      .map((w) => w.text.replace(/^\d+\.\s+/, ''))
      .join(' ');
    expect(compareCoverage(source, docText(doc)).missing).toEqual([]);
  });
});

describe('OCR confidence', () => {
  it('flags low-confidence words and table cells, and reports block confidence', () => {
    const words = quotationWords().map((w) => ({ ...w, conf: 0.95 }));
    const amount = words.find((w) => w.text === '2,500.00')!;
    amount.conf = 0.41;
    const to = words.find((w) => w.text === 'The Manager,')!;
    to.conf = 0.55;
    const doc = finalizeBlocks(refineBlocks(reconstruct([page(words, true)]).blocks));
    const tableIndex = doc.blocks.findIndex((b) => b.type === 'table');
    const paraIndex = doc.blocks.findIndex((b) => b.type === 'paragraph');
    expect(doc.low_confidence?.[String(tableIndex)]?.cells).toEqual(['1:4']);
    expect(doc.low_confidence?.[String(paraIndex)]?.words).toEqual(['The Manager,']);
    expect(doc.confidence[String(tableIndex)]).toBeLessThan(0.95);
    expect(doc.confidence[String(tableIndex)]).toBeGreaterThan(0.8);
  });

  it('gives text read directly from a file full confidence', () => {
    const doc = finalizeBlocks(refineBlocks(reconstruct([page(quotationWords())]).blocks));
    expect(Object.values(doc.confidence).every((c) => c === 1)).toBe(true);
    expect(doc.low_confidence).toBeUndefined();
  });
});

describe('source header / footer removal', () => {
  const body = (n: number) => [...row(300, [[`Body text of page ${n} is different`, 50]]), ...row(330, [[`More unique words ${n * 7}`, 50]])];
  const pageWith = (n: number, total: number): PageWords =>
    page([...row(30, [['SRI VELAN ELECTRICALS', 200]], 14), ...row(50, [['14, Gandhi Road, Erode', 220]]), ...body(n), ...row(810, [['Sri Velan Electricals', 50], [`Page ${n} of ${total}`, 500]])]);

  it('drops lines repeated on every page and page numbers, and reports them', () => {
    const pages = [pageWith(1, 3), pageWith(2, 3), pageWith(3, 3)];
    const lines = pages.map((p, i) => buildLines(p, i));
    const result = removeHeaderFooter(lines, pages.map((p) => p.height));
    for (const pageLines of result.pages) expect(pageLines.map((l) => l.text)).toEqual([expect.stringContaining('Body text'), expect.stringContaining('More unique')]);
    expect(result.removed).toHaveLength(9);
    expect(result.removed).toContain('SRI VELAN ELECTRICALS');
  });

  it('keeps a single-page header (no repetition to prove it is a header) but drops "Page 1 of 1"', () => {
    const lines = [buildLines(pageWith(1, 1), 0)];
    const result = removeHeaderFooter(lines, [840]);
    const texts = result.pages[0].map((l) => l.text);
    expect(texts).toContain('SRI VELAN ELECTRICALS');
    expect(texts).toContain('Sri Velan Electricals');
    expect(result.removed).toEqual(['Page 1 of 1']);
    expect(texts.some((t) => t.includes('Page 1 of 1'))).toBe(false);
  });

  it('recognises page number formats', () => {
    for (const t of ['Page 1 of 2', 'page 3', 'Page No. 4', '2 / 5', '3 of 9', '- 2 -', 'Contd...', '(Continued on next page)', 'P.T.O']) expect(isPageNumber(t)).toBe(true);
    for (const t of ['Page layout as agreed', '2 Nos', 'Total 5 of 9 items delivered']) expect(isPageNumber(t)).toBe(false);
  });

  it('does not touch text in the middle of the page even when it repeats', () => {
    const p = (n: number) => page([...row(400, [['Same line on every page', 50]]), ...row(430, [[`unique ${n}`, 50]])]);
    const pages = [p(1), p(2)];
    const result = removeHeaderFooter(pages.map((x, i) => buildLines(x, i)), [840, 840]);
    expect(result.removed).toEqual([]);
  });
});

describe('refineBlocks', () => {
  const table = (rows: string[][], page = 0): XBlock => ({
    type: 'table',
    columns: ['S.No', 'Description', 'Qty', 'Rate', 'Amount'],
    col_align: ['left', 'left', 'left', 'left', 'left'],
    rows,
    _page: page,
  });

  it('joins a table that continues on the next page and reports the repeated heading', () => {
    const repeated: string[] = [];
    const out = refineBlocks([table([['1', 'A', '1', '10.00', '10.00']], 0), table([['2', 'B', '2', '10.00', '20.00']], 1)], repeated);
    expect(out).toHaveLength(1);
    expect(out[0].type === 'table' && out[0].rows).toHaveLength(2);
    expect(repeated).toEqual(['S.No Description Qty Rate Amount']);
  });

  it('moves totals rows (including merged cells) out of a Word table and fixes alignment', () => {
    const out = refineBlocks([
      table([
        ['1', 'A', '1', '10.00', '10.00'],
        ['2', 'B', '2', '10.00', '20.00'],
        ['Sub Total', '', '', '', '30.00'],
        ['GST', '18%', '', '', '5.40'],
        ['Grand Total', '', '', '', '35.40'],
        ['Amount in words: Rupees Thirty Five and Paise Forty Only', '', '', '', ''],
      ]),
    ]);
    expect(out.map((b) => b.type)).toEqual(['table', 'totals']);
    const [t, totals] = out;
    expect(t.type === 'table' && t.rows).toHaveLength(2);
    expect(t.type === 'table' && t.col_align).toEqual(['center', 'left', 'right', 'right', 'right']);
    expect(totals).toMatchObject({
      items: [
        { label: 'Sub Total', value: '30.00' },
        { label: 'GST 18%', value: '5.40' },
        { label: 'Grand Total', value: '35.40', bold: true },
      ],
      amount_in_words: 'Amount in words: Rupees Thirty Five and Paise Forty Only',
    });
  });

  it('leaves ordinary tables alone', () => {
    const input = [table([['1', 'A', '1', '10.00', '10.00'], ['2', 'Total station survey', '1', '5.00', '5.00']])];
    expect(refineBlocks(input)).toEqual(input);
  });

  it('builds the signature block from "For ..." and "Authorised Signatory"', () => {
    const p = (text: string, indent = 0): XBlock => ({ type: 'paragraph', runs: [{ text }], align: 'left', _indent: indent });
    const out = refineBlocks([p('Thanking you,'), p('For Sri Velan Electricals', 0.6), { type: 'spacer', mm: 8 }, p('Authorised Signatory', 0.6), p('(R. Kumar)', 0.6)]);
    expect(out.map((b) => b.type)).toEqual(['paragraph', 'signature']);
    expect(out[1]).toMatchObject({ lines: ['For Sri Velan Electricals', '', 'Authorised Signatory', '(R. Kumar)'], align: 'right' });
  });
});
