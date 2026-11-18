import type { SignatureSlot } from './docdef';
import type { Placement } from './stamp';

/**
 * Where a signature image is drawn. The template reserves a box (default 40 x 15 mm) above
 * the signatory name; the user can drag / pinch it, which is stored per template as an
 * offset in mm and a scale. The same maths drives the on-screen overlay and the PDF.
 */

export interface SignatureOffset {
  /** Millimetres right of the template's default position. */
  dx: number;
  /** Millimetres below the template's default position. */
  dy: number;
  scale: number;
}

export const DEFAULT_OFFSET: SignatureOffset = { dx: 0, dy: 0, scale: 1 };
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 2.5;

const MM = 72 / 25.4;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number.isFinite(scale) ? scale : 1));
}

/**
 * The box (points, top-left origin) the signature occupies, kept inside the page's safe
 * area so it can never cover the template header or footer.
 */
export function signatureBox(slot: SignatureSlot, offset: SignatureOffset): Placement {
  const scale = clampScale(offset.scale);
  const w = Math.min(slot.w * scale, slot.bounds.w);
  const h = Math.min(slot.h * scale, slot.bounds.h);
  // Scaling keeps the bottom-centre of the box (the signature "sits" on the name line).
  let x = slot.x + (slot.w - w) / 2 + offset.dx * MM;
  let y = slot.y + (slot.h - h) + offset.dy * MM;
  x = Math.min(Math.max(x, slot.bounds.x), slot.bounds.x + slot.bounds.w - w);
  y = Math.min(Math.max(y, slot.bounds.y), slot.bounds.y + slot.bounds.h - h);
  return { page: slot.page, x, y, w, h };
}

/** The image inside the box: as large as fits, centred, resting on the bottom edge. */
export function fitImage(box: Placement, imageWidth: number, imageHeight: number): Placement {
  const aspect = imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : box.w / box.h;
  let w = box.w;
  let h = w / aspect;
  if (h > box.h) {
    h = box.h;
    w = h * aspect;
  }
  return { page: box.page, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h), w, h };
}

/** Turns a dragged box back into a stored offset. */
export function offsetFromBox(slot: SignatureSlot, box: { x: number; y: number; w: number }): SignatureOffset {
  const scale = clampScale(box.w / slot.w);
  const w = slot.w * scale;
  const h = slot.h * scale;
  const baseX = slot.x + (slot.w - w) / 2;
  const baseY = slot.y + (slot.h - h);
  const round = (v: number) => Math.round(v * 10) / 10;
  return { dx: round((box.x - baseX) / MM), dy: round((box.y - baseY) / MM), scale: Math.round(scale * 100) / 100 };
}
