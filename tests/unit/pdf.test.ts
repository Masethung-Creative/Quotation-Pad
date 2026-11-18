// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { needsOcr } from '@/extract/pdf';
import { reconstruct } from '@/extract/reconstruct';
import { refineBlocks } from '@/extract/refine';
import { finalizeBlocks } from '@/extract/types';
import { docText } from '@/schema/canonical';
import { compareCoverage, subtractTokens } from '@/validate/coverage';
import { checkDocument } from '@/validate/totals';
import { pdfPages, sample } from './helpers';

describe('digital PDF extractor on samples/quotation-digital.pdf (2 pages)', async () => {
  const pages = await pdfPages(sample('quotation-digital.pdf'));
  const rebuilt = reconstruct(pages);
  const repeated: string[] = [];
  const doc = finalizeBlocks(refineBlocks(rebuilt.blocks, repeated));
  const { blocks } = doc;

  it('reads positioned text from both pages', () => {
    expect(pages).toHaveLength(2);
    expect(pages[0].words.length).toBeGreaterThan(80);
    expect(pages.every((p) => !p.ocr)).toBe(true);
  });

  it("removes the sender's running header, footer and page numbers", () => {
    expect(rebuilt.removed).toContain('SRI VELAN ELECTRICALS');
    expect(rebuilt.removed.filter((l) => /Page \d of 2/.test(l))).toHaveLength(2);
    const text = docText(doc);
    expect(text).not.toContain('SRI VELAN ELECTRICALS');
    expect(text).not.toMatch(/Page \d of \d/);
    expect(text).not.toContain('GSTIN 33ABCDE1234F1Z5');
  });

  it('joins the table across the page break into one table with one header', () => {
    const tables = blocks.filter((b) => b.type === 'table');
    expect(tables).toHaveLength(1);
    const table = tables[0];
    expect(table.columns).toEqual(['S.No', 'Description', 'Qty', 'Rate (Rs)', 'Amount (Rs)']);
    expect(table.col_align).toEqual(['center', 'left', 'right', 'right', 'right']);
    expect(table.rows).toHaveLength(26);
    expect(table.rows[0]).toEqual(['1', 'LED Flood Light 100W', '10', '1,850.00', '18,500.00']);
    expect(table.rows[25]).toEqual(['26', 'Installation, testing and commissioning', '1', '18,500.00', '18,500.00']);
    expect(repeated).toEqual(['S.No Description Qty Rate (Rs) Amount (Rs)']);
  });

  it('recognises heading, reference details, bold text, totals, list and signature', () => {
    expect(blocks[0]).toMatchObject({ type: 'heading', text: 'QUOTATION', align: 'center' });
    expect(blocks.find((b) => b.type === 'meta')).toMatchObject({
      items: [
        { label: 'Ref No', value: 'Q/2026-27/046' },
        { label: 'Date', value: '17-11-2026' },
      ],
    });
    const subject = blocks.find((b) => b.type === 'paragraph' && b.runs[0].text.startsWith('Sub'));
    expect(subject?.type === 'paragraph' && subject.runs[0]).toMatchObject({ text: 'Sub:', bold: true });
    expect(blocks.find((b) => b.type === 'totals')).toMatchObject({
      items: [
        { label: 'Sub Total', value: '3,18,600.00' },
        { label: 'CGST 9%', value: '28,674.00' },
        { label: 'SGST 9%', value: '28,674.00' },
        { label: 'Grand Total', value: '3,75,948.00', bold: true },
      ],
    });
    expect(blocks.find((b) => b.type === 'list')).toMatchObject({ ordered: true, items: expect.arrayContaining(['Payment: 50% advance, balance on delivery.']) });
    expect(blocks[blocks.length - 1]).toMatchObject({ type: 'signature', lines: ['For Sri Velan Electricals', '', 'Authorised Signatory'], align: 'right' });
  });

  it('re-flows the wrapped paragraph but keeps the address lines', () => {
    const paragraphs = blocks.filter((b) => b.type === 'paragraph').map((p) => p.runs.map((r) => r.text).join(''));
    expect(paragraphs).toContain('To,\nThe Purchase Manager,\nKaveri Textile Mills Pvt Ltd,\nSIDCO Industrial Estate,\nCoimbatore - 641021');
    expect(paragraphs.some((p) => p.includes('lowest offer for the items listed below. We assure you'))).toBe(true);
  });

  it('loses no content (repeated table heading and header/footer are accounted for)', () => {
    const source = subtractTokens(rebuilt.sourceText, repeated.join(' '));
    const coverage = compareCoverage(source, docText(doc));
    expect(coverage.sourceCount).toBeGreaterThan(300);
    expect(coverage.missing).toEqual([]);
  });

  it('flags the one deliberately wrong amount (row 7) and the sub total that follows from it - and changes nothing', () => {
    const before = JSON.stringify(doc);
    const report = checkDocument(doc);
    expect(report.rowsChecked).toBe(26);
    expect(report.issues.map((i) => i.kind)).toEqual(['row', 'subtotal']);
    expect(report.issues[0]).toMatchObject({ row: 6, col: 4, expected: 9100, found: 9200 });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('needsOcr', () => {
  const base = { words: [], width: 595, height: 842, skipped: 0, rules: [] };
  it('sends pages without a usable text layer to OCR', () => {
    expect(needsOcr({ ...base, chars: 0, garbage: 0 })).toBe(true);
    expect(needsOcr({ ...base, chars: 12, garbage: 0 })).toBe(true);
    expect(needsOcr({ ...base, chars: 900, garbage: 0.6 })).toBe(true);
    expect(needsOcr({ ...base, chars: 900, garbage: 0.01 })).toBe(false);
  });

  it('treats the scanned sample as a scan (no text layer)', async () => {
    const pages = await pdfPages(sample('quotation-scanned.pdf'));
    expect(pages).toHaveLength(1);
    expect(pages[0].words).toHaveLength(0);
  });
});
