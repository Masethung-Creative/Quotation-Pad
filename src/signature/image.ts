import { decodeImage, heicToJpeg } from '@/ingest/image';
import { sniff } from '@/ingest/detect';
import { LowMemoryError } from '@/lib/errors';
import { cropToInk, extractSignature, NoSignatureError, recolour, type InkColour, type InkImage } from './process';

/** Browser side of signatures: files and canvases in, transparent PNG blobs out. */

export interface SignaturePng {
  blob: Blob;
  width: number;
  height: number;
  /** Preview URL; revoke when done. */
  url: string;
}

export function inkToPng(img: InkImage): Promise<SignaturePng> {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new LowMemoryError();
  ctx.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve({ blob, width: img.width, height: img.height, url: URL.createObjectURL(blob) }) : reject(new Error('Could not save the signature.'))), 'image/png'),
  );
}

/** Photo of a signature on white paper -> ink only, transparent background. */
export async function photoToInk(file: Blob & { name?: string }, ink: InkColour): Promise<InkImage> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const kind = sniff(head, new Uint8Array(0), file.name ?? '', file.type);
  if (!['jpg', 'png', 'webp', 'heic'].includes(kind)) throw new NoSignatureError('Please choose a photo (JPG, PNG or HEIC) of the signature.');
  const source = kind === 'heic' ? await heicToJpeg(file) : file;
  // About 1600 px across is plenty for a 40 mm signature and keeps this quick on a phone.
  const { canvas, width, height } = await decodeImage(source, 1600, 2_500_000);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new LowMemoryError();
  const data = ctx.getImageData(0, 0, width, height).data;
  canvas.width = canvas.height = 0;
  return extractSignature(data, width, height, { ink, photo: true });
}

/** Finger / mouse drawing (transparent canvas) -> cropped ink. */
export function canvasToInk(canvas: HTMLCanvasElement, ink: InkColour): InkImage {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new LowMemoryError();
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return recolour(cropToInk({ data, width, height }), ink);
}
