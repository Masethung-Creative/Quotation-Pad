// Renders the pages of a PDF to PNG with pdf.js + @napi-rs/canvas (dev / test helper).
// CLI: node scripts/pdf-to-png.mjs <in.pdf> <out-prefix> [dpi]  ->  <out-prefix>-<n>.png
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// pdf.js reads its standard fonts (Helvetica, Times...) from disk in Node: a plain path, not a file:// URL.
const STANDARD_FONTS = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).split('\\').join('/');

/**
 * @param {Uint8Array | Buffer} data PDF bytes
 * @param {number} dpi resolution
 * @param {{ pages?: number[] }} [options] 1-based page numbers to render (default: all)
 */
export async function pdfToPngs(data, dpi = 100, options = {}) {
  const task = getDocument({ data: new Uint8Array(data), useSystemFonts: false, standardFontDataUrl: STANDARD_FONTS });
  const doc = await task.promise;
  const out = [];
  const wanted = options.pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
  for (const n of wanted) {
    if (n < 1 || n > doc.numPages) continue;
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    out.push({ page: n, png: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height, canvas, ctx });
  }
  await task.destroy();
  return out;
}

if (process.argv[1] && /pdf-to-png\.mjs$/.test(process.argv[1])) {
  const [, , input, prefix, dpi] = process.argv;
  const pages = await pdfToPngs(readFileSync(input), Number(dpi) || 100);
  pages.forEach((p) => writeFileSync(`${prefix}-${p.page}.png`, p.png));
  console.log(`${pages.length} page(s) written`);
}
