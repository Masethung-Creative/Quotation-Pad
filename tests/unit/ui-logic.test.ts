import { describe, expect, it } from 'vitest';
import { matchPath } from '@/lib/router';
import { fromEditor, pruneLowWords, senderLetterhead, toEditor } from '@/review/model';
import { htmlToRuns, runsToHtml } from '@/review/RichText';
import type { CanonicalDoc } from '@/schema/canonical';

describe('router', () => {
  it('matches patterns and decodes parameters', () => {
    expect(matchPath('/review/:id', '/review/abc-123')).toEqual({ id: 'abc-123' });
    expect(matchPath('/template/:id', '/template/a%20b')).toEqual({ id: 'a b' });
    expect(matchPath('/', '/')).toEqual({});
    expect(matchPath('/review/:id', '/review')).toBeNull();
    expect(matchPath('/review/:id', '/done/abc')).toBeNull();
    expect(matchPath('/review/:id', '/review/%E0%A4%A')).toBeNull();
  });
});

describe('rich text <-> runs', () => {
  it('round-trips bold, italic, underline and line breaks', () => {
    const runs = [
      { text: 'Sub: ', bold: true, italic: false, underline: false },
      { text: 'Quotation\nfor items', bold: false, italic: true, underline: true },
    ];
    const el = document.createElement('div');
    el.innerHTML = runsToHtml(runs).replace(/\n/g, '<br>');
    expect(htmlToRuns(el)).toEqual(runs);
  });

  it('escapes HTML so typed text can never become markup', () => {
    const html = runsToHtml([{ text: '<img src=x onerror=alert(1)> & co' }]);
    expect(html).toBe('&lt;img src=x onerror=alert(1)&gt; &amp; co');
  });

  it('marks low-confidence words in amber without changing the text', () => {
    const html = runsToHtml([{ text: 'Total 1,850.00 only' }], ['1,850.00']);
    expect(html).toBe('Total <mark class="flag">1,850.00</mark> only');
    const el = document.createElement('div');
    el.innerHTML = html;
    expect(htmlToRuns(el)[0].text).toBe('Total 1,850.00 only');
  });

  it('reads browser line breaks made with div / p', () => {
    const el = document.createElement('div');
    el.innerHTML = 'To,<div>The Manager</div><div><br></div>';
    expect(htmlToRuns(el).map((r) => r.text).join('')).toBe('To,\nThe Manager');
  });
});

describe('editor model', () => {
  const doc: CanonicalDoc = {
    blocks: [
      { type: 'heading', text: 'SRI VELAN ELECTRICALS', level: 1, align: 'center' },
      { type: 'paragraph', runs: [{ text: 'No. 14, Gandhi Road, Erode' }], align: 'center' },
      { type: 'heading', text: 'QUOTATION', level: 1, align: 'center' },
      { type: 'paragraph', runs: [{ text: 'To,' }], align: 'left' },
    ],
    confidence: { '0': 0.9, '1': 0.95, '2': 1, '3': 1 },
    low_confidence: { '1': { words: ['14,'] } },
  };

  it('round-trips a document, keeping confidence and amber words', () => {
    expect(fromEditor(toEditor(doc))).toEqual(doc);
  });

  it("offers to remove the sender's letterhead above the QUOTATION title", () => {
    expect(senderLetterhead(toEditor(doc))).toBe(2);
    expect(senderLetterhead(toEditor({ ...doc, blocks: doc.blocks.slice(2) }))).toBe(0);
    const tableFirst: CanonicalDoc = { blocks: [{ type: 'table', columns: ['A'], col_align: ['left'], rows: [] }, doc.blocks[2]], confidence: {} };
    expect(senderLetterhead(toEditor(tableFirst))).toBe(0);
  });

  it('forgets amber words once they are edited away', () => {
    expect(pruneLowWords({ words: ['14,', 'Erode'] }, 'No. 15, Gandhi Road, Erode')).toEqual({ words: ['Erode'] });
  });
});

describe('phone item form', async () => {
  const { amountColumnOf, describingColumn, rowCheck } = await import('@/review/ItemList');
  const table = {
    type: 'table' as const,
    columns: ['S.No', 'Description', 'Qty', 'UOM', 'Rate', 'Amount'],
    col_align: [],
    rows: [
      ['1', 'MCB 32A Double Pole', '24', 'Nos', '420.00', '10,080.00'],
      ['2', 'Distribution Board 8 Way', '4', 'Nos', '2,275.00', '9,200.00'],
    ],
  };

  it('describes each item by its text column and shows its amount', () => {
    expect(describingColumn(table)).toBe(1);
    expect(amountColumnOf(table)).toBe(5);
  });

  it('checks Qty x Rate against the written amount, never changing it', () => {
    expect(rowCheck(table, 0)).toEqual({ ok: true, text: '24 × 420.00 = 10,080.00' });
    expect(rowCheck(table, 1)).toEqual({ ok: false, text: '4 × 2,275.00 = 9,100.00 (written: 9,200.00)' });
    expect(table.rows[1][5]).toBe('9,200.00');
  });

  it('skips the check when there is no quantity / rate, or discounts and taxes change the amount', () => {
    expect(rowCheck({ ...table, columns: ['S.No', 'Description', 'A', 'UOM', 'B', 'Amount'] }, 0)).toBeNull();
    expect(rowCheck({ ...table, columns: ['S.No', 'Description', 'Qty', 'Disc %', 'Rate', 'Amount'], rows: [['1', 'X', '2', '10', '100.00', '180.00']] }, 0)).toBeNull();
  });
});
