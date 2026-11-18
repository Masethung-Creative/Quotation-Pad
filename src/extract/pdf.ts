import type { PDFPageProxy } from 'pdfjs-dist';
import { rulesFromOperatorList, type Rule } from './rules';
import type { Word } from './types';

/** Digital PDF: pdf.js text items with positions -> words in page units (points, y downwards). */

type Matrix = number[];

const mul = (m1: Matrix, m2: Matrix): Matrix => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

export interface PdfPageText {
  words: Word[];
  width: number;
  height: number;
  /** Visible (non-space) characters in the text layer. */
  chars: number;
  /** Share of characters that are unmapped glyphs - a sign of a broken text layer. */
  garbage: number;
  /** Rotated text that was skipped (watermarks, vertical stamps). */
  skipped: number;
  /** Table lines drawn on the page. */
  rules: Rule[];
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  fontName: string;
}

export async function pageTextWords(page: PDFPageProxy): Promise<PdfPageText> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  // Real font names (for bold / italic) only exist after the operator list was built.
  let fontsReady = false;
  let rules: Rule[] = [];
  try {
    const ops = await page.getOperatorList();
    fontsReady = true;
    try {
      rules = rulesFromOperatorList(ops as unknown as { fnArray: number[]; argsArray: unknown[] }, viewport.transform);
    } catch {
      rules = [];
    }
  } catch {
    fontsReady = false;
  }
  const styleCache = new Map<string, { bold: boolean; italic: boolean }>();
  const styleOf = (fontName: string) => {
    const cached = styleCache.get(fontName);
    if (cached) return cached;
    let name = '';
    let flagBold = false;
    let flagItalic = false;
    if (fontsReady) {
      try {
        if (page.commonObjs.has(fontName)) {
          const font = page.commonObjs.get(fontName) as { name?: string; bold?: boolean; black?: boolean; italic?: boolean } | null;
          name = String(font?.name ?? '');
          flagBold = !!font?.bold || !!font?.black;
          flagItalic = !!font?.italic;
        }
      } catch {
        name = '';
      }
    }
    const family = (content.styles as Record<string, { fontFamily?: string }>)[fontName]?.fontFamily ?? '';
    const full = `${name} ${family}`;
    const style = {
      bold: flagBold || /bold|black|heavy|semibold|demi/i.test(full),
      italic: flagItalic || /italic|oblique/i.test(full),
    };
    styleCache.set(fontName, style);
    return style;
  };

  const words: Word[] = [];
  let chars = 0;
  let bad = 0;
  let skipped = 0;

  for (const raw of content.items) {
    if (!('str' in raw)) continue;
    const item = raw as unknown as TextItemLike;
    if (!item.str || !item.str.trim()) continue;
    const tx = mul(viewport.transform as Matrix, item.transform);
    const size = Math.hypot(tx[2], tx[3]);
    const angle = Math.atan2(tx[1], tx[0]);
    if (size <= 0 || Math.abs(angle) > 0.2) {
      skipped++;
      continue;
    }
    for (const ch of item.str) {
      const code = ch.codePointAt(0)!;
      if (code <= 32) continue;
      chars++;
      if (code === 0xfffd || (code >= 0xe000 && code <= 0xf8ff) || code < 9) bad++;
    }
    const { bold, italic } = styleOf(item.fontName);
    const x = tx[4];
    const base = tx[5];
    const width = item.width * viewport.scale;
    const y0 = base - size * 0.8;
    const y1 = base + size * 0.2;

    // One item that holds several columns separated by runs of spaces is split up.
    const parts = item.str.split(/(\s{3,})/);
    if (parts.length === 1) {
      words.push({ text: item.str, x0: x, x1: x + width, y0, y1, bold, italic });
      continue;
    }
    const per = width / Math.max(item.str.length, 1);
    let offset = 0;
    for (const part of parts) {
      if (part.trim()) words.push({ text: part, x0: x + offset * per, x1: x + (offset + part.length) * per, y0, y1, bold, italic });
      offset += part.length;
    }
  }

  return { words, width: viewport.width, height: viewport.height, chars, garbage: chars ? bad / chars : 0, skipped, rules };
}

/** A page needs OCR when it has (almost) no text layer or the layer is unreadable. */
export function needsOcr(page: PdfPageText): boolean {
  return page.chars < 30 || page.garbage > 0.3;
}
