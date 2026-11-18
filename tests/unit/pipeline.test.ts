import { describe, expect, it } from 'vitest';
import { IngestError } from '@/ingest/detect';
import { classifyError, friendlyError, LowMemoryError } from '@/lib/errors';
import { customerName, filePart, outputFileName, quotationDate, referenceNumber, renderKey, withTemplateSignature } from '@/pipeline/convert';
import type { CanonicalDoc } from '@/schema/canonical';
import { templateSchema } from '@/templates/schema';

const doc = (blocks: CanonicalDoc['blocks']): CanonicalDoc => ({ blocks, confidence: {} });
const para = (text: string) => ({ type: 'paragraph' as const, runs: [{ text }], align: 'left' as const });

const def = templateSchema.parse({
  id: 'acme',
  display_name: 'Acme Traders',
  file_prefix: 'Acme',
  company: { name: 'ACME TRADERS' },
  first_page: { safe_area_mm: { top: 40, right: 15, bottom: 25, left: 18 } },
});

describe('signature block from the template', () => {
  it("switches a found signature block to the template's own, keeping the source lines", () => {
    const out = withTemplateSignature(doc([para('Hello'), { type: 'signature', lines: ['For Other Co', '', 'Manager'] }]));
    expect(out.blocks[1]).toEqual({ type: 'signature', lines: ['For Other Co', '', 'Manager'], auto: true });
  });
  it('adds one at the end when the source has none', () => {
    const out = withTemplateSignature(doc([para('Hello')]));
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks[1]).toEqual({ type: 'signature', lines: [], auto: true });
  });
  it('leaves a block the user wrote alone', () => {
    const out = withTemplateSignature(doc([{ type: 'signature', lines: ['Custom'], auto: false }]));
    expect(out.blocks[0]).toEqual({ type: 'signature', lines: ['Custom'], auto: false });
  });
});

describe('file name: <template>_<customer or ref>_<DD-MM-YYYY>.pdf', () => {
  const quote = doc([
    { type: 'heading', text: 'QUOTATION', level: 1, align: 'center' },
    { type: 'meta', items: [{ label: 'Ref No', value: 'Q/2026-27/045' }, { label: 'Date', value: '17/11/2026' }] },
    para('To,\nThe Purchase Manager,\nKaveri Textile Mills Pvt Ltd,\nSIDCO Industrial Estate,\nCoimbatore - 641021'),
  ]);

  it('finds the customer in the "To," address, skipping the job title', () => {
    expect(customerName(quote)).toBe('Kaveri Textile Mills Pvt Ltd');
    expect(customerName(doc([para('To,\nM/s. Sree Murugan Stores,\nSalem')]))).toBe('Sree Murugan Stores');
    expect(customerName(doc([para('To\nRavi Kumar\nMadurai')]))).toBe('Ravi Kumar');
    expect(customerName(doc([para('Dear Sir,')]))).toBeNull();
  });

  it('reads the reference number and the date in any common format', () => {
    expect(referenceNumber(quote)).toBe('Q/2026-27/045');
    expect(quotationDate(quote)).toBe('17-11-2026');
    const d = (value: string) => quotationDate(doc([{ type: 'meta', items: [{ label: 'Date', value }] }]));
    expect(d('5.1.27')).toBe('05-01-2027');
    expect(d('17 Nov 2026')).toBe('17-11-2026');
    expect(d('3rd January, 2027')).toBe('03-01-2027');
    expect(d('soon')).toBeNull();
  });

  it('builds the name from template, customer (or ref) and date', () => {
    expect(outputFileName(def, quote, Date.UTC(2026, 10, 18))).toBe('Acme_Kaveri-Textile-Mills-Pvt-Ltd_17-11-2026.pdf');
    const refOnly = doc([{ type: 'meta', items: [{ label: 'Quotation No', value: 'Q/2026-27/046' }] }]);
    expect(outputFileName(def, refOnly, new Date(2026, 10, 18).getTime())).toBe('Acme_Q-2026-27-046_18-11-2026.pdf');
    expect(outputFileName(def, doc([]), new Date(2026, 10, 18).getTime())).toBe('Acme_Quotation_18-11-2026.pdf');
  });

  it('makes safe file-name parts, keeping Tamil and Hindi letters', () => {
    expect(filePart('  A/B: "C" <D>  ')).toBe('A-B-C-D');
    expect(filePart('ஸ்ரீ முருகன்')).toBe('ஸ்ரீ-முருகன்');
    expect(filePart('x'.repeat(80)).length).toBe(40);
  });
});

describe('render cache key', () => {
  it('changes when the text or the template changes, and only then', () => {
    const a = doc([para('One')]);
    expect(renderKey(a, 't1')).toBe(renderKey(doc([para('One')]), 't1'));
    expect(renderKey(a, 't1')).not.toBe(renderKey(doc([para('One!')]), 't1'));
    expect(renderKey(a, 't1')).not.toBe(renderKey(a, 't2'));
  });
});

describe('plain-English errors with the right "Try again"', () => {
  const kind = (err: unknown) => classifyError(err);
  it('recognises every error the brief lists', () => {
    expect(kind(new IngestError('too-large', 'This file is 25.0 MB. The limit is 20 MB.'))).toBe('too-large');
    expect(kind(new IngestError('legacy-doc', 'Please save this as .docx or PDF and upload again.'))).toBe('legacy-doc');
    expect(kind(Object.assign(new Error('No password given'), { name: 'PasswordException' }))).toBe('password');
    expect(kind(Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }))).toBe('unreadable');
    expect(kind(new Error("Can't find end of central directory : is this a zip file ?"))).toBe('unreadable');
    expect(kind(new LowMemoryError())).toBe('memory');
    expect(kind(new RangeError('Array buffer allocation failed'))).toBe('memory');
    expect(kind('RuntimeError: abort(OOM). Build with -sASSERTIONS for more info.')).toBe('memory');
    expect(kind(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }))).toBe('storage');
    expect(kind(new Error('something odd'))).toBe('unknown');
  });

  it('gives a message and a retry action for each', () => {
    const memory = friendlyError(new LowMemoryError());
    expect(memory.retry).toBe('low-memory');
    expect(memory.title).toMatch(/memory/i);
    const big = friendlyError(new IngestError('too-large', 'This file is 25.0 MB. The limit is 20 MB.'));
    expect(big.message).toContain('25.0 MB');
    expect(big.retry).toBe('pick');
    expect(friendlyError(new IngestError('legacy-doc', 'x')).message).toBe('Please save this as .docx or PDF and upload again.');
    expect(friendlyError(Object.assign(new Error('x'), { name: 'PasswordException' })).message).toMatch(/without a password/);
  });
});
