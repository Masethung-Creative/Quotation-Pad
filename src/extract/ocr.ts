import type { Word } from './types';

/**
 * Tesseract.js OCR. Runs in Tesseract's own web worker. The engine, and each language's
 * data file, is fetched from this app's own origin the first time it is needed and then
 * kept on the device (service-worker cache + IndexedDB).
 */

export const OCR_LANGS = [
  { code: 'eng', label: 'English', native: 'English' },
  { code: 'tam', label: 'Tamil', native: 'தமிழ்' },
  { code: 'hin', label: 'Hindi', native: 'हिन्दी' },
] as const;

export type OcrLang = (typeof OCR_LANGS)[number]['code'];

export const OCR_ASSETS = {
  worker: '/tesseract/worker.min.js',
  core: '/tesseract/core',
  lang: '/tesseract/lang',
};

export interface OcrPageResult {
  words: Word[];
  /** Mean word confidence 0..1. */
  confidence: number;
}

export interface OcrEngine {
  recognize(image: Blob, onProgress?: (fraction: number) => void): Promise<OcrPageResult>;
  terminate(): Promise<void>;
}

interface TessWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface TessBlock {
  paragraphs?: { lines?: { words?: TessWord[] }[] }[];
}

export async function createOcrEngine(langs: OcrLang[], onStatus: (status: string, fraction: number) => void): Promise<OcrEngine> {
  const tesseract = await import('tesseract.js');
  const createWorker = tesseract.createWorker ?? tesseract.default.createWorker;
  let onRecognize: ((fraction: number) => void) | undefined;

  const worker = await createWorker(langs.length ? [...langs] : ['eng'], 1, {
    workerPath: OCR_ASSETS.worker,
    corePath: OCR_ASSETS.core,
    langPath: OCR_ASSETS.lang,
    workerBlobURL: false,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onRecognize?.(m.progress);
      else onStatus(m.status, m.progress);
    },
  });
  await worker.setParameters({
    // Quotations are one page-wide block; this keeps table rows together as lines.
    tessedit_pageseg_mode: '6' as never,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  });

  return {
    async recognize(image, onProgress) {
      onRecognize = onProgress;
      const { data } = await worker.recognize(image, {}, { blocks: true, text: false });
      onRecognize = undefined;
      const words: Word[] = [];
      let sum = 0;
      for (const block of (data.blocks ?? []) as TessBlock[]) {
        for (const para of block.paragraphs ?? []) {
          for (const line of para.lines ?? []) {
            for (const w of line.words ?? []) {
              const text = w.text.trim();
              if (!text) continue;
              const conf = Math.max(0, Math.min(1, w.confidence / 100));
              // Specks and ruling lines come back as tiny, hopeless "words".
              if (conf < 0.15 && text.length <= 2) continue;
              words.push({ text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, conf });
              sum += conf;
            }
          }
        }
      }
      return { words, confidence: words.length ? sum / words.length : 0 };
    },
    async terminate() {
      await worker.terminate();
    },
  };
}

/** The one engine build this device will use (the same choice Tesseract.js makes). */
export async function coreFileForDevice(): Promise<string> {
  try {
    const { relaxedSimd, simd } = await import('wasm-feature-detect');
    if (await relaxedSimd()) return 'tesseract-core-relaxedsimd-lstm.wasm.js';
    if (await simd()) return 'tesseract-core-simd-lstm.wasm.js';
  } catch {
    // Detection failed: the plain build works everywhere.
  }
  return 'tesseract-core-lstm.wasm.js';
}

export async function ocrAssetUrls(langs: OcrLang[]): Promise<string[]> {
  return [OCR_ASSETS.worker, `${OCR_ASSETS.core}/${await coreFileForDevice()}`, ...langs.map((l) => `${OCR_ASSETS.lang}/${l}.traineddata.gz`)];
}

/**
 * Downloads the OCR engine and language files now, so scans and photos also work offline.
 * The service worker keeps every response in its cache.
 */
export async function warmOcrAssets(langs: OcrLang[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const urls = await ocrAssetUrls(langs);
  let done = 0;
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${url}`);
    await res.arrayBuffer();
    onProgress?.(++done, urls.length);
  }
}
