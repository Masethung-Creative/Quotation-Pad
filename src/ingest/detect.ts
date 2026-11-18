/** File type detection by magic bytes first, MIME / extension second. */

export type FileKind = 'pdf' | 'docx' | 'jpg' | 'png' | 'webp' | 'heic' | 'json';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class IngestError extends Error {
  code: 'too-large' | 'legacy-doc' | 'unsupported' | 'empty';
  constructor(code: IngestError['code'], message: string) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
  }
}

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + length)));

function includesAscii(bytes: Uint8Array, needle: string): boolean {
  const n = needle.length;
  outer: for (let i = 0; i <= bytes.length - n; i++) {
    for (let j = 0; j < n; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];

/** Pure detection on the file's bytes. `head` should hold at least the first 64 KB. */
export function sniff(head: Uint8Array, tail: Uint8Array, name: string, mime: string): FileKind | 'doc' | 'unknown' {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (head.length >= 5 && includesAscii(head.subarray(0, 1024), '%PDF-')) return 'pdf';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head[0] === 0x89 && ascii(head, 1, 3) === 'PNG') return 'png';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'webp';
  if (ascii(head, 4, 4) === 'ftyp') {
    const brands = ascii(head, 8, 24);
    if (HEIC_BRANDS.some((b) => brands.includes(b))) return 'heic';
  }
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)) {
    // A zip container: only Word documents are accepted.
    if (includesAscii(head, 'word/') || includesAscii(tail, 'word/document.xml')) return 'docx';
    if (ext === 'docx' && !includesAscii(tail, 'xl/') && !includesAscii(tail, 'ppt/')) return 'docx';
    return 'unknown';
  }
  // OLE2 compound file = legacy .doc (or .xls/.ppt); RTF is treated the same way.
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'doc';
  if (ascii(head, 0, 5) === '{\\rtf') return 'doc';
  if (ext === 'doc' || mime === 'application/msword') return 'doc';
  if (ext === 'json' || mime === 'application/json') {
    const text = ascii(head, 0, 64).replace(/^\xEF\xBB\xBF/, '').trimStart();
    if (text.startsWith('{')) return 'json';
  }
  return 'unknown';
}

export async function detectFile(file: File): Promise<FileKind> {
  if (file.size === 0) throw new IngestError('empty', 'This file is empty. Please choose another file.');
  if (file.size > MAX_FILE_BYTES) {
    throw new IngestError('too-large', `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 20 MB.`);
  }
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 65536)).arrayBuffer());
  const kind = sniff(head, tail, file.name, file.type);
  if (kind === 'doc') throw new IngestError('legacy-doc', 'Please save this as .docx or PDF and upload again.');
  if (kind === 'unknown') {
    throw new IngestError('unsupported', 'This file type is not supported. Upload a PDF, a Word (.docx) file or a photo (JPG, PNG, HEIC).');
  }
  return kind;
}

export const KIND_LABEL: Record<FileKind, string> = {
  pdf: 'PDF',
  docx: 'Word',
  jpg: 'Photo',
  png: 'Image',
  webp: 'Image',
  heic: 'Photo',
  json: 'JSON',
};

export const ACCEPT_ATTR =
  '.pdf,.docx,.doc,.jpg,.jpeg,.png,.heic,.heif,.webp,.json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png,image/heic,image/heif,image/webp';
