/**
 * A Word letterpad keeps a placeholder such as "{@body}" in its body. When the letterpad is
 * saved as PDF, that placeholder is printed on the page. These helpers find it in the PDF's
 * text so it can be covered with paper white before the quotation is drawn on top.
 */

/** A box as fractions of the page (0..1), origin top-left - independent of page scaling. */
export interface MaskBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageMasks {
  first: MaskBox[];
  continuation: MaskBox[];
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
}

/**
 * Finds every occurrence of `marker` in a page's text items (Word may split it across
 * several items on one line) and returns its box, padded by 1.5 pt.
 */
export function markerBoxes(items: TextItemLike[], pageWidth: number, pageHeight: number, marker: string): MaskBox[] {
  const target = marker.trim();
  if (!target) return [];
  const pad = 1.5;
  // Group the items into lines by baseline.
  const lines: TextItemLike[][] = [];
  for (const item of items) {
    if (!item.str) continue;
    const line = lines.find((l) => Math.abs(l[0].transform[5] - item.transform[5]) < 2);
    if (line) line.push(item);
    else lines.push([item]);
  }
  const boxes: MaskBox[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.transform[4] - b.transform[4]);
    let text = '';
    const owner: number[] = [];
    line.forEach((item, i) => {
      for (let k = 0; k < item.str.length; k++) owner.push(i);
      text += item.str;
    });
    let from = 0;
    for (;;) {
      const at = text.indexOf(target, from);
      if (at < 0) break;
      const used = [...new Set(owner.slice(at, at + target.length))].map((i) => line[i]);
      const x0 = Math.min(...used.map((it) => it.transform[4])) - pad;
      const x1 = Math.max(...used.map((it) => it.transform[4] + it.width)) + pad;
      const size = Math.max(...used.map((it) => Math.hypot(it.transform[2], it.transform[3]) || 10));
      const baseline = used[0].transform[5];
      const top = pageHeight - baseline - size * 0.95 - pad;
      const bottom = pageHeight - baseline + size * 0.3 + pad;
      boxes.push({ x: x0 / pageWidth, y: top / pageHeight, w: (x1 - x0) / pageWidth, h: (bottom - top) / pageHeight });
      from = at + target.length;
    }
  }
  return boxes;
}

interface PdfLike {
  numPages: number;
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number; height: number };
    getTextContent(): Promise<{ items: unknown[] }>;
  }>;
}

/** Marker boxes on one page of an opened pdf.js document. */
export async function markerBoxesOnPage(doc: PdfLike, pageNumber: number, marker: string): Promise<MaskBox[]> {
  const page = await doc.getPage(Math.min(Math.max(pageNumber, 1), doc.numPages));
  const { width, height } = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items.filter((i): i is TextItemLike => typeof i === 'object' && i !== null && 'str' in i);
  return markerBoxes(items, width, height, marker);
}
