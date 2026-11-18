import type { FileKind } from '@/ingest/detect';
import { LowMemoryError } from '@/lib/errors';
import { docText, parseCanonical } from '@/schema/canonical';
import type { OcrEngine, OcrLang } from './ocr';
import { reconstruct } from './reconstruct';
import { refineBlocks } from './refine';
import { finalizeBlocks, type ExtractMethod, type ExtractResult, type PageWords, type ProgressFn, type Word } from './types';
import { subtractTokens } from '@/validate/coverage';

/** Step 2 of the pipeline: any supported file -> canonical JSON. Everything runs on the device. */

export interface ExtractOptions {
  langs: OcrLang[];
  /** Ignore the PDF text layer and OCR every page (for PDFs whose text layer is garbled). */
  forceOcr?: boolean;
  /** Use less memory (lower OCR resolution) - the "Try again" after the phone ran out of memory. */
  lowMemory?: boolean;
  onProgress?: ProgressFn;
}

const OCR_DPI = 300;
const OCR_DPI_LOW_MEMORY = 200;

const STATUS_TEXT: Record<string, string> = {
  'loading tesseract core': 'Getting the text reader ready',
  'initializing tesseract': 'Getting the text reader ready',
  'loading language traineddata': 'Loading language data',
  'initializing api': 'Starting the text reader',
};

class OcrSession {
  private engine: OcrEngine | null = null;
  confidences: number[] = [];
  constructor(
    private langs: OcrLang[],
    private progress: ProgressFn,
  ) {}

  async read(source: HTMLCanvasElement, photo: boolean, page: number, pages: number): Promise<{ words: Word[]; width: number; height: number }> {
    const { preprocessOffThread } = await import('@/workers/extractClient');
    const { createOcrEngine } = await import('./ocr');
    if (!this.engine) {
      this.progress({ stage: 'ocr-load', message: 'Getting the text reader ready', page, pages });
      this.engine = await createOcrEngine(this.langs, (status, fraction) => {
        this.progress({ stage: 'ocr-load', message: STATUS_TEXT[status] ?? 'Getting the text reader ready', progress: fraction, page, pages });
      });
    }
    const label = pages > 1 ? `Reading page ${page} of ${pages}` : 'Reading the page';
    this.progress({ stage: 'ocr', message: label, page, pages, progress: 0 });
    let imageData: ImageData;
    try {
      const ctx = source.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new LowMemoryError();
      imageData = ctx.getImageData(0, 0, source.width, source.height);
    } catch (err) {
      throw err instanceof LowMemoryError ? err : new LowMemoryError(String(err));
    }
    const prepared = await preprocessOffThread(imageData, photo);
    // Release the big canvas before OCR starts; phones have little memory to spare.
    source.width = source.height = 0;
    const blob = new Blob([prepared.pgm as BlobPart], { type: 'image/x-portable-graymap' });
    const result = await this.engine.recognize(blob, (fraction) => {
      this.progress({ stage: 'ocr', message: label, page, pages, progress: fraction });
    });
    this.confidences.push(result.confidence);
    return { words: result.words, width: prepared.width, height: prepared.height };
  }

  async close(): Promise<void> {
    await this.engine?.terminate().catch(() => undefined);
    this.engine = null;
  }
}

function ocrWarnings(session: OcrSession, langs: OcrLang[]): string[] {
  const warnings: string[] = [];
  if (!session.confidences.length) return warnings;
  const mean = session.confidences.reduce((a, b) => a + b, 0) / session.confidences.length;
  if (mean < 0.6) {
    warnings.push(
      langs.length === 1
        ? 'This scan was hard to read. Check every amber word. If the document has Tamil or Hindi text, turn that language on in Settings and convert again.'
        : 'This scan was hard to read. Please check every amber word carefully.',
    );
  }
  return warnings;
}

/** Reconstruction -> canonical document, keeping track of everything that was left out on purpose. */
function assemble(pages: PageWords[], warnings: string[], method: ExtractMethod): ExtractResult {
  const rebuilt = reconstruct(pages);
  const repeated: string[] = [];
  const blocks = refineBlocks(rebuilt.blocks, repeated);
  return {
    doc: finalizeBlocks(blocks),
    sourceText: subtractTokens(rebuilt.sourceText, repeated.join(' ')),
    removed: [...rebuilt.removed, ...repeated],
    warnings,
    method,
    pages: pages.length,
  };
}

async function extractPdf(data: ArrayBuffer, options: ExtractOptions, progress: ProgressFn): Promise<ExtractResult> {
  const { openPdf, renderPage } = await import('./pdfjs');
  const { pageTextWords, needsOcr } = await import('./pdf');
  const { doc, close } = await openPdf(data);
  const session = new OcrSession(options.langs, progress);
  const pages: PageWords[] = [];
  const warnings: string[] = [];
  let ocrPages = 0;
  let skipped = 0;
  try {
    const total = doc.numPages;
    for (let n = 1; n <= total; n++) {
      progress({ stage: 'reading', message: total > 1 ? `Opening page ${n} of ${total}` : 'Opening the PDF', page: n, pages: total });
      const page = await doc.getPage(n);
      const text = await pageTextWords(page);
      skipped += text.skipped;
      if (!options.forceOcr && !needsOcr(text)) {
        pages.push({ width: text.width, height: text.height, words: text.words, ocr: false, rules: text.rules });
      } else {
        const canvas = await renderPage(page, options.lowMemory ? { dpi: OCR_DPI_LOW_MEMORY, maxPixels: 4_500_000 } : { dpi: OCR_DPI });
        const scale = canvas.width / text.width;
        const read = await session.read(canvas, false, n, total);
        ocrPages++;
        pages.push({
          width: text.width,
          height: text.height,
          ocr: true,
          words: read.words.map((w) => ({ ...w, x0: w.x0 / scale, x1: w.x1 / scale, y0: w.y0 / scale, y1: w.y1 / scale })),
        });
      }
      page.cleanup();
    }
  } finally {
    await session.close();
    await close().catch(() => undefined);
  }

  progress({ stage: 'structure', message: 'Rebuilding tables and paragraphs' });
  if (skipped > 0) warnings.push('Some rotated text (a watermark or stamp) was left out.');
  warnings.push(...ocrWarnings(session, options.langs));
  return assemble(pages, warnings, ocrPages === 0 ? 'pdf-text' : ocrPages === pages.length ? 'ocr' : 'pdf-mixed');
}

async function extractImage(blob: Blob, options: ExtractOptions, progress: ProgressFn): Promise<ExtractResult> {
  const { decodeImage } = await import('@/ingest/image');
  progress({ stage: 'reading', message: 'Opening the picture' });
  const { canvas } = options.lowMemory ? await decodeImage(blob, 2400, 4_500_000) : await decodeImage(blob);
  const session = new OcrSession(options.langs, progress);
  let page: PageWords;
  try {
    const read = await session.read(canvas, true, 1, 1);
    page = { width: read.width, height: read.height, words: read.words, ocr: true };
  } finally {
    await session.close();
  }
  progress({ stage: 'structure', message: 'Rebuilding tables and paragraphs' });
  return assemble([page], ocrWarnings(session, options.langs), 'ocr');
}

export async function extractFile(blob: Blob, kind: FileKind, options: ExtractOptions): Promise<ExtractResult> {
  const progress: ProgressFn = options.onProgress ?? (() => undefined);

  switch (kind) {
    case 'json': {
      const doc = parseCanonical(JSON.parse(await blob.text()));
      return { doc, sourceText: docText(doc), removed: [], warnings: [], method: 'json', pages: 1 };
    }
    case 'docx': {
      progress({ stage: 'reading', message: 'Reading the Word file' });
      const [{ docxToHtmlOffThread }, { finishDocx, docxPageCount }] = await Promise.all([import('@/workers/extractClient'), import('./docx')]);
      const [html, pages] = await Promise.all([docxToHtmlOffThread(await blob.arrayBuffer()), blob.arrayBuffer().then(docxPageCount)]);
      progress({ stage: 'structure', message: 'Rebuilding tables and paragraphs' });
      return finishDocx(html, pages ?? 0);
    }
    case 'pdf':
      return extractPdf(await blob.arrayBuffer(), options, progress);
    case 'heic': {
      progress({ stage: 'reading', message: 'Converting the iPhone photo' });
      const { heicToJpeg } = await import('@/ingest/image');
      return extractImage(await heicToJpeg(blob), options, progress);
    }
    case 'jpg':
    case 'png':
    case 'webp':
      return extractImage(blob, options, progress);
  }
}
