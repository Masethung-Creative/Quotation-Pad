import { describe, expect, it } from 'vitest';
import { currentDoc, outputFileName } from '@/pipeline/convert';
import { guessDocType, replacedTitle, withDocTitle } from '@/pipeline/docType';
import type { Conversion } from '@/db/db';
import type { Block, CanonicalDoc } from '@/schema/canonical';
import { templateSchema } from '@/templates/schema';

const doc = (blocks: Block[]): CanonicalDoc => ({ blocks, confidence: {} });
const heading = (text: string): Block => ({ type: 'heading', text, level: 1, align: 'center' });
const para = (text: string): Block => ({ type: 'paragraph', runs: [{ text }], align: 'left' });
const meta: Block = { type: 'meta', items: [{ label: 'Bill No', value: '334' }] };

describe('guessing invoice or quotation', () => {
  it('reads the title and the words near the top', () => {
    expect(guessDocType(doc([heading('TAX INVOICE'), meta]))).toBe('invoice');
    expect(guessDocType(doc([para('Invoice No: 338'), para('To, ABC Ltd')]))).toBe('invoice');
    expect(guessDocType(doc([heading('QUOTATION'), para('Dear Sir,')]))).toBe('quotation');
    expect(guessDocType(doc([heading('ESTIMATE')]))).toBe('quotation');
  });

  it('treats a proforma invoice as a quotation, and is a quotation when unsure', () => {
    expect(guessDocType(doc([heading('PROFORMA INVOICE')]))).toBe('quotation');
    expect(guessDocType(doc([para('To, ABC Ltd')]))).toBe('quotation');
    expect(guessDocType(null)).toBe('quotation');
  });

  it('does not look for the word far down the page (terms mentioning an invoice)', () => {
    const blocks: Block[] = [heading('QUOTATION'), ...Array.from({ length: 10 }, () => para('Item line')), para('Payment within 30 days of invoice.')];
    expect(guessDocType(doc(blocks))).toBe('quotation');
  });
});

describe('the chosen title', () => {
  it('replaces the existing title, keeping its alignment', () => {
    const out = withDocTitle(doc([{ type: 'heading', text: 'Quotation', level: 1, align: 'left' }, meta]), 'invoice');
    expect(out.blocks[0]).toEqual({ type: 'heading', text: 'TAX INVOICE', level: 1, align: 'left' });
    expect(out.blocks).toHaveLength(2);
  });

  it('turns a title typed as a plain line into the heading', () => {
    const out = withDocTitle(doc([para('INVOICE'), meta]), 'quotation');
    expect(out.blocks[0]).toMatchObject({ type: 'heading', text: 'QUOTATION' });
    expect(out.blocks).toHaveLength(2);
  });

  it('adds a title on top when the document has none', () => {
    const out = withDocTitle(doc([para('To, ABC Ltd'), meta]), 'invoice');
    expect(out.blocks[0]).toMatchObject({ type: 'heading', text: 'TAX INVOICE', align: 'center' });
    expect(out.blocks).toHaveLength(3);
  });

  it('leaves other headings and an unchosen type alone', () => {
    const d = doc([heading('Terms and Conditions')]);
    expect(withDocTitle(d, 'quotation').blocks.map((b) => (b.type === 'heading' ? b.text : ''))).toEqual(['QUOTATION', 'Terms and Conditions']);
    expect(withDocTitle(d, null)).toBe(d);
  });

  it('reports the replaced title so the content check does not call it a lost word', () => {
    expect(replacedTitle(doc([heading('QUOTATION')]), 'invoice')).toBe('QUOTATION');
    expect(replacedTitle(doc([heading('QUOTATION')]), 'quotation')).toBe('');
    expect(replacedTitle(doc([para('To,')]), 'invoice')).toBe('');
  });

  it('is applied to what was read, but never overrides the user\'s own edits', () => {
    const base = { extracted_json: doc([heading('QUOTATION'), meta]), edited_json: null, doc_type: 'invoice' } as unknown as Conversion;
    expect(currentDoc(base)!.blocks[0]).toMatchObject({ text: 'TAX INVOICE' });
    const edited = { ...base, edited_json: doc([heading('My own title'), meta]) } as Conversion;
    expect(currentDoc(edited)!.blocks[0]).toMatchObject({ text: 'My own title' });
  });
});

describe('download name with the type', () => {
  const def = templateSchema.parse({
    id: 'acme',
    display_name: 'Acme Traders',
    company: { name: 'Acme Traders' },
    first_page: { header: [], footer: [], safe_area_mm: { top: 40, bottom: 20, left: 15, right: 15 } },
  });

  it('says Invoice or Quotation between the number and the letterpad name', () => {
    expect(outputFileName(def, doc([meta]), 0, 'invoice')).toBe('334 - Invoice - Acme Traders.pdf');
    expect(outputFileName(def, doc([meta]), 0, 'quotation')).toBe('334 - Quotation - Acme Traders.pdf');
    expect(outputFileName(def, doc([meta]), 0)).toBe('334 - Acme Traders.pdf');
  });
});
