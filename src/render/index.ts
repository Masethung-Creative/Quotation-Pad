import type { RenderRequest, RenderResult, SignRequest } from './core';
import type { RenderWorkerRequest, RenderWorkerResponse } from './render.worker';

/**
 * Main-thread entry for rendering. Work goes to the render worker so the screen never
 * freezes; if the worker cannot start (very old WebView), the same code runs here.
 */

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (r: RenderResult) => void; reject: (e: Error) => void }>();

class WorkerUnavailable extends Error {}

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module', name: 'qp-render' });
    worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
      const p = pending.get(event.data.id);
      if (!p) return;
      pending.delete(event.data.id);
      if (event.data.ok) p.resolve({ pdf: new Uint8Array(event.data.pdf), pages: event.data.pages, slot: event.data.slot });
      else p.reject(new Error(event.data.error));
    };
    worker.onerror = () => {
      workerBroken = true;
      worker?.terminate();
      worker = null;
      pending.forEach((p) => p.reject(new WorkerUnavailable('render worker failed')));
      pending.clear();
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

type Message = RenderWorkerRequest extends infer M ? (M extends { id: number } ? Omit<M, 'id'> : never) : never;

function post(message: Message): Promise<RenderResult> {
  const w = getWorker();
  if (!w) return Promise.reject(new WorkerUnavailable('no worker'));
  const id = ++seq;
  return new Promise<RenderResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...message, id } as RenderWorkerRequest);
  });
}

export async function renderOnTemplate(request: RenderRequest): Promise<RenderResult> {
  try {
    return await post({ kind: 'render', request });
  } catch (err) {
    if (!(err instanceof WorkerUnavailable)) throw err;
    const { renderPdf } = await import('./core');
    return renderPdf(request);
  }
}

export async function addSignature(request: SignRequest): Promise<Uint8Array> {
  try {
    return (await post({ kind: 'sign', request })).pdf;
  } catch (err) {
    if (!(err instanceof WorkerUnavailable)) throw err;
    const { signPdf } = await import('./core');
    return signPdf(request);
  }
}

export type { RenderRequest, RenderResult, SignRequest } from './core';
export type { SignatureSlot, TemplateInput } from './docdef';
