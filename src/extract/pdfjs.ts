import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { LowMemoryError } from '@/lib/errors';

/** Lazy pdf.js loader (legacy build = widest phone browser support). Parsing runs in pdf.js's own worker. */

type PdfLib = typeof import('pdfjs-dist');

let libPromise: Promise<PdfLib> | null = null;

export function loadPdfjs(): Promise<PdfLib> {
  libPromise ??= (async () => {
    const [lib, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfLib>,
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  })();
  return libPromise;
}

export interface OpenPdf {
  doc: PDFDocumentProxy;
  close: () => Promise<void>;
}

export async function openPdf(data: ArrayBuffer | Uint8Array): Promise<OpenPdf> {
  const lib = await loadPdfjs();
  // pdf.js takes ownership of the buffer it is given, so hand it a private copy.
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  const task = lib.getDocument({
    data: bytes,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    // Exposes the real font names, which is how bold / italic text is recognised.
    fontExtraProperties: true,
  });
  const doc = await task.promise;
  return { doc, close: () => task.destroy() };
}

export interface RenderOptions {
  /** Target resolution. 300 for OCR, ~110-150 for previews. */
  dpi?: number;
  /** Fixed output width in pixels (overrides dpi). */
  width?: number;
  maxPixels?: number;
  background?: string;
}

export async function renderPage(page: PDFPageProxy, options: RenderOptions = {}): Promise<HTMLCanvasElement> {
  const base = page.getViewport({ scale: 1 });
  let scale = options.width ? options.width / base.width : (options.dpi ?? 150) / 72;
  const maxPixels = options.maxPixels ?? 9_000_000;
  if (base.width * base.height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (base.width * base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Browsers return no context when the canvas is too large for the memory left.
  if (!ctx) throw new LowMemoryError();
  ctx.fillStyle = options.background ?? '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

export type { PDFDocumentProxy, PDFPageProxy };
