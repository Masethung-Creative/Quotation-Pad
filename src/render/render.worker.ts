/// <reference lib="webworker" />
import { renderPdf, signPdf, type RenderRequest, type SignRequest } from './core';
import type { SignatureSlot } from './docdef';

/** PDF layout (pdfmake) and stamping (pdf-lib) off the main thread, so the screen never freezes. */

export type RenderWorkerRequest = { id: number; kind: 'render'; request: RenderRequest } | { id: number; kind: 'sign'; request: SignRequest };

export type RenderWorkerResponse =
  | { id: number; ok: true; pdf: ArrayBuffer; pages: number; slot: SignatureSlot | null }
  | { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

scope.onmessage = async (event: MessageEvent<RenderWorkerRequest>) => {
  const message = event.data;
  try {
    if (message.kind === 'render') {
      const result = await renderPdf(message.request);
      const buffer = toBuffer(result.pdf);
      scope.postMessage({ id: message.id, ok: true, pdf: buffer, pages: result.pages, slot: result.slot } satisfies RenderWorkerResponse, [buffer]);
    } else {
      const pdf = await signPdf(message.request);
      const buffer = toBuffer(pdf);
      scope.postMessage({ id: message.id, ok: true, pdf: buffer, pages: 0, slot: message.request.slot } satisfies RenderWorkerResponse, [buffer]);
    }
  } catch (err) {
    scope.postMessage({ id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies RenderWorkerResponse);
  }
};
