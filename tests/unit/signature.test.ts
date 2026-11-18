// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { cropToInk, extractSignature, INK_RGB, NoSignatureError, otsu, recolour } from '@/signature/process';
import { sample } from './helpers';

/** A photo-like test image: grey-ish paper with a shadow, a few specks, and ink strokes. */
function syntheticPhoto(width = 600, height = 300) {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 3;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const paper = 235 - (x / width) * 70; // shadow towards the right
      let v = paper + (rand() - 0.5) * 6;
      // two ink strokes
      const onStroke = (Math.abs(y - (150 + 40 * Math.sin(x / 40))) < 3 && x > 80 && x < 520) || (Math.abs(x - 300) < 3 && y > 60 && y < 240);
      if (onStroke) v = 40;
      // isolated dust specks
      if ((x === 30 && y === 30) || (x === 570 && y === 270)) v = 60;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v));
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('otsu threshold', () => {
  it('splits ink from paper', () => {
    const g = new Uint8Array(1000).fill(230);
    g.fill(40, 0, 100);
    const t = otsu(g);
    expect(t).toBeGreaterThanOrEqual(40);
    expect(t).toBeLessThan(230);
  });
});

describe('photo -> transparent signature', () => {
  it('keeps the ink, makes the paper transparent, drops specks and crops', () => {
    const photo = syntheticPhoto();
    const out = extractSignature(photo.data, photo.width, photo.height, { ink: 'blue', photo: true });
    // Cropped to the strokes (x 80..520, y ~60..240) plus a small margin, not the whole photo.
    expect(out.width).toBeLessThan(500);
    expect(out.width).toBeGreaterThan(430);
    expect(out.height).toBeLessThan(230);
    expect(out.height).toBeGreaterThan(170);
    let opaque = 0;
    let clear = 0;
    for (let i = 3; i < out.data.length; i += 4) {
      if (out.data[i] > 200) opaque++;
      if (out.data[i] === 0) clear++;
    }
    expect(opaque).toBeGreaterThan(1500);
    // Most of the picture is see-through paper: no white box on the PDF.
    expect(clear / (out.width * out.height)).toBeGreaterThan(0.8);
    // Every pixel carries the chosen ink colour.
    expect([out.data[0], out.data[1], out.data[2]]).toEqual(INK_RGB.blue);
    // Corners are paper.
    expect(out.data[3]).toBe(0);
    expect(out.data[out.data.length - 1]).toBe(0);
  });

  it('works on the sample signature photo', async () => {
    const img = await loadImage(Buffer.from(sample('signature-photo.jpg')));
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    const out = extractSignature(data, img.width, img.height, { ink: 'black' });
    expect(out.width).toBeGreaterThan(700);
    expect(out.width).toBeLessThan(1000);
    expect(out.height).toBeLessThan(400);
    const alphaAt = (x: number, y: number) => out.data[(y * out.width + x) * 4 + 3];
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(out.width - 1, out.height - 1)).toBe(0);
  });

  it('refuses a photo without a signature', () => {
    const blank = new Uint8ClampedArray(200 * 100 * 4).fill(240);
    expect(() => extractSignature(blank, 200, 100, { ink: 'blue' })).toThrow(NoSignatureError);
  });

  it('recolours without touching the transparency', () => {
    const photo = syntheticPhoto();
    const blue = extractSignature(photo.data, photo.width, photo.height, { ink: 'blue' });
    const black = recolour(blue, 'black');
    expect([black.data[0], black.data[1], black.data[2]]).toEqual(INK_RGB.black);
    for (let i = 3; i < blue.data.length; i += 997 * 4) expect(black.data[i]).toBe(blue.data[i]);
  });
});

describe('cropToInk (drawn signatures)', () => {
  it('crops a transparent canvas to the drawing plus a margin', () => {
    const w = 400;
    const h = 200;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 90; y < 110; y++) for (let x = 100; x < 300; x++) data[(y * w + x) * 4 + 3] = 255;
    const out = cropToInk({ data, width: w, height: h });
    expect(out.width).toBeGreaterThan(200);
    expect(out.width).toBeLessThan(230);
    expect(out.height).toBeGreaterThan(20);
    expect(out.height).toBeLessThan(40);
  });

  it('reports an empty drawing', () => {
    expect(() => cropToInk({ data: new Uint8ClampedArray(40 * 40 * 4), width: 40, height: 40 })).toThrow(NoSignatureError);
  });
});
