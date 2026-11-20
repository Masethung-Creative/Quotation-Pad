import { z } from 'zod';

/**
 * Canonical content schema. Every input (Word, PDF, scan, photo) is converted to this,
 * and every output (PDF now, Word in Phase 2) is rendered from this.
 */

export type Align = 'left' | 'center' | 'right' | 'justify';

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface LabelValue {
  label: string;
  value: string;
}

export interface TotalsItem extends LabelValue {
  bold?: boolean;
}

export interface HeadingBlock {
  type: 'heading';
  text: string;
  level: 1 | 2 | 3;
  align: Align;
  /** Printed bold unless switched off (false). */
  bold?: boolean;
}
export interface MetaBlock {
  type: 'meta';
  items: LabelValue[];
}
export interface ParagraphBlock {
  type: 'paragraph';
  runs: Run[];
  align: Align;
}
export interface TableBlock {
  type: 'table';
  columns: string[];
  col_align: Align[];
  rows: string[][];
  /** Optional relative column widths taken from the source layout. */
  col_width?: number[];
}
export interface TotalsBlock {
  type: 'totals';
  items: TotalsItem[];
  amount_in_words?: string;
}
export interface ListBlock {
  type: 'list';
  ordered: boolean;
  items: string[];
}
export interface SignatureBlock {
  type: 'signature';
  lines: string[];
  align?: Align;
  /**
   * True = print the chosen company template's own signature block ("For <Company>",
   * signatory, designation) instead of `lines`. `lines` then keeps what the source said.
   */
  auto?: boolean;
}
export interface SpacerBlock {
  type: 'spacer';
  mm: number;
}

export type Block =
  | HeadingBlock
  | MetaBlock
  | ParagraphBlock
  | TableBlock
  | TotalsBlock
  | ListBlock
  | SignatureBlock
  | SpacerBlock;

export type BlockType = Block['type'];

/** Words and table cells that OCR was unsure about (below 70% confidence). */
export interface LowConfidence {
  words?: string[];
  /** Table cells as "row:col" (row -1 is the header row). */
  cells?: string[];
}

export interface CanonicalDoc {
  blocks: Block[];
  /** Block index -> confidence 0..1 (1 = read directly from text, lower = OCR). */
  confidence: Record<string, number>;
  /** Block index -> the specific words / cells that need a human look. */
  low_confidence?: Record<string, LowConfidence>;
}

const align = z.enum(['left', 'center', 'right', 'justify']);
const labelValue = z.object({ label: z.string(), value: z.string() });

const blockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    text: z.string(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
    align: align.default('center'),
    bold: z.boolean().optional(),
  }),
  z.object({ type: z.literal('meta'), items: z.array(labelValue) }),
  z.object({
    type: z.literal('paragraph'),
    runs: z.array(
      z.object({
        text: z.string(),
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        underline: z.boolean().optional(),
      }),
    ),
    align: align.default('left'),
  }),
  z.object({
    type: z.literal('table'),
    columns: z.array(z.string()),
    col_align: z.array(align).default([]),
    rows: z.array(z.array(z.string())),
    col_width: z.array(z.number()).optional(),
  }),
  z.object({
    type: z.literal('totals'),
    items: z.array(labelValue.extend({ bold: z.boolean().optional() })),
    amount_in_words: z.string().optional(),
  }),
  z.object({ type: z.literal('list'), ordered: z.boolean().default(false), items: z.array(z.string()) }),
  z.object({ type: z.literal('signature'), lines: z.array(z.string()), align: align.optional(), auto: z.boolean().optional() }),
  z.object({ type: z.literal('spacer'), mm: z.number().min(0).max(200) }),
]);

export const canonicalSchema = z.object({
  blocks: z.array(blockSchema),
  confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
  low_confidence: z
    .record(z.string(), z.object({ words: z.array(z.string()).optional(), cells: z.array(z.string()).optional() }))
    .optional(),
});

/** Validates unknown JSON and returns a normalised canonical document. Throws on invalid input. */
export function parseCanonical(json: unknown): CanonicalDoc {
  const doc = canonicalSchema.parse(json) as CanonicalDoc;
  return normaliseDoc(doc);
}

/** Makes every table rectangular so renderers never meet a ragged row. */
export function normaliseDoc(doc: CanonicalDoc): CanonicalDoc {
  return {
    ...doc,
    blocks: doc.blocks.map((b) => (b.type === 'table' ? normaliseTable(b) : b)),
  };
}

export function normaliseTable(t: TableBlock): TableBlock {
  const n = Math.max(t.columns.length, ...t.rows.map((r) => r.length), 1);
  const pad = <T,>(arr: T[], fill: T) => (arr.length >= n ? arr.slice(0, n) : [...arr, ...Array<T>(n - arr.length).fill(fill)]);
  return {
    ...t,
    columns: pad(t.columns, ''),
    col_align: pad(t.col_align ?? [], 'left' as Align),
    rows: t.rows.map((r) => pad(r, '')),
    col_width: t.col_width && t.col_width.length === n ? t.col_width : undefined,
  };
}

export function runsToText(runs: Run[]): string {
  return runs.map((r) => r.text).join('');
}

/** All human-visible text of a block, used for token coverage and search. */
export function blockText(b: Block): string {
  switch (b.type) {
    case 'heading':
      return b.text;
    case 'meta':
      return b.items.map((i) => `${i.label} ${i.value}`).join('\n');
    case 'paragraph':
      return runsToText(b.runs);
    case 'table':
      return [b.columns.join(' '), ...b.rows.map((r) => r.join(' '))].join('\n');
    case 'totals':
      return [...b.items.map((i) => `${i.label} ${i.value}`), b.amount_in_words ?? ''].join('\n');
    case 'list':
      // Ordered lists print their numbers, so the numbers count as output text too.
      return b.items.map((item, i) => (b.ordered ? `${i + 1}. ${item}` : item)).join('\n');
    case 'signature':
      return b.lines.join('\n');
    case 'spacer':
      return '';
  }
}

export function docText(doc: CanonicalDoc): string {
  return doc.blocks.map(blockText).join('\n');
}

export const BLOCK_LABEL: Record<BlockType, string> = {
  heading: 'Heading',
  meta: 'Reference details',
  paragraph: 'Text',
  table: 'Table',
  totals: 'Totals',
  list: 'List',
  signature: 'Signature',
  spacer: 'Space',
};
