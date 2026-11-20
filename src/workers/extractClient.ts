import type { DocxHtml } from '@/extract/docx';
import type { OdtHtml } from '@/extract/odt';
import type { ExtractRequest, ExtractResponse } from './extract.worker';

/**
 * Promise wrapper around the extract worker. If the browser cannot start the worker
 * (very old WebView), the same code runs on the main thread instead of failing.
 */

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, { resolve: (r: ExtractResponse) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (broken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./extract.worker.ts', import.meta.url), { type: 'module', name: 'qp-extract' });
    worker.onmessage = (event: MessageEvent<ExtractResponse>) => {
      const p = pending.get(event.data.id);
      if (!p) return;
      pending.delete(event.data.id);
      p.resolve(event.data);
    };
    worker.onerror = (event) => {
      broken = true;
      worker?.terminate();
      worker = null;
      const error = new Error(event.message || 'Worker failed to start');
      pending.forEach((p) => p.reject(error));
      pending.clear();
    };
    return worker;
  } catch {
    broken = true;
    return null;
  }
}

type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never;

function call(req: WithoutId<ExtractRequest>, transfer: Transferable[]): Promise<ExtractResponse> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('no-worker'));
  const id = ++seq;
  return new Promise<ExtractResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...req, id }, transfer);
  });
}

export async function docxToHtmlOffThread(buffer: ArrayBuffer): Promise<DocxHtml> {
  // Keep a copy: the original is transferred to the worker and we may need the fallback.
  const copy = buffer.slice(0);
  try {
    const res = await call({ type: 'docx', buffer }, [buffer]);
    if (res.ok && res.type === 'docx') return { html: res.html, messages: res.messages };
    if (!res.ok) throw new Error(res.error);
    throw new Error('Unexpected worker reply');
  } catch (err) {
    if (err instanceof Error && err.message !== 'no-worker' && !broken) throw err;
    const { docxToHtml } = await import('@/extract/docx');
    return docxToHtml(copy);
  }
}

export async function odtToHtmlOffThread(buffer: ArrayBuffer): Promise<OdtHtml> {
  const copy = buffer.slice(0);
  try {
    const res = await call({ type: 'odt', buffer }, [buffer]);
    if (res.ok && res.type === 'odt') return { html: res.html, messages: res.messages };
    if (!res.ok) throw new Error(res.error);
    throw new Error('Unexpected worker reply');
  } catch (err) {
    if (err instanceof Error && err.message !== 'no-worker' && !broken) throw err;
    const { odtToHtml } = await import('@/extract/odt');
    return odtToHtml(copy);
  }
}

export interface PreparedImage {
  pgm: Uint8Array;
  width: number;
  height: number;
  angle: number;
}

export async function preprocessOffThread(image: ImageData, photo: boolean): Promise<PreparedImage> {
  const { width, height } = image;
  try {
    const copy = image.data.buffer.slice(0) as ArrayBuffer;
    const res = await call({ type: 'preprocess', rgba: copy, width, height, photo }, [copy]);
    if (res.ok && res.type === 'preprocess') return { pgm: new Uint8Array(res.pgm), width: res.width, height: res.height, angle: res.angle };
    if (!res.ok) throw new Error(res.error);
    throw new Error('Unexpected worker reply');
  } catch (err) {
    if (err instanceof Error && err.message !== 'no-worker' && !broken) throw err;
    const { preprocess, grayToPgm } = await import('@/extract/image');
    const pre = preprocess(image.data, width, height, photo);
    return { pgm: grayToPgm(pre.gray, pre.width, pre.height), width: pre.width, height: pre.height, angle: pre.angle };
  }
}
