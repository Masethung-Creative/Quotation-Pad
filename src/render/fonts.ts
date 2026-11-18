/** Fonts that can be embedded in output PDFs, and the one metric layout needs from them. */

export interface FontFiles {
  normal: string;
  bold: string;
  italics: string;
  bolditalics: string;
}

/** Families shipped in /public/fonts (SIL Open Font License). */
export const BUILTIN_FONTS: Record<string, FontFiles> = {
  NotoSans: {
    normal: 'NotoSans-Regular.ttf',
    bold: 'NotoSans-Bold.ttf',
    italics: 'NotoSans-Italic.ttf',
    bolditalics: 'NotoSans-BoldItalic.ttf',
  },
  // Same letter widths as Arial / Helvetica: the usual letterhead fonts.
  LiberationSans: {
    normal: 'LiberationSans-Regular.ttf',
    bold: 'LiberationSans-Bold.ttf',
    italics: 'LiberationSans-Italic.ttf',
    bolditalics: 'LiberationSans-BoldItalic.ttf',
  },
  NotoSansTamil: {
    normal: 'NotoSansTamil-Regular.ttf',
    bold: 'NotoSansTamil-Bold.ttf',
    italics: 'NotoSansTamil-Regular.ttf',
    bolditalics: 'NotoSansTamil-Bold.ttf',
  },
  NotoSansDevanagari: {
    normal: 'NotoSansDevanagari-Regular.ttf',
    bold: 'NotoSansDevanagari-Bold.ttf',
    italics: 'NotoSansDevanagari-Regular.ttf',
    bolditalics: 'NotoSansDevanagari-Bold.ttf',
  },
};

/** hhea ascender per 1000 units of em, for the built-in files (checked by a unit test). */
export const BUILTIN_ASCENDER: Record<string, number> = {
  'NotoSans-Regular.ttf': 1069,
  'NotoSans-Bold.ttf': 1069,
  'NotoSans-Italic.ttf': 1069,
  'NotoSans-BoldItalic.ttf': 1069,
  'LiberationSans-Regular.ttf': 905.2734375,
  'LiberationSans-Bold.ttf': 905.2734375,
  'LiberationSans-Italic.ttf': 905.2734375,
  'LiberationSans-BoldItalic.ttf': 905.2734375,
};

/**
 * Reads the hhea ascender of a TrueType/OpenType font, scaled to 1000 units per em.
 * pdfmake (pdfkit + fontkit) places a text line's baseline exactly this far below its top,
 * which is what lets a template put text on an exact baseline.
 */
export function readAscender(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = view.getUint16(4);
  let head = -1;
  let hhea = -1;
  for (let i = 0; i < tables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
    const offset = view.getUint32(rec + 8);
    if (tag === 'head') head = offset;
    if (tag === 'hhea') hhea = offset;
  }
  if (head < 0 || hhea < 0) throw new Error('Not a TrueType/OpenType font');
  const unitsPerEm = view.getUint16(head + 18);
  const ascender = view.getInt16(hhea + 4);
  return (ascender * 1000) / unitsPerEm;
}
