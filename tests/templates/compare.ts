/**
 * Side-by-side check of a code-built template against the original letterpad.
 *
 * Both pages are rasterised at the same resolution. Every "ink" pixel (anything that is
 * not white paper) of one image is matched to the nearest ink pixel of the other with an
 * exact Euclidean distance transform. The distance (in mm) that 99.9% of ink pixels stay
 * within is the match error; "within 1 mm" means that number is <= 1.
 */

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** 1 where the pixel is visibly not white paper. */
export function inkMask(img: RgbaImage, threshold = 28): Uint8Array {
  const { data, width, height } = img;
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
    const a = data[i + 3] / 255;
    const r = 255 - (255 - data[i]) * a;
    const g = 255 - (255 - data[i + 1]) * a;
    const b = 255 - (255 - data[i + 2]) * a;
    if (255 - Math.min(r, g, b) > threshold) mask[p] = 1;
  }
  return mask;
}

const INF = 1e20;

/** Exact squared Euclidean distance transform, 1-D pass (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Distance (px) from every pixel to the nearest pixel of `mask`. */
export function distanceTransform(mask: Uint8Array, width: number, height: number): Float32Array {
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = mask[i] ? 0 : INF;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    edt1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x];
    edt1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) grid[y * width + x] = d[x];
  }
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

export interface MatchReport {
  /** 99.9th percentile of ink-to-ink distance, in mm (the pass/fail number). */
  p999: number;
  /** Largest distance, in mm (single stray pixels included). */
  max: number;
  /** Mean distance, in mm. */
  mean: number;
  inkA: number;
  inkB: number;
}

function directed(from: Uint8Array, dtTo: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < from.length; i++) if (from[i]) out.push(dtTo[i]);
  return out;
}

export function compareInk(a: RgbaImage, b: RgbaImage, pxPerMm: number): MatchReport {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Images must be the same size');
  const ma = inkMask(a);
  const mb = inkMask(b);
  const da = distanceTransform(ma, a.width, a.height);
  const db = distanceTransform(mb, b.width, b.height);
  const all = [...directed(ma, db), ...directed(mb, da)].sort((x, y) => x - y);
  if (!all.length) return { p999: 0, max: 0, mean: 0, inkA: 0, inkB: 0 };
  const pick = (p: number) => all[Math.min(all.length - 1, Math.floor(all.length * p))];
  const mean = all.reduce((s, x) => s + x, 0) / all.length;
  return {
    p999: pick(0.999) / pxPerMm,
    max: all[all.length - 1] / pxPerMm,
    mean: mean / pxPerMm,
    inkA: ma.reduce((s, x) => s + x, 0),
    inkB: mb.reduce((s, x) => s + x, 0),
  };
}

/** Original | template | overlay (red = only in the original, blue = only in the template). */
export function sideBySide(a: RgbaImage, b: RgbaImage): RgbaImage {
  const { width, height } = a;
  const gap = 12;
  const W = width * 3 + gap * 2;
  const out = new Uint8ClampedArray(W * height * 4).fill(255);
  const ma = inkMask(a);
  const mb = inkMask(b);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const p = y * width + x;
      for (const [img, col] of [
        [a, 0],
        [b, 1],
      ] as const) {
        const t = (y * W + col * (width + gap) + x) * 4;
        out[t] = img.data[s];
        out[t + 1] = img.data[s + 1];
        out[t + 2] = img.data[s + 2];
        out[t + 3] = 255;
      }
      const t = (y * W + 2 * (width + gap) + x) * 4;
      if (ma[p] && mb[p]) out.set([150, 150, 150, 255], t);
      else if (ma[p]) out.set([220, 30, 30, 255], t);
      else if (mb[p]) out.set([30, 90, 220, 255], t);
    }
  }
  return { data: out, width: W, height };
}
