import type { SafeArea as MarginsMm } from './schema';

/**
 * Suggests the safe area of a letterpad image: the largest empty band between the printed
 * header and footer (and between any side decoration). Pure pixel maths, unit-tested.
 * Used when measuring a new company's letterpad.
 */

export interface PixelImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

const INK_LUMA = 215;

function isInk(data: PixelImage['data'], i: number): boolean {
  const a = data[i + 3];
  if (a < 40) return false;
  const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return luma < INK_LUMA;
}

/** Longest run of `false` in the flags, as [start, endExclusive]. */
function largestGap(flags: boolean[]): [number, number] {
  let best: [number, number] = [0, 0];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    const blank = i < flags.length && !flags[i];
    if (blank && start < 0) start = i;
    if (!blank && start >= 0) {
      if (i - start > best[1] - best[0]) best = [start, i];
      start = -1;
    }
  }
  return best;
}

export function suggestSafeArea(image: PixelImage, pageWidthMm: number, pageHeightMm: number, fallback: MarginsMm): MarginsMm {
  const { data, width, height } = image;
  if (width < 20 || height < 20) return fallback;

  // Rows: look at the middle 70% of the width so a side stripe does not count as content.
  const x0 = Math.floor(width * 0.15);
  const x1 = Math.ceil(width * 0.85);
  const rowInk: boolean[] = [];
  for (let y = 0; y < height; y++) {
    let ink = 0;
    for (let x = x0; x < x1; x++) if (isInk(data, (y * width + x) * 4)) ink++;
    rowInk.push(ink > (x1 - x0) * 0.004);
  }
  const [top, bottom] = largestGap(rowInk);
  if (bottom - top < height * 0.35) return fallback;

  // Columns: only inside the empty band found above.
  const colInk: boolean[] = [];
  for (let x = 0; x < width; x++) {
    let ink = 0;
    for (let y = top; y < bottom; y++) if (isInk(data, (y * width + x) * 4)) ink++;
    colInk.push(ink > (bottom - top) * 0.004);
  }
  let [left, right] = largestGap(colInk);
  if (right - left < width * 0.5) [left, right] = [0, width];

  const mmX = pageWidthMm / width;
  const mmY = pageHeightMm / height;
  const round = (v: number) => Math.round(v);
  return {
    top: round(Math.max(10, top * mmY + 5)),
    bottom: round(Math.max(10, (height - bottom) * mmY + 5)),
    left: round(Math.max(12, left * mmX + 6)),
    right: round(Math.max(12, (width - right) * mmX + 6)),
  };
}
