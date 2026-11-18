// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { docxPageCount } from '@/extract/docx';
import { renderPdf } from '@/render/core';
import { buildDocDefinition, DENSITIES } from '@/render/docdef';
import type { Block, CanonicalDoc } from '@/schema/canonical';
import { loadFontFromDisk, pdfPageTexts, sample, templateFromDisk, toArrayBuffer } from './helpers';

const mass = await templateFromDisk('mass-service-tech');

/** A full one-page quotation: address, a 20-row item table, totals, terms and signature. */
function onePageQuotation(rows = 20): CanonicalDoc {
  const blocks: Block[] = [
    { type: 'heading', text: 'QUOTATION', level: 1, align: 'center' },
    { type: 'spacer', mm: 7 },
    { type: 'meta', items: [{ label: 'Ref No', value: 'Q/2026-27/046' }, { label: 'Date', value: '17-11-2026' }] },
    { type: 'paragraph', runs: [{ text: 'To,\nThe Purchase Manager,\nKaveri Textile Mills Pvt Ltd,\nSIDCO Industrial Estate,\nCoimbatore - 641021' }], align: 'left' },
    { type: 'paragraph', runs: [{ text: 'Sub: ', bold: true }, { text: 'Quotation for electrical items for the new weaving shed' }], align: 'left' },
    { type: 'paragraph', runs: [{ text: 'Dear Sir,\nWith reference to your enquiry dated 10-11-2026, we are pleased to submit our lowest offer for the items listed below.' }], align: 'left' },
    {
      type: 'table',
      columns: ['S.No', 'Description', 'Qty', 'Rate (Rs)', 'Amount (Rs)'],
      col_align: ['center', 'left', 'right', 'right', 'right'],
      rows: Array.from({ length: rows }, (_, i) => [String(i + 1), `Item number ${i + 1}`, '10', '1,850.00', '18,500.00']),
    },
    { type: 'totals', items: [{ label: 'Sub Total', value: '3,18,600.00' }, { label: 'CGST 9%', value: '28,674.00' }, { label: 'SGST 9%', value: '28,674.00' }, { label: 'Grand Total', value: '3,75,948.00', bold: true }] },
    { type: 'paragraph', runs: [{ text: 'Terms and Conditions:', bold: true }], align: 'left' },
    { type: 'list', ordered: true, items: ['Validity: 30 days from the date of quotation.', 'Payment: 50% advance, balance on delivery.', 'Delivery: Within 10 working days from the order.', 'Warranty: 12 months from the date of supply.'] },
    { type: 'spacer', mm: 5 },
    { type: 'signature', lines: [], auto: true },
  ];
  return { blocks, confidence: {} };
}

describe('a one-page quotation stays one page', () => {
  it('runs over at the normal spacing, and fits once the original page count is given', async () => {
    const doc = onePageQuotation();
    const loose = await renderPdf({ doc, template: mass }, loadFontFromDisk);
    expect(loose.pages).toBe(2);
    const fitted = await renderPdf({ doc, template: mass, fitPages: 1 }, loadFontFromDisk);
    expect(fitted.pages).toBe(1);
    expect(fitted.density).toBeGreaterThan(0);
    // Nothing lost, and the signature box is on that page.
    const [text] = await pdfPageTexts(fitted.pdf);
    for (const word of ['Item number 20', '3,75,948.00', 'Warranty', 'Authorised Signatory']) expect(text).toContain(word);
    expect(fitted.slot?.page).toBe(1);
  });

  it('keeps the normal spacing when the quotation already fits', async () => {
    const short = await renderPdf({ doc: onePageQuotation(0), template: mass, fitPages: 1 }, loadFontFromDisk);
    expect(short.pages).toBe(1);
    expect(short.density).toBe(0);
  });

  it('never leaves the signature alone on an extra page, even without the original page count', async () => {
    // Two items: at the normal spacing the signature block misses page 1 by a few points.
    const r = await renderPdf({ doc: onePageQuotation(2), template: mass }, loadFontFromDisk);
    expect(r.pages).toBe(1);
    expect(r.slot?.page).toBe(1);
  });

  it('without the original page count, only tightens spacing, never the text size', async () => {
    const r = await renderPdf({ doc: onePageQuotation(), template: mass, fitPages: 0 }, loadFontFromDisk);
    expect(r.density ?? 0).toBeLessThanOrEqual(1);
    expect(DENSITIES[r.density ?? 0].font).toBe(1);
  });

  it('never goes below about 8 pt for table text', () => {
    const { definition } = buildDocDefinition(onePageQuotation(), mass, { density: 99 });
    const sizes = [...JSON.stringify(definition.content).matchAll(/"fontSize":([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...sizes.filter((s) => s > 3))).toBeGreaterThanOrEqual(7.5);
  });
});

describe('boxes that follow each other', () => {
  it('print joined, as one ruled form, not as separate boxes with gaps', () => {
    const table = (cell: string): Block => ({ type: 'table', columns: ['A', 'B', 'C'], col_align: ['left', 'right', 'right'], rows: [[cell, '1', '2']] });
    const doc: CanonicalDoc = { blocks: [table('first'), table('second'), { type: 'paragraph', runs: [{ text: 'After' }], align: 'left' }], confidence: {} };
    const content = buildDocDefinition(doc, mass).definition.content as { table?: unknown; margin?: number[] }[];
    const tables = content.filter((c) => c.table);
    expect(tables[0].margin).toEqual([0, 0, 0, 0]);
    expect(tables[1].margin![3]).toBeGreaterThan(0);
  });
});

/** A minimal .docx-like zip holding docProps/app.xml (deflated, as Word writes it). */
function zipWith(name: string, text: string): ArrayBuffer {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const data = deflateRawSync(Buffer.from(text));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(text.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(text.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = 30 + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBytes.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  const all = Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
  return toArrayBuffer(new Uint8Array(all));
}

describe('page count of a Word file', () => {
  it('reads the page count Word saves in the file', async () => {
    expect(await docxPageCount(zipWith('docProps/app.xml', '<Properties><Pages>1</Pages><Words>250</Words></Properties>'))).toBe(1);
    expect(await docxPageCount(zipWith('docProps/app.xml', '<Properties><Pages>3</Pages></Properties>'))).toBe(3);
  });

  it('returns null when the file does not record it, or is not a zip', async () => {
    expect(await docxPageCount(toArrayBuffer(sample('quotation.docx')))).toBeNull();
    expect(await docxPageCount(new ArrayBuffer(10))).toBeNull();
  });
});
