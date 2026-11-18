import { LowMemoryError } from '@/lib/errors';

/** Decoding photos (including iPhone HEIC) into a canvas, on the device. */

export async function heicToJpeg(blob: Blob): Promise<Blob> {
  // Safari decodes HEIC natively; try that first because it is fast and needs no download.
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    canvas.width = canvas.height = 0;
    if (out) return out;
  } catch {
    // Not supported natively (Chrome / Android): fall through to the JS decoder.
  }
  const { default: heic2any } = await import('heic2any');
  const result = await heic2any({ blob, toType: 'image/jpeg', quality: 0.92 });
  return Array.isArray(result) ? result[0] : result;
}

export interface DecodedImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/**
 * Draws a photo onto a canvas sized for OCR: the long side is brought to roughly an A4 page
 * at 300 dpi (downscaling huge camera photos, upscaling small screenshots).
 */
export async function decodeImage(blob: Blob, targetLongSide = 3300, maxPixels = 9_000_000): Promise<DecodedImage> {
  let source: ImageBitmap | HTMLImageElement;
  let url: string | null = null;
  try {
    source = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    url = URL.createObjectURL(blob);
    source = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This picture could not be opened.'));
      img.src = url!;
    });
  }
  const sw = source.width;
  const sh = source.height;
  if (!sw || !sh) throw new Error('This picture could not be opened.');
  let scale = targetLongSide / Math.max(sw, sh);
  scale = Math.min(scale, 2.5);
  if (sw * sh * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (sw * sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new LowMemoryError();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  if ('close' in source) source.close();
  if (url) URL.revokeObjectURL(url);
  return { canvas, width, height };
}
