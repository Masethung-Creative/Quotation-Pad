import { blockText, docText, type Block, type CanonicalDoc } from '@/schema/canonical';

/**
 * Invoice or quotation: the user picks one after uploading. It changes only the printed
 * title (and the file name); the letterhead and layout are the same for both.
 */

export type DocType = 'quotation' | 'invoice';

export const DOC_TYPES: Record<DocType, { label: string; title: string; file: string; hint: string }> = {
  quotation: { label: 'Quotation', title: 'QUOTATION', file: 'Quotation', hint: 'A price offer before the work or sale' },
  invoice: { label: 'Tax Invoice', title: 'TAX INVOICE', file: 'Invoice', hint: 'A bill for work done or goods supplied' },
};

/** Words that make a heading the document's title (as opposed to, say, a section heading). */
const TITLE_RE = /^\s*(tax\s+invoice|invoice|bill|bill\s+of\s+supply|cash\s+bill|proforma(\s+invoice)?|pro-forma(\s+invoice)?|quotation|quote|estimate|estimation|offer|price\s+list|proposal)\s*$/i;

/** The likely type, from the words near the top of the document. Quotation when unsure. */
export function guessDocType(doc: CanonicalDoc | null): DocType {
  if (!doc) return 'quotation';
  const head = docText({ ...doc, blocks: doc.blocks.slice(0, 8) }).slice(0, 800);
  // A proforma invoice is a price offer, not a bill.
  if (/\bpro-?\s?forma\b/i.test(head)) return 'quotation';
  if (/\b(tax\s+invoice|invoice|bill\s+of\s+supply|cash\s+bill)\b/i.test(head)) return 'invoice';
  return 'quotation';
}

/** Index of the block that is the document's title, or -1. */
export function titleIndex(blocks: Block[]): number {
  for (let i = 0; i < Math.min(blocks.length, 6); i++) {
    const b = blocks[i];
    if ((b.type === 'heading' || b.type === 'paragraph') && TITLE_RE.test(blockText(b))) return i;
  }
  return -1;
}

/** The original title text that the chosen type's title replaces ('' when nothing is replaced). */
export function replacedTitle(doc: CanonicalDoc | null, type: DocType | null | undefined): string {
  if (!doc || !type) return '';
  const at = titleIndex(doc.blocks);
  if (at < 0) return '';
  const text = blockText(doc.blocks[at]);
  return text.trim().toUpperCase() === DOC_TYPES[type].title ? '' : text;
}

/** The document with the chosen type's title: the existing title replaced, or one added on top. */
export function withDocTitle(doc: CanonicalDoc, type: DocType | null | undefined): CanonicalDoc {
  if (!type) return doc;
  const title = DOC_TYPES[type].title;
  const blocks = [...doc.blocks];
  const at = titleIndex(blocks);
  if (at >= 0) {
    const old = blocks[at];
    const align = old.type === 'heading' || old.type === 'paragraph' ? old.align : undefined;
    if (old.type === 'heading' && old.text === title) return doc;
    blocks[at] = { type: 'heading', text: title, level: 1, align: align && align !== 'justify' ? align : 'center' };
  } else {
    blocks.unshift({ type: 'heading', text: title, level: 1, align: 'center' });
  }
  return { ...doc, blocks };
}
