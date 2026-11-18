import type { Canvas, SKRSContext2D } from '@napi-rs/canvas';

export interface RenderedPage {
  page: number;
  png: Buffer;
  width: number;
  height: number;
  canvas: Canvas;
  ctx: SKRSContext2D;
}

export function pdfToPngs(data: Uint8Array | Buffer, dpi?: number, options?: { pages?: number[] }): Promise<RenderedPage[]>;
