import { blockText, type Block, type BlockType, type CanonicalDoc, type LowConfidence } from '@/schema/canonical';
import { uid } from '@/lib/utils';

/** Editor state: blocks get a stable id so React keeps focus while blocks are moved or removed. */

export interface EditorBlock {
  id: string;
  block: Block;
  confidence: number;
  low?: LowConfidence;
}

export function toEditor(doc: CanonicalDoc): EditorBlock[] {
  return doc.blocks.map((block, i) => ({
    id: uid(),
    block,
    confidence: doc.confidence[String(i)] ?? 1,
    low: doc.low_confidence?.[String(i)],
  }));
}

export function fromEditor(blocks: EditorBlock[]): CanonicalDoc {
  const confidence: Record<string, number> = {};
  const low: Record<string, LowConfidence> = {};
  blocks.forEach((b, i) => {
    confidence[String(i)] = b.confidence;
    if (b.low && ((b.low.words?.length ?? 0) > 0 || (b.low.cells?.length ?? 0) > 0)) low[String(i)] = b.low;
  });
  return { blocks: blocks.map((b) => b.block), confidence, ...(Object.keys(low).length ? { low_confidence: low } : {}) };
}

export function newBlock(type: BlockType): Block {
  switch (type) {
    case 'heading':
      return { type, text: 'QUOTATION', level: 1, align: 'center' };
    case 'meta':
      return { type, items: [{ label: 'Ref No', value: '' }, { label: 'Date', value: '' }] };
    case 'paragraph':
      return { type, runs: [{ text: '' }], align: 'left' };
    case 'table':
      return {
        type,
        columns: ['S.No', 'Description', 'Qty', 'Rate (Rs)', 'Amount (Rs)'],
        col_align: ['center', 'left', 'right', 'right', 'right'],
        rows: [['1', '', '', '', '']],
      };
    case 'totals':
      return { type, items: [{ label: 'Sub Total', value: '' }, { label: 'Grand Total', value: '', bold: true }] };
    case 'list':
      return { type, ordered: true, items: [''] };
    case 'signature':
      return { type, lines: ['For ', '', 'Authorised Signatory'], align: 'right' };
    case 'spacer':
      return { type, mm: 5 };
  }
}

/** How many words / cells of a block are still waiting for a human look. */
export function lowCount(b: EditorBlock): number {
  return (b.low?.words?.length ?? 0) + (b.low?.cells?.length ?? 0);
}

/** Keeps only the flagged words that are still present in the text. */
export function pruneLowWords(low: LowConfidence | undefined, text: string): LowConfidence | undefined {
  if (!low?.words?.length) return low;
  const words = low.words.filter((w) => text.includes(w));
  return { ...low, words };
}

const TITLE_RE = /^\W*(quotation|quote|estimate|pro-?forma(\s+invoice)?|offer|proposal|price\s+list)\W*$/i;

/**
 * A one-page scan carries the sender's own letterhead as ordinary text (company name,
 * address line) above the "QUOTATION" title. Returns how many leading parts look like
 * that, so the review screen can offer to remove them. 0 = nothing to suggest.
 */
export function senderLetterhead(blocks: EditorBlock[]): number {
  const title = blocks.findIndex((b) => b.block.type === 'heading' && TITLE_RE.test(b.block.text));
  if (title < 1 || title > 5) return 0;
  const before = blocks.slice(0, title);
  const textual = before.every((b) => b.block.type === 'heading' || b.block.type === 'paragraph' || b.block.type === 'spacer');
  const short = before.reduce((n, b) => n + blockText(b.block).length, 0) <= 400;
  const hasText = before.some((b) => blockText(b.block).trim() !== '');
  return textual && short && hasText ? title : 0;
}
