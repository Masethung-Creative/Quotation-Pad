// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { htmlToBlocks } from '@/extract/docx';
import { reconstruct } from '@/extract/reconstruct';
import { refineBlocks } from '@/extract/refine';
import { findGrids } from '@/extract/rules';
import { finalizeBlocks } from '@/extract/types';
import { buildDocDefinition, ownLetterheadBlocks } from '@/render/docdef';
import type { Block, CanonicalDoc } from '@/schema/canonical';
import { pdfPages, templateFromDisk } from './helpers';

globalThis.DOMParser ??= new JSDOM().window.DOMParser;

/**
 * A boxed invoice of the kind Excel / Tally exports: every part sits in a ruled box.
 *  [ To address        | Invoice details          ]
 *  [ Description | Category | SAC | Amount         ]   (header row)
 *  [ Service charge ... | Equipment ... |  | 38,092.09 ]
 *  [ PARTICULARS QTY UOM RATE AMOUNT  (tab-aligned, no inner lines) ]
 *  [ Total Amount      | 38,092.09                 ]
 *  [ (Rupees ... Only)  COMPANY  PROPRIETOR         ]
 */
async function boxedInvoice(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const H = 842;
  const box = (x0: number, top: number, x1: number, bottom: number) =>
    page.drawRectangle({ x: x0, y: H - bottom, width: x1 - x0, height: bottom - top, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  const text = (s: string, x: number, top: number, right = false) => {
    const w = font.widthOfTextAtSize(s, 10);
    page.drawText(s, { x: right ? x - w : x, y: H - top - 10, size: 10, font });
  };
  const L = 47.5;
  const M = 297.5;
  const R = 547.5;
  const c2 = 380.8;
  const c3 = 464.2;

  box(L, 150, M, 305);
  box(M, 150, R, 305);
  ['TO', 'M/s.KAVERI TEXTILE MILLS PVT LTD', 'PLOT NO. 14, SIPCOT ROAD', 'CHENNAI - 600 119', 'GST NO:33ABCDE1234F1Z5'].forEach((s, i) => text(s, L + 5, 160 + i * 17));
  ['TYPE: INVOICE', 'PO NUMBER:4500012345', 'INVOICE NO:338', 'INVOICE DATE:21-10-2026'].forEach((s, i) => text(s, M + 5, 170 + i * 17));

  box(L, 305, M, 345);
  box(M, 305, c2, 345);
  box(c2, 305, c3, 345);
  box(c3, 305, R, 345);
  text('Description', 140, 320);
  text('Category of', M + 8, 310);
  text('Service', M + 20, 327);
  text('SAC Code', c2 + 15, 320);
  text('Amount', c3 + 20, 320);

  box(L, 345, M, 404);
  box(M, 345, c2, 404);
  box(c2, 345, c3, 404);
  box(c3, 345, R, 404);
  text('MSP Sourcing Service Charge for', L + 3, 360);
  text('06.10.2026 to 15.10.2026', L + 3, 377);
  text('Equipment', M + 15, 350);
  text('Maintenance', M + 10, 367);
  text('Service', M + 20, 384);
  text('38,092.09', R - 8, 367, true);

  box(L, 404, R, 494);
  const cols = [L + 10, 230, 320, 430, R - 8];
  const tableRow = (cells: string[], top: number) =>
    cells.forEach((s, i) => (s ? text(s, i === 0 ? cols[0] : i === 2 ? cols[2] : cols[i] + (i === 4 ? 0 : 30), top, i !== 0 && i !== 2) : undefined));
  tableRow(['PARTICULARS', 'QTY', 'UOM', 'RATE', 'AMOUNT'], 410);
  tableRow(['HMB', '278', 'No', '115.66', '32,153.48'], 432);
  tableRow(['ABC', '17', 'No', '349.33', '5,938.61'], 454);
  text('Total', cols[0], 474);
  text('38,092.09', R - 8, 474, true);

  box(L, 494, M, 530);
  box(M, 494, R, 530);
  text('Total Amount', 130, 505);
  text('38,092.09', R - 8, 505, true);

  box(L, 530, R, 610);
  text('(Rupees Thirty Eight Thousand Ninety Two and Paise Nine Only)', L + 10, 540);
  text('MASS SERVICE TECH', L + 10, 556);
  text('PROPRIETOR', L + 10, 595);
  return pdf.save();
}

const strip = (doc: CanonicalDoc) => doc.blocks.map((b) => b.type);

describe('ruled boxes in a digital PDF', async () => {
  const pages = await pdfPages(await boxedInvoice());

  it('finds the drawn boxes', () => {
    const grids = findGrids(pages[0].rules ?? []);
    expect(grids).toHaveLength(1);
    expect(grids[0].cells).toHaveLength(2 + 4 + 4 + 1 + 2 + 1);
  });

  const doc = finalizeBlocks(refineBlocks(reconstruct(pages).blocks));
  const tables = doc.blocks.filter((b): b is Extract<Block, { type: 'table' }> => b.type === 'table');

  it('keeps the address box and the details box side by side', () => {
    expect(tables[0].columns).toEqual(['', '']);
    expect(tables[0].rows[0][0].split('\n')).toEqual(['TO', 'M/s.KAVERI TEXTILE MILLS PVT LTD', 'PLOT NO. 14, SIPCOT ROAD', 'CHENNAI - 600 119', 'GST NO:33ABCDE1234F1Z5']);
    expect(tables[0].rows[0][1].split('\n')[0]).toBe('TYPE: INVOICE');
  });

  it('reads a boxed table row whose cells wrap onto several lines as one row', () => {
    expect(tables[1].columns).toEqual(['Description', 'Category of Service', 'SAC Code', 'Amount']);
    expect(tables[1].rows).toEqual([['MSP Sourcing Service Charge for 06.10.2026 to 15.10.2026', 'Equipment Maintenance Service', '', '38,092.09']]);
    expect(tables[1].col_width?.map(Math.round)).toEqual([250, 83, 83, 83]);
  });

  it('reads the table typed inside one big box, and the totals', () => {
    expect(tables[2].columns).toEqual(['PARTICULARS', 'QTY', 'UOM', 'RATE', 'AMOUNT']);
    expect(tables[2].rows).toEqual([
      ['HMB', '278', 'No', '115.66', '32,153.48'],
      ['ABC', '17', 'No', '349.33', '5,938.61'],
    ]);
    const totals = doc.blocks.find((b) => b.type === 'totals');
    expect(totals).toMatchObject({
      items: [
        { label: 'Total', value: '38,092.09' },
        { label: 'Total Amount', value: '38,092.09' },
      ],
      amount_in_words: '(Rupees Thirty Eight Thousand Ninety Two and Paise Nine Only)',
    });
  });

  it('puts the company line above "Proprietor" into the signature', () => {
    expect(strip(doc)).toEqual(['table', 'table', 'table', 'totals', 'signature']);
    expect(doc.blocks[4]).toMatchObject({ type: 'signature', lines: ['MASS SERVICE TECH', '', 'PROPRIETOR'] });
  });

  it('keeps the source column widths when printing', async () => {
    const template = await templateFromDisk('mass-service-tech');
    const { definition } = buildDocDefinition(doc, template);
    const json = JSON.stringify(definition.content);
    const widths = [...json.matchAll(/"widths":\[([^\]]*)\]/g)].map((m) => m[1].split(',').map(Number));
    // Address | details: two equal halves, as in the source.
    expect(widths[0][0]).toBeCloseTo(widths[0][1], 0);
    // Description is three times as wide as each of the other columns.
    expect(widths[1][0] / widths[1][1]).toBeGreaterThan(2.5);
  });
});

describe('Word tables used for layout', () => {
  const html =
    '<table>' +
    '<tr><td><p>TO</p><p>M/s.ABC LTD</p></td><td colspan="3"><p>INVOICE NO:338</p></td></tr>' +
    '<tr><td><p>Description</p></td><td><p>Category of Service</p></td><td><p>SAC Code</p></td><td><p>Amount</p></td></tr>' +
    '<tr><td><p>Service charge</p></td><td><p>Maintenance</p></td><td></td><td><p>38,092.09</p></td></tr>' +
    '<tr><td colspan="4"><p>PARTICULARS\tQTY\tUOM\t\tRATE\t AMOUNT HMB\t\t278\t\tNo\t115.66\t32,153.48</p><p>ABC\t17\tNo\t349.33\t5,938.61</p><p>Total\t38,092.09</p></td></tr>' +
    '<tr><td><p>Total Amount</p></td><td colspan="3"><p>38,092.09</p></td></tr>' +
    '<tr><td colspan="4"><p>(Rupees Thirty Eight Thousand Ninety Two Only) MASS SERVICE TECH</p><p></p><p>PROPRIETOR</p></td></tr>' +
    '</table>';
  const doc = finalizeBlocks(refineBlocks(htmlToBlocks(html).blocks));

  it('splits the boxes into address pair, item table, tab table, totals and signature', () => {
    expect(strip(doc)).toEqual(['table', 'table', 'table', 'totals', 'signature']);
    expect(doc.blocks[0]).toMatchObject({ columns: ['', ''], rows: [['TO\nM/s.ABC LTD', 'INVOICE NO:338']] });
    expect(doc.blocks[1]).toMatchObject({ columns: ['Description', 'Category of Service', 'SAC Code', 'Amount'], rows: [['Service charge', 'Maintenance', '', '38,092.09']] });
  });

  it('rebuilds a table typed with tabs, even when its heading fused with the first row', () => {
    expect(doc.blocks[2]).toMatchObject({
      columns: ['PARTICULARS', 'QTY', 'UOM', 'RATE', 'AMOUNT'],
      rows: [
        ['HMB', '278', 'No', '115.66', '32,153.48'],
        ['ABC', '17', 'No', '349.33', '5,938.61'],
      ],
    });
    expect(doc.blocks[3]).toMatchObject({
      items: [
        { label: 'Total', value: '38,092.09' },
        { label: 'Total Amount', value: '38,092.09' },
      ],
      amount_in_words: '(Rupees Thirty Eight Thousand Ninety Two Only)',
    });
  });
});

describe("the company's own letterhead typed in the source", () => {
  it('is not printed a second time on its own template', async () => {
    const { def } = await templateFromDisk('mass-service-tech');
    const blocks: Block[] = [
      { type: 'paragraph', runs: [{ text: 'Thank you for your enquiry.' }], align: 'left' },
      { type: 'signature', lines: ['PROPRIETOR'], auto: true },
      { type: 'spacer', mm: 12 },
      { type: 'paragraph', runs: [{ text: 'MASS SERVICE TECH' }], align: 'center' },
      { type: 'paragraph', runs: [{ text: 'No.860/3 New Street, Solatharam, Srimushnam Taluk, Cuddalore District, Tamil Nadu – 608701' }], align: 'center' },
      { type: 'paragraph', runs: [{ text: 'Cell No 9677641647, 9003820867' }], align: 'center' },
      { type: 'paragraph', runs: [{ text: 'Email: massservicetech@gmail.com' }], align: 'center' },
    ];
    expect([...ownLetterheadBlocks(blocks, def)].sort()).toEqual([3, 4, 5, 6]);
    // A single mention of the company name in the text is left alone.
    expect(ownLetterheadBlocks(blocks.slice(0, 4), def).size).toBe(0);
  });
});
