import { normaliseIllumination, toGray } from '@/extract/image';

/**
 * Turns a photo of a signature on white paper into clean ink on a transparent background:
 * flatten the lighting, separate ink from paper, drop specks, recolour, crop.
 * Pure typed-array code: unit-tested, and fast enough on a phone for a ~1600 px photo.
 */

export type InkColour = 'blue' | 'black';

export const INK_RGB: Record<InkColour, [number, number, number]> = {
  blue: [22, 45, 128],
  black: [17, 17, 17],
};

export interface InkImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export class NoSignatureError extends Error {
  constructor(message = 'No signature was found. Use dark ink on plain white paper, and fill most of the photo with the signature.') {
    super(message);
    this.name = 'NoSignatureError';
  }
}

/** Otsu's threshold on a 256-bin histogram. */
export function otsu(gray: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** Connected components of `mask` (4-neighbour). Returns a label per pixel and the size of each label. */
function components(mask: Uint8Array, width: number, height: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] >= 0) continue;
    const label = sizes.length;
    let size = 0;
    labels[start] = label;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % width;
      const neighbours = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width];
      for (const q of neighbours) {
        if (q < 0 || q >= mask.length || !mask[q] || labels[q] >= 0) continue;
        labels[q] = label;
        stack.push(q);
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  let cur = mask;
  for (let r = 0; r < radius; r++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (cur[p]) continue;
        if ((x > 0 && cur[p - 1]) || (x < width - 1 && cur[p + 1]) || (y > 0 && cur[p - width]) || (y < height - 1 && cur[p + width])) next[p] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/** Crops an RGBA image to its non-transparent pixels plus a margin. */
export function cropToInk(img: InkImage, padRatio = 0.04): InkImage {
  const { data, width, height } = img;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new NoSignatureError();
  const pad = Math.max(4, Math.round(Math.max(x1 - x0, y1 - y0) * padRatio));
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(data.subarray(((y + y0) * width + x0) * 4, ((y + y0) * width + x0 + w) * 4), y * w * 4);
  return { data: out, width: w, height: h };
}

export interface ExtractOptions {
  ink: InkColour;
  /** True for camera photos (uneven light); false for scans and screenshots. */
  photo?: boolean;
}

export function extractSignature(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, options: ExtractOptions): InkImage {
  let gray = toGray(rgba, width, height);
  if (options.photo !== false) gray = normaliseIllumination(gray, width, height);

  const threshold = otsu(gray);
  // Ink must be clearly darker than the paper; otherwise there is nothing to keep.
  let inkSum = 0;
  let inkCount = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < threshold) {
      inkSum += gray[i];
      inkCount++;
    }
  }
  if (inkCount < gray.length * 0.0005 || threshold > 245) throw new NoSignatureError();
  const inkLevel = inkSum / inkCount;
  if (threshold - inkLevel < 25) throw new NoSignatureError();

  // Soft edges: full ink at the typical ink darkness, fading to nothing a little above the threshold.
  const lo = inkLevel;
  const hi = Math.min(250, threshold + (255 - threshold) * 0.3);
  const alpha = new Float32Array(gray.length);
  const core = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const a = Math.min(1, Math.max(0, (hi - gray[i]) / (hi - lo)));
    alpha[i] = Math.pow(a, 0.85);
    if (a > 0.5) core[i] = 1;
  }

  // Drop dust and speckle: keep strokes that are reasonably large compared with the main stroke.
  const { labels, sizes } = components(core, width, height);
  if (!sizes.length) throw new NoSignatureError();
  const largest = Math.max(...sizes);
  const minSize = Math.max(8, largest * 0.01);
  const kept = new Uint8Array(gray.length);
  for (let i = 0; i < kept.length; i++) if (labels[i] >= 0 && sizes[labels[i]] >= minSize) kept[i] = 1;
  const near = dilate(kept, width, height, 2);

  const [r, g, b] = INK_RGB[options.ink];
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    out[j] = r;
    out[j + 1] = g;
    out[j + 2] = b;
    out[j + 3] = near[i] ? Math.round(alpha[i] * 255) : 0;
  }
  return cropToInk({ data: out, width, height });
}

/** Recolours an already transparent signature (e.g. switching blue <-> black). */
export function recolour(img: InkImage, ink: InkColour): InkImage {
  const [r, g, b] = INK_RGB[ink];
  const out = new Uint8ClampedArray(img.data);
  for (let j = 0; j < out.length; j += 4) {
    out[j] = r;
    out[j + 1] = g;
    out[j + 2] = b;
  }
  return { data: out, width: img.width, height: img.height };
}
