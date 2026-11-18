import type { Line } from './reconstruct';

/**
 * Removes the SOURCE document's own running header/footer so it does not get printed
 * on top of the user's letterpad:
 *  - lines repeated at the top/bottom of (nearly) every page
 *  - page numbers ("Page 1 of 2", "- 2 -", "2/3") and "continued" markers
 */

const TOP_ZONE = 0.14;
const BOTTOM_ZONE = 0.12;

const PAGE_NUMBER_RES = [
  /^page\s*(no\.?\s*)?[:#]?\s*\d+(\s*(of|\/|-)\s*\d+)?\.?$/i,
  /^\d+\s*(of|\/)\s*\d+$/i,
  /^[-–—]\s*\d+\s*[-–—]$/,
  /^\(?\s*(contd|cont'd|continued)\.*(\s*(on|to|from)\s*(next|previous)?\s*page)?\.*\s*\)?\.*$/i,
  /^p\.?\s*t\.?\s*o\.?$/i,
];

export function isPageNumber(text: string): boolean {
  const t = text.trim();
  return PAGE_NUMBER_RES.some((re) => re.test(t));
}

function key(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

export interface HeaderFooterResult {
  pages: Line[][];
  removed: string[];
}

export function removeHeaderFooter(pages: Line[][], pageHeights: number[]): HeaderFooterResult {
  const removed: string[] = [];
  const n = pages.length;
  const zoneOf = (line: Line, h: number): 'top' | 'bottom' | null => {
    const yc = (line.y0 + line.y1) / 2;
    if (yc < h * TOP_ZONE) return 'top';
    if (yc > h * (1 - BOTTOM_ZONE)) return 'bottom';
    return null;
  };

  // Count on how many pages each normalised line appears inside the same zone.
  const seen = new Map<string, Set<number>>();
  pages.forEach((lines, p) => {
    for (const line of lines) {
      const zone = zoneOf(line, pageHeights[p]);
      if (!zone) continue;
      const k = `${zone}|${key(line.text)}`;
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k)!.add(p);
    }
  });
  const needed = Math.max(2, Math.ceil(n * 0.6));

  const out = pages.map((lines, p) => {
    const h = pageHeights[p];
    const kept: Line[] = [];
    lines.forEach((line, idx) => {
      const zone = zoneOf(line, h);
      if (!zone) {
        kept.push(line);
        return;
      }
      const text = line.text.trim();
      const repeated = n >= 2 && (seen.get(`${zone}|${key(text)}`)?.size ?? 0) >= needed;
      // A bare number only counts as a page number when it is the very first / last line.
      const bareNumber = /^\d{1,3}$/.test(text) && n >= 2 && (idx === 0 || idx === lines.length - 1);
      if (repeated || isPageNumber(text) || bareNumber) {
        removed.push(text);
        return;
      }
      // "Some footer text            Page 1 of 1": drop only the page-number part.
      const segs = line.segs.filter((seg) => {
        if (!isPageNumber(seg.text)) return true;
        removed.push(seg.text.trim());
        return false;
      });
      if (segs.length === line.segs.length) kept.push(line);
      else if (segs.length) kept.push({ ...line, segs, x0: segs[0].x0, x1: Math.max(...segs.map((s) => s.x1)), text: segs.map((s) => s.text).join(' ') });
    });
    return kept;
  });

  return { pages: out, removed };
}
