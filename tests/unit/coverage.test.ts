import { describe, expect, it } from 'vitest';
import { docText, normaliseDoc, parseCanonical, type CanonicalDoc } from '@/schema/canonical';
import { asciiTokens, compareCoverage, tokenize } from '@/validate/coverage';
import { sample } from './helpers';

describe('tokenize', () => {
  it('splits words and numbers and ignores punctuation', () => {
    expect(tokenize('Ref No: Q/2026-27/045, Date: 17-11-2026')).toEqual(['ref', 'no', 'q', '2026', '27', '045', 'date', '17', '11', '2026']);
  });
  it('treats 1,25,000.00 and 125000.00 as the same number', () => {
    expect(tokenize('₹ 1,25,000.00')).toEqual(['125000.00']);
    expect(tokenize('Total 3,540.00.')).toEqual(['total', '3540.00']);
  });
  it('keeps Tamil and Hindi words whole', () => {
    expect(tokenize('நன்றி வணக்கம்')).toEqual(['நன்றி', 'வணக்கம்']);
    expect(tokenize('कुल राशि 500')).toEqual(['कुल', 'राशि', '500']);
  });
});

describe('compareCoverage', () => {
  it('reports nothing missing for identical content in a different order', () => {
    const r = compareCoverage('Sub Total 3,000.00 Grand Total 3,540.00', 'Grand Total 3,540.00\nSub Total 3,000.00');
    expect(r.missingCount).toBe(0);
    expect(r.warn).toBe(false);
  });
  it('counts repeated words (multiset)', () => {
    const r = compareCoverage('Total Total Total', 'Total');
    expect(r.missing).toEqual(['total', 'total']);
  });
  it('warns above 2% missing and stays quiet below', () => {
    const source = Array.from({ length: 100 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${'x'.repeat(i % 7)}q`).join(' ');
    const tokens = source.split(' ');
    expect(compareCoverage(source, tokens.slice(2).join(' ')).warn).toBe(false); // exactly 2%
    const three = compareCoverage(source, tokens.slice(3).join(' '));
    expect(three.missingCount).toBe(3);
    expect(three.warn).toBe(true);
  });
  it('notices a changed amount', () => {
    const r = compareCoverage('Grand Total 3,540.00', 'Grand Total 3,450.00');
    expect(r.missing).toEqual(['3540.00']);
  });
  it('handles empty input', () => {
    expect(compareCoverage('', 'anything').warn).toBe(false);
  });
});

describe('asciiTokens', () => {
  it('keeps only Latin words and numbers', () => {
    expect(asciiTokens('Total ₹ 500.00 நன்றி धन्यवाद')).toBe('total 500.00');
  });
});

describe('canonical schema', () => {
  const spec = JSON.parse(new TextDecoder().decode(sample('spec-example.json'))) as unknown;

  it('accepts the example from the specification', () => {
    const doc = parseCanonical(spec);
    expect(doc.blocks.map((b) => b.type)).toEqual(['heading', 'meta', 'paragraph', 'table', 'totals', 'list', 'signature', 'spacer']);
  });
  it('rejects unknown block types and malformed blocks', () => {
    expect(() => parseCanonical({ blocks: [{ type: 'video' }], confidence: {} })).toThrow();
    expect(() => parseCanonical({ blocks: [{ type: 'table', columns: 'x', rows: [] }] })).toThrow();
    expect(() => parseCanonical({ confidence: {} })).toThrow();
  });
  it('fills defaults and squares up ragged tables', () => {
    const doc = parseCanonical({ blocks: [{ type: 'table', columns: ['A', 'B'], rows: [['1'], ['1', '2', '3']] }] });
    const t = doc.blocks[0];
    expect(t.type === 'table' && t.columns).toEqual(['A', 'B', '']);
    expect(t.type === 'table' && t.rows).toEqual([
      ['1', '', ''],
      ['1', '2', '3'],
    ]);
    expect(doc.confidence).toEqual({});
  });
  it('includes list numbers and every cell in the document text', () => {
    const doc = normaliseDoc(parseCanonical(spec) as CanonicalDoc);
    const text = docText(doc);
    for (const piece of ['QUOTATION', 'Q/2026-27/045', 'Item description', '3,540.00', 'Rupees Three Thousand', '1. Validity: 30 days', '2. Payment: 50% advance', 'Authorised Signatory']) {
      expect(text).toContain(piece);
    }
  });
});
