/// <reference lib="webworker" />
import { docxToHtml } from '@/extract/docx';
import { grayToPgm, preprocess } from '@/extract/image';

/** Off-main-thread work for extraction: Word conversion and image clean-up for OCR. */

export type ExtractRequest =
  | { id: number; type: 'docx'; buffer: ArrayBuffer }
  | { id: number; type: 'preprocess'; rgba: ArrayBuffer; width: number; height: number; photo: boolean };

export type ExtractResponse =
  | { id: number; ok: true; type: 'docx'; html: string; messages: string[] }
  | { id: number; ok: true; type: 'preprocess'; pgm: ArrayBuffer; width: number; height: number; angle: number }
  | { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<ExtractRequest>) => {
  const req = event.data;
  try {
    if (req.type === 'docx') {
      const res = await docxToHtml(req.buffer);
      scope.postMessage({ id: req.id, ok: true, type: 'docx', html: res.html, messages: res.messages } satisfies ExtractResponse);
    } else {
      const pre = preprocess(new Uint8ClampedArray(req.rgba), req.width, req.height, req.photo);
      const pgm = grayToPgm(pre.gray, pre.width, pre.height);
      const buffer = pgm.buffer as ArrayBuffer;
      scope.postMessage(
        { id: req.id, ok: true, type: 'preprocess', pgm: buffer, width: pre.width, height: pre.height, angle: pre.angle } satisfies ExtractResponse,
        [buffer],
      );
    }
  } catch (err) {
    scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ExtractResponse);
  }
};
