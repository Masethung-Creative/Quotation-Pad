import { describe, expect, it } from 'vitest';
import { docxToHtml, finishDocx, htmlToBlocks } from '@/extract/docx';
import { docText } from '@/schema/canonical';
import { compareCoverage } from '@/validate/coverage';
import { checkDocument } from '@/validate/totals';
import { sample, toArrayBuffer } from './helpers';

describe('Word extractor on samples/quotation.docx', async () => {
  const html = await docxToHtml(toArrayBuffer(sample('quotation.docx')));
  const result = finishDocx(html);
  const { blocks } = result.doc;
  const find = <T extends (typeof blocks)[number]['type']>(type: T) => blocks.find((b) => b.type === type) as Extract<(typeof blocks)[number], { type: T }> | undefined;

  it('carries paragraph alignment through mammoth', () => {
    expect(html.html).toContain('qp-center');
    expect(html.html).toContain('qp-right');
    expect(html.html).toContain('qp-both');
  });

  it('finds heading, reference details, table, totals, list and signature', () => {
    expect(blocks.map((b) => b.type).filter((t) => t !== 'spacer' && t !== 'paragraph')).toEqual(['heading', 'meta', 'table', 'totals', 'list', 'signature']);
    expect(find('heading')).toMatchObject({ text: 'QUOTATION', level: 1, align: 'center' });
    expect(find('meta')?.items).toEqual([
      { label: 'Ref No', value: 'Q/2026-27/045' },
      { label: 'Date', value: '17-11-2026' },
    ]);
  });

  it('keeps the address as one block of lines', () => {
    const address = blocks.find((b) => b.type === 'paragraph');
    expect(address?.type === 'paragraph' && address.runs.map((r) => r.text).join('')).toBe(
      'To,\nThe Purchase Manager,\nKaveri Textile Mills Pvt Ltd,\nSIDCO Industrial Estate,\nCoimbatore - 641021',
    );
  });

  it('keeps bold, italic, underline and justification', () => {
    const paragraphs = blocks.filter((b) => b.type === 'paragraph');
    const subject = paragraphs.find((p) => p.runs.some((r) => r.text.startsWith('Sub')));
    expect(subject?.runs).toEqual([
      { text: 'Sub: ', bold: true, italic: false, underline: false },
      { text: 'Quotation for supply of electrical items', bold: false, italic: false, underline: true },
    ]);
    const body = paragraphs.find((p) => p.align === 'justify');
    expect(body?.runs.find((r) => r.bold)?.text).toBe('best prices');
    expect(body?.runs.find((r) => r.italic)?.text).toBe('ISI marked');
  });

  it('reads the table and moves the totals rows out of it', () => {
    const table = find('table');
    expect(table?.columns).toEqual(['S.No', 'Description', 'Qty', 'Rate (Rs)', 'Amount (Rs)']);
    expect(table?.col_align).toEqual(['center', 'left', 'right', 'right', 'right']);
    expect(table?.rows).toHaveLength(15);
    expect(table?.rows[4]).toEqual(['5', 'Copper Cable 2.5 sq.mm (90 m coil)', '6', '3,150.00', '18,900.00']);
    expect(table?.rows[14]).toEqual(['15', 'Installation and testing charges', '1', '7,500.00', '7,500.00']);
    expect(find('totals')).toMatchObject({
      items: [
        { label: 'Sub Total', value: '1,94,210.00' },
        { label: 'CGST 9%', value: '17,478.90' },
        { label: 'SGST 9%', value: '17,478.90' },
        { label: 'Grand Total', value: '2,29,167.80', bold: true },
      ],
      amount_in_words: 'Amount in words: Rupees Two Lakh Twenty Nine Thousand One Hundred Sixty Seven and Paise Eighty Only',
    });
  });

  it('reads the numbered terms, Tamil and Hindi text, and the signature', () => {
    expect(find('list')).toMatchObject({ ordered: true });
    expect(find('list')?.items).toHaveLength(4);
    const text = docText(result.doc);
    expect(text).toContain('நன்றி. உங்கள் ஆர்டரை எதிர்பார்க்கிறோம்.');
    expect(text).toContain('धन्यवाद। हमें आपके आदेश की प्रतीक्षा है।');
    expect(find('signature')).toMatchObject({ lines: ['For Sri Velan Electricals', '', 'Authorised Signatory'], align: 'right' });
  });

  it('loses no content and the amounts add up', () => {
    const coverage = compareCoverage(result.sourceText, docText(result.doc));
    expect(coverage.sourceCount).toBeGreaterThan(150);
    expect(coverage.missing).toEqual([]);
    const report = checkDocument(result.doc);
    expect(report.issues).toEqual([]);
    expect(report.rowsChecked).toBe(15);
  });
});

describe('htmlToBlocks', () => {
  it('handles merged cells, header cells and multi-paragraph cells', () => {
    const { blocks } = htmlToBlocks(
      '<table><thead><tr><th><p>Item</p></th><th><p>Qty</p></th><th><p>Amount</p></th></tr></thead>' +
        '<tr><td><p>Pump</p><p>with motor</p></td><td><p>2</p></td><td><p>500.00</p></td></tr>' +
        '<tr><td colspan="2"><p>Remarks: as discussed</p></td><td><p>-</p></td></tr></table>',
    );
    expect(blocks).toEqual([
      {
        type: 'table',
        columns: ['Item', 'Qty', 'Amount'],
        col_align: ['left', 'right', 'left'],
        rows: [
          ['Pump\nwith motor', '2', '500.00'],
          ['Remarks: as discussed', '', '-'],
        ],
      },
    ]);
  });

  it('turns empty paragraphs into a spacer and bullet lists into unordered lists', () => {
    const { blocks } = htmlToBlocks('<p>One</p><p></p><p></p><ul><li>First</li><li>Second</li></ul>');
    expect(blocks).toEqual([
      { type: 'paragraph', runs: [{ text: 'One', bold: false, italic: false, underline: false }], align: 'left' },
      { type: 'spacer', mm: 8 },
      { type: 'list', ordered: false, items: ['First', 'Second'] },
    ]);
  });

  it('counts pictures that cannot be copied', () => {
    const res = htmlToBlocks('<p>Logo <img src="" /></p>');
    expect(res.images).toBe(1);
    expect(finishDocx({ html: '<p>Logo <img src="" /></p>', messages: [] }).warnings[0]).toMatch(/1 picture/);
  });

  it('promotes a bold centred "QUOTATION" line to the heading when no heading style is used', () => {
    const { blocks } = htmlToBlocks('<p class="qp-center"><strong>QUOTATION</strong></p><p>Dear Sir,</p>');
    expect(blocks[0]).toEqual({ type: 'heading', text: 'QUOTATION', level: 1, align: 'center' });
  });

  it('escapes nothing and loses nothing with special characters', () => {
    const { blocks, text } = htmlToBlocks('<p>Rate &lt; ₹ 1,25,000.00 &amp; tax @ 18%</p>');
    expect(blocks[0]).toMatchObject({ runs: [{ text: 'Rate < ₹ 1,25,000.00 & tax @ 18%' }] });
    expect(text).toContain('₹ 1,25,000.00');
  });
});
