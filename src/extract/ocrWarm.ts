import { getSettings, setSetting } from '@/db/db';
import { ocrAssetUrls, type OcrLang } from './ocr';

/**
 * Makes scans and photos work offline: shortly after the app first loads (online, and
 * not on Data Saver), the OCR engine and language data are downloaded once into the
 * service worker cache.
 */

export const OCR_CACHE = 'qp-heavy-assets-v1';

export async function ocrReadyOffline(langs: OcrLang[]): Promise<boolean> {
  try {
    if (!('caches' in window)) return false;
    const cache = await caches.open(OCR_CACHE);
    const urls = await ocrAssetUrls(langs);
    const hits = await Promise.all(urls.map((u) => cache.match(new URL(u, location.origin).href)));
    return hits.every(Boolean);
  } catch {
    return false;
  }
}

function waitForController(timeoutMs: number): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return Promise.resolve(false);
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      clearTimeout(timer);
      resolve(ok);
    };
    const onChange = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
  });
}

let started = false;

export function scheduleOcrWarmup(delayMs = 8000): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return;
  setTimeout(async () => {
    try {
      if (!navigator.onLine || !(await waitForController(30_000))) return;
      const { ocr_langs } = await getSettings();
      if (await ocrReadyOffline(ocr_langs)) return;
      const { warmOcrAssets } = await import('./ocr');
      await warmOcrAssets(ocr_langs);
      await setSetting('ocr_warmed_at', Date.now());
    } catch {
      // Best effort: OCR still downloads on first use.
    }
  }, delayMs);
}
