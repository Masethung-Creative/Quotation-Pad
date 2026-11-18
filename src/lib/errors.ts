import { IngestError } from '@/ingest/detect';

/**
 * Turns anything that can go wrong while reading a file into a plain-English message
 * and the right "Try again" action.
 */

/** Thrown when the phone cannot give us enough memory (huge photo, many-page scan). */
export class LowMemoryError extends Error {
  constructor(message = 'Not enough memory') {
    super(message);
    this.name = 'LowMemoryError';
  }
}

export type ErrorKind = 'too-large' | 'legacy-doc' | 'unsupported' | 'empty' | 'password' | 'unreadable' | 'memory' | 'storage' | 'unknown';

export interface FriendlyError {
  kind: ErrorKind;
  title: string;
  message: string;
  /** What "Try again" does: choose another file, retry the same file, or retry it using less memory. */
  retry: 'pick' | 'same' | 'low-memory';
}

const MESSAGES: Record<ErrorKind, Omit<FriendlyError, 'kind'>> = {
  'too-large': {
    title: 'This file is too large',
    message: 'For a long scan, upload only the quotation pages, or take photos of them instead.',
    retry: 'pick',
  },
  'legacy-doc': {
    title: 'Old Word format',
    message: 'Please save this as .docx or PDF and upload again.',
    retry: 'pick',
  },
  unsupported: {
    title: 'This type of file cannot be read',
    message: 'Upload a PDF, a Word (.docx) file or a photo (JPG, PNG or HEIC).',
    retry: 'pick',
  },
  empty: {
    title: 'This file is empty',
    message: 'The file has no content. It may not have downloaded fully - download it again, then upload it.',
    retry: 'pick',
  },
  password: {
    title: 'This PDF is locked with a password',
    message: 'Open it, then save or print it as a new PDF without a password, and upload that copy.',
    retry: 'pick',
  },
  unreadable: {
    title: 'This file could not be read',
    message: 'It may be damaged or only partly downloaded. Download it again and upload the new copy, or take a photo of the printed quotation.',
    retry: 'pick',
  },
  memory: {
    title: 'Your phone ran out of memory',
    message: 'Close other apps and tap Try again. The page will be read at a lower resolution, which needs less memory.',
    retry: 'low-memory',
  },
  storage: {
    title: 'Storage is full',
    message: 'There is no room left to save this quotation. Delete old quotations in Settings, then try again.',
    retry: 'same',
  },
  unknown: {
    title: 'Something went wrong',
    message: 'The file could not be read this time. Please try again.',
    retry: 'same',
  },
};

function messageOf(err: unknown): string {
  if (err instanceof Error) return `${err.name} ${err.message}`;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

export function classifyError(err: unknown): ErrorKind {
  if (err instanceof IngestError) return err.code === 'legacy-doc' ? 'legacy-doc' : err.code === 'too-large' ? 'too-large' : err.code === 'empty' ? 'empty' : 'unsupported';
  if (err instanceof LowMemoryError) return 'memory';
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  const text = messageOf(err);
  if (name === 'PasswordException' || /password/i.test(text)) return 'password';
  if (name === 'QuotaExceededError' || /quota/i.test(text)) return 'storage';
  if (
    name === 'LowMemoryError' ||
    /out of memory|\boom\b|abort\(oom\)|cannot enlarge memory|allocation failed|array buffer allocation|memory access out of bounds|not enough memory|maximum call stack/i.test(text) ||
    (err instanceof RangeError && /buffer|memory|length/i.test(text))
  ) {
    return 'memory';
  }
  if (
    /InvalidPDFException|Invalid PDF|FormatError|UnknownErrorException|bad XRef|end of central directory|corrupted zip|is this a zip|Could not find file|could not be opened|EncodingError|source image cannot be decoded|Unexpected token|JSON|not a valid|heic|HEIF|LIBHEIF|ERR_LIBHEIF/i.test(
      text,
    ) ||
    name === 'InvalidPDFException' ||
    name === 'EncodingError' ||
    name === 'SyntaxError' ||
    name === 'ZodError'
  ) {
    return 'unreadable';
  }
  return 'unknown';
}

export function friendlyError(err: unknown): FriendlyError {
  const kind = classifyError(err);
  const base = MESSAGES[kind];
  // An ingest error already carries the exact wording we want (e.g. the file size).
  if (err instanceof IngestError && kind === 'too-large') return { kind, ...base, message: `${err.message} ${base.message}` };
  return { kind, ...base };
}
