/**
 * Image clean-up before OCR: grayscale, lighting normalisation, contrast stretch, deskew.
 * Pure typed-array code with no DOM dependency, so it runs inside a web worker and in tests.
 */

export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    // Rec. 601 luma, pre-multiplied over white for transparent pixels.
    const a = rgba[i + 3] / 255;
    const y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    out[j] = Math.round(y * a + 255 * (1 - a));
  }
  return out;
}

/**
 * Flattens uneven lighting (phone photos with shadows): estimates the paper brightness on a
 * coarse grid and divides it out, so the paper becomes white everywhere.
 */
export function normaliseIllumination(gray: Uint8Array, width: number, height: number): Uint8Array {
  const cell = Math.max(8, Math.round(Math.max(width, height) / 48));
  const gw = Math.ceil(width / cell);
  const gh = Math.ceil(height / cell);
  const bg = new Float32Array(gw * gh);

  // Background of a cell = its 90th percentile brightness (paper, not ink).
  const hist = new Uint32Array(256);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      hist.fill(0);
      let n = 0;
      const y1 = Math.min(height, (gy + 1) * cell);
      const x1 = Math.min(width, (gx + 1) * cell);
      for (let y = gy * cell; y < y1; y += 2) {
        for (let x = gx * cell; x < x1; x += 2) {
          hist[gray[y * width + x]]++;
          n++;
        }
      }
      let acc = 0;
      let v = 255;
      const target = n * 0.1;
      for (; v > 0; v--) {
        acc += hist[v];
        if (acc >= target) break;
      }
      bg[gy * gw + gx] = Math.max(v, 32);
    }
  }

  // 3x3 smoothing of the grid.
  const smooth = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = gy + dy;
          const xx = gx + dx;
          if (yy < 0 || yy >= gh || xx < 0 || xx >= gw) continue;
          sum += bg[yy * gw + xx];
          n++;
        }
      }
      smooth[gy * gw + gx] = sum / n;
    }
  }

  const out = new Uint8Array(gray.length);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const wx = fx - x0;
      const b =
        smooth[y0 * gw + x0] * (1 - wx) * (1 - wy) +
        smooth[y0 * gw + x1] * wx * (1 - wy) +
        smooth[y1 * gw + x0] * (1 - wx) * wy +
        smooth[y1 * gw + x1] * wx * wy;
      const v = (gray[y * width + x] / b) * 255;
      out[y * width + x] = v > 255 ? 255 : v;
    }
  }
  return out;
}

/** Stretches the histogram so the darkest 2% become black and the brightest 30% white. */
export function stretchContrast(gray: Uint8Array, lowPct = 0.02, highPct = 0.7): Uint8Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 3) hist[gray[i]]++;
  const total = Math.ceil(gray.length / 3);
  let lo = 0;
  let hi = 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * lowPct) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * highPct) {
      hi = v;
      break;
    }
  }
  if (hi - lo < 40) return gray;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo)) * 255)));
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = lut[gray[i]];
  return out;
}

/**
 * Estimates the skew of the text lines in degrees (positive = lines drop towards the right).
 * Uses the projection-profile method on a small binarised copy of the page.
 */
export function estimateSkew(gray: Uint8Array, width: number, height: number, maxDeg = 10): number {
  const scale = Math.max(1, Math.floor(Math.max(width, height) / 800));
  const w = Math.floor(width / scale);
  const h = Math.floor(height / scale);
  if (w < 40 || h < 40) return 0;

  // Dark pixel coordinates of the reduced image.
  let sum = 0;
  const small = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let min = 255;
      for (let dy = 0; dy < scale; dy += Math.max(1, scale >> 1)) {
        for (let dx = 0; dx < scale; dx += Math.max(1, scale >> 1)) {
          const v = gray[(y * scale + dy) * width + x * scale + dx];
          if (v < min) min = v;
        }
      }
      small[y * w + x] = min;
      sum += min;
    }
  }
  const threshold = Math.min(160, (sum / (w * h)) * 0.75);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (small[y * w + x] < threshold) {
        xs.push(x - w / 2);
        ys.push(y);
      }
    }
  }
  if (xs.length < 200) return 0;

  const bins = new Float64Array(h * 3);
  const score = (deg: number): number => {
    const t = Math.tan((deg * Math.PI) / 180);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) {
      const y = Math.round(ys[i] - xs[i] * t) + h;
      if (y >= 0 && y < bins.length) bins[y]++;
    }
    let s = 0;
    for (let i = 1; i < bins.length; i++) {
      const d = bins[i] - bins[i - 1];
      s += d * d;
    }
    return s;
  };

  let best = 0;
  let bestScore = -1;
  for (let deg = -maxDeg; deg <= maxDeg; deg += 0.5) {
    const s = score(deg);
    if (s > bestScore) {
      bestScore = s;
      best = deg;
    }
  }
  const coarse = best;
  for (let deg = coarse - 0.4; deg <= coarse + 0.4; deg += 0.1) {
    const s = score(deg);
    if (s > bestScore) {
      bestScore = s;
      best = deg;
    }
  }
  // Only trust the estimate when it clearly beats "no rotation".
  if (bestScore < score(0) * 1.05) return 0;
  return Math.round(best * 10) / 10;
}

/**
 * Rotates the image so that content skewed by `deg` (as returned by estimateSkew) becomes
 * level. The canvas size is kept; uncovered corners are filled with white.
 */
export function rotateGray(gray: Uint8Array, width: number, height: number, deg: number, fill = 255): Uint8Array {
  if (!deg) return gray;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const out = new Uint8Array(gray.length);
  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const sx = cx + dx * cos - dy * sin;
      const sy = cy + dx * sin + dy * cos;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= width - 1 || y0 >= height - 1) {
        out[y * width + x] = fill;
        continue;
      }
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * width + x0;
      out[y * width + x] =
        gray[i] * (1 - fx) * (1 - fy) + gray[i + 1] * fx * (1 - fy) + gray[i + width] * (1 - fx) * fy + gray[i + width + 1] * fx * fy;
    }
  }
  return out;
}

/**
 * Erases table rules, borders and underlines: long straight dark runs that are far longer
 * than any letter stroke. Grid lines right next to short cell values ("1", "24") are the
 * main reason OCR drops or garbles numbers in tables.
 */
export function removeRules(gray: Uint8Array, width: number, height: number): Uint8Array {
  const DARK = 160;
  const minH = Math.max(40, Math.round(width * 0.025));
  const minV = Math.max(40, Math.round(height * 0.025));
  const mask = new Uint8Array(gray.length);
  let found = false;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const dark = x < width && gray[row + x] < DARK;
      if (dark && start < 0) start = x;
      else if (!dark && start >= 0) {
        if (x - start >= minH) {
          mask.fill(1, row + start, row + x);
          found = true;
        }
        start = -1;
      }
    }
  }
  for (let x = 0; x < width; x++) {
    let start = -1;
    for (let y = 0; y <= height; y++) {
      const dark = y < height && gray[y * width + x] < DARK;
      if (dark && start < 0) start = y;
      else if (!dark && start >= 0) {
        if (y - start >= minV) {
          for (let k = start; k < y; k++) mask[k * width + x] = 1;
          found = true;
        }
        start = -1;
      }
    }
  }
  if (!found) return gray;

  // Clear the rule and its soft (anti-aliased) edge, one pixel around it.
  const out = new Uint8Array(gray);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      out[i] = 255;
      if (x > 0) out[i - 1] = 255;
      if (x < width - 1) out[i + 1] = 255;
      if (y > 0) out[i - width] = 255;
      if (y < height - 1) out[i + width] = 255;
    }
  }
  return out;
}

export interface Preprocessed {
  gray: Uint8Array;
  width: number;
  height: number;
  /** Skew that was corrected, in degrees. */
  angle: number;
}

export function preprocess(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, photo: boolean): Preprocessed {
  let gray = toGray(rgba, width, height);
  if (photo) gray = normaliseIllumination(gray, width, height);
  gray = stretchContrast(gray);
  const angle = estimateSkew(gray, width, height);
  if (Math.abs(angle) >= 0.3) gray = rotateGray(gray, width, height, angle);
  gray = removeRules(gray, width, height);
  return { gray, width, height, angle };
}

/** Binary PGM (P5): the cheapest lossless container Tesseract can read. */
export function grayToPgm(gray: Uint8Array, width: number, height: number): Uint8Array {
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const out = new Uint8Array(header.length + gray.length);
  out.set(header, 0);
  out.set(gray, header.length);
  return out;
}
