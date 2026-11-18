import type { Rule } from './rules';
import type { Block, CanonicalDoc, LowConfidence } from '@/schema/canonical';

/** A positioned piece of text: a pdf.js text item or an OCR word. Units are page units, y grows downwards. */
export interface Word {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** OCR confidence 0..1. Undefined for text read directly from a file. */
  conf?: number;
  bold?: boolean;
  italic?: boolean;
}

export interface PageWords {
  width: number;
  height: number;
  words: Word[];
  /** True when the words came from OCR (looser geometry, per-word confidence). */
  ocr: boolean;
  /** Table lines drawn in a digital PDF (ruled boxes and grids). */
  rules?: Rule[];
}

/** Internal block with extraction bookkeeping that is stripped before saving. */
export type XBlock = Block & {
  _conf?: number;
  _low?: string[];
  _lowCells?: string[];
  /** Left indent as a fraction of the content width (helps place signatures). */
  _indent?: number;
  _page?: number;
  /** Word: the parts of a paragraph between tab stops (a table typed with tabs). */
  _cells?: string[];
};

export type ExtractMethod = 'docx' | 'pdf-text' | 'ocr' | 'pdf-mixed' | 'json';

export interface ExtractResult {
  doc: CanonicalDoc;
  /** Raw text of the source (after its own header/footer was removed) for the content-loss check. */
  sourceText: string;
  /** Lines dropped on purpose: the source's repeated header/footer and page numbers. */
  removed: string[];
  warnings: string[];
  method: ExtractMethod;
  /** Pages of the original (0 = not known, e.g. a Word file that does not record it). */
  pages: number;
}

export interface ExtractProgress {
  stage: 'reading' | 'ocr-load' | 'ocr' | 'structure';
  message: string;
  page?: number;
  pages?: number;
  /** 0..1 within the current stage (when known). */
  progress?: number;
}

export type ProgressFn = (p: ExtractProgress) => void;

export const LOW_CONFIDENCE = 0.7;

/** Strips the bookkeeping fields and builds the per-block confidence maps. */
export function finalizeBlocks(blocks: XBlock[]): CanonicalDoc {
  const confidence: Record<string, number> = {};
  const low: Record<string, LowConfidence> = {};
  const out: Block[] = [];
  blocks.forEach((xb, i) => {
    const { _conf, _low, _lowCells, _indent: _i, _page: _p, _cells: _c, ...block } = xb;
    void _c;
    void _i;
    void _p;
    out.push(block as Block);
    confidence[String(i)] = Math.round((_conf ?? 1) * 100) / 100;
    if ((_low && _low.length) || (_lowCells && _lowCells.length)) {
      low[String(i)] = {
        ...(_low && _low.length ? { words: [...new Set(_low)] } : {}),
        ...(_lowCells && _lowCells.length ? { cells: [...new Set(_lowCells)] } : {}),
      };
    }
  });
  return { blocks: out, confidence, ...(Object.keys(low).length ? { low_confidence: low } : {}) };
}
