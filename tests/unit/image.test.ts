// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { estimateSkew, grayToPgm, normaliseIllumination, preprocess, removeRules, rotateGray, stretchContrast, toGray } from '@/extract/image';
import { suggestSafeArea } from '@/templates/suggest';

/** A white page with rows of dark dashes, like lines of text. */
function textPage(width: number, height: number): Uint8Array {
  const g = new Uint8Array(width * height).fill(255);
  for (let y = 60; y < height - 60; y += 22) {
    for (let x = 50; x < width - 50; x++) {
      const word = Math.floor((x - 50) / 37);
      const gap = (x - 50) % 37 > 29 || (word * 7 + y) % 11 === 0;
      if (!gap) for (let t = 0; t < 7; t++) g[(y + t) * width + x] = 20;
    }
  }
  return g;
}

describe('grayscale + contrast', () => {
  it('converts RGBA to luma and treats transparent pixels as white', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0]);
    expect(Array.from(toGray(rgba, 4, 1))).toEqual([255, 0, 76, 255]);
  });

  it('stretches a washed-out scan to full black and white', () => {
    const g = new Uint8Array(1000).fill(200);
    g.fill(90, 0, 80);
    const out = stretchContrast(g);
    expect(out[0]).toBe(0);
    expect(out[999]).toBe(255);
  });

  it('leaves an image with no contrast alone', () => {
    const flat = new Uint8Array(100).fill(128);
    expect(stretchContrast(flat)).toBe(flat);
  });
});

describe('lighting normalisation', () => {
  it('makes paper white under a shadow while keeping the ink dark', () => {
    const w = 400;
    const h = 300;
    const g = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const paper = 235 - (x / w) * 120; // bright on the left, shadow on the right
        const ink = y % 20 < 3 && x % 9 < 5;
        g[y * w + x] = ink ? paper * 0.25 : paper;
      }
    }
    const out = normaliseIllumination(g, w, h);
    const paperLeft = out[10 * w + 8];
    const paperRight = out[10 * w + w - 7];
    expect(paperLeft).toBeGreaterThan(235);
    expect(paperRight).toBeGreaterThan(235);
    expect(out[1 * w + w - 9]).toBeLessThan(100); // ink in the shadow is still dark
  });
});

describe('deskew', () => {
  const w = 700;
  const h = 900;
  const straight = textPage(w, h);

  it('reports no skew for a straight page', () => {
    expect(Math.abs(estimateSkew(straight, w, h))).toBeLessThanOrEqual(0.2);
  });

  it.each([3, -2.5, 1.2, -6])('measures a page tilted by %d degrees', (deg) => {
    // rotateGray(image, a) levels content skewed by a, so rotating by -deg skews it by +deg.
    const skewed = rotateGray(straight, w, h, -deg);
    expect(estimateSkew(skewed, w, h)).toBeCloseTo(deg, 0);
  });

  it('straightens the page again in preprocess()', () => {
    const skewed = rotateGray(straight, w, h, -3);
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < skewed.length; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = skewed[i];
      rgba[i * 4 + 3] = 255;
    }
    const pre = preprocess(rgba, w, h, false);
    expect(pre.angle).toBeCloseTo(3, 0);
    expect(Math.abs(estimateSkew(pre.gray, w, h))).toBeLessThanOrEqual(0.3);
  });

  it('is not fooled by an empty page', () => {
    expect(estimateSkew(new Uint8Array(w * h).fill(255), w, h)).toBe(0);
  });
});

describe('table rule removal', () => {
  it('erases long grid lines but keeps the text inside the cells', () => {
    const w = 600;
    const h = 400;
    const g = new Uint8Array(w * h).fill(255);
    // grid
    for (const y of [50, 100, 150]) for (let x = 40; x < 560; x++) for (let t = 0; t < 3; t++) g[(y + t) * w + x] = 0;
    for (const x of [40, 200, 557]) for (let y = 50; y < 153; y++) for (let t = 0; t < 3; t++) g[y * w + x + t] = 0;
    // "text": a short stroke in a cell
    for (let y = 65; y < 85; y++) for (let x = 100; x < 104; x++) g[y * w + x] = 0;
    for (let x = 100; x < 118; x++) for (let y = 83; y < 86; y++) g[y * w + x] = 0;

    const out = removeRules(g, w, h);
    expect(out[51 * w + 300]).toBe(255); // horizontal rule gone
    expect(out[75 * w + 201]).toBe(255); // vertical rule gone
    expect(out[70 * w + 101]).toBe(0); // letter stroke kept
    expect(out[84 * w + 110]).toBe(0);
  });

  it('returns the same image when there are no rules', () => {
    const g = textPage(300, 300);
    expect(removeRules(g, 300, 300)).toBe(g);
  });
});

describe('PGM container', () => {
  it('writes a valid binary P5 header followed by the pixels', () => {
    const pgm = grayToPgm(new Uint8Array([1, 2, 3, 4, 5, 6]), 3, 2);
    const header = new TextDecoder().decode(pgm.subarray(0, 11));
    expect(header).toBe('P5\n3 2\n255\n');
    expect(Array.from(pgm.subarray(11))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('letterpad safe area suggestion', () => {
  const W = 210;
  const H = 297;
  const fallback = { top: 45, right: 15, bottom: 25, left: 18 };
  const blank = () => new Uint8ClampedArray(W * H * 4).fill(255);
  const paint = (data: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([20, 40, 90, 255], (y * W + x) * 4);
  };

  it('finds the blank band between header and footer (1 px = 1 mm here)', () => {
    const data = blank();
    paint(data, 0, 0, W, 34); // header band
    paint(data, 0, H - 16, W, H); // footer band
    paint(data, 0, 34, 4, H - 16); // decorative stripe on the left
    const area = suggestSafeArea({ data, width: W, height: H }, W, H, fallback);
    expect(area.top).toBeGreaterThanOrEqual(37);
    expect(area.top).toBeLessThanOrEqual(41);
    expect(area.bottom).toBeGreaterThanOrEqual(19);
    expect(area.bottom).toBeLessThanOrEqual(23);
    expect(area.left).toBeGreaterThanOrEqual(10);
    expect(area.right).toBe(12);
  });

  it('ignores a faint watermark in the middle', () => {
    const data = blank();
    paint(data, 0, 0, W, 30);
    for (let y = 120; y < 180; y++) for (let x = 70; x < 140; x++) data.set([238, 240, 244, 255], (y * W + x) * 4);
    const area = suggestSafeArea({ data, width: W, height: H }, W, H, fallback);
    expect(area.top).toBeGreaterThanOrEqual(33);
    expect(area.top).toBeLessThanOrEqual(37);
    expect(area.bottom).toBe(10);
  });

  it('falls back when the sheet has no clear blank band', () => {
    const data = blank();
    for (let y = 0; y < H; y += 12) paint(data, 20, y, 190, y + 4);
    expect(suggestSafeArea({ data, width: W, height: H }, W, H, fallback)).toEqual(fallback);
  });
});
