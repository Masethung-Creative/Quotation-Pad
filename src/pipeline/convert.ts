import { splitPairs } from '@/render/body';
import { blobBytes, db, signaturePosition, storable, type Conversion, type SavedSignature } from '@/db/db';
import type { ExtractOptions } from '@/extract';
import type { ExtractResult } from '@/extract/types';
import { detectFile, type FileKind } from '@/ingest/detect';
import { formatDateDMY } from '@/lib/format';
import { uid } from '@/lib/utils';
import type { RenderResult } from '@/render';
import { resolveForTemplate } from '@/render/docdef';
import { DEFAULT_OFFSET } from '@/render/signature';
import type { CanonicalDoc } from '@/schema/canonical';
import { docText } from '@/schema/canonical';
import { loadTemplateBundle } from '@/templates';
import type { TemplateDef } from '@/templates/schema';
import { asciiTokens, compareCoverage, type CoverageReport } from '@/validate/coverage';

/** Glue between the pipeline steps and IndexedDB. */

/**
 * Every quotation ends with the company's signature block. A block found in the source is
 * switched to the template's own ("For <Company>", signatory, designation), keeping the
 * original lines for the content check; without one, the template's block is added.
 */
export function withTemplateSignature(doc: CanonicalDoc): CanonicalDoc {
  const blocks = [...doc.blocks];
  const at = blocks.findIndex((b) => b.type === 'signature');
  if (at >= 0) {
    const sig = blocks[at];
    if (sig.type === 'signature' && sig.auto === undefined) blocks[at] = { ...sig, auto: true };
    return { ...doc, blocks };
  }
  return { ...doc, blocks: [...blocks, { type: 'signature', lines: [], auto: true }] };
}

export async function runExtraction(file: Blob, kind: FileKind, options: ExtractOptions): Promise<ExtractResult> {
  const { extractFile } = await import('@/extract');
  const result = await extractFile(file, kind, options);
  return { ...result, doc: withTemplateSignature(result.doc) };
}

/**
 * Bump when the reader gets better at a kind of file, so quotations read by an older
 * version are read again (2: ruled boxes in PDFs, layout tables and tab tables in Word;
 * 3: the document type becomes the title; 4: Word files record their real page count).
 */
export const EXTRACTOR_VERSION = 4;

/** Kinds of file the latest reader improved; scans are not re-read (OCR is slow). */
const IMPROVED: ExtractResult['method'][] = ['pdf-text', 'pdf-mixed', 'docx'];

/**
 * A quotation read by an older version and never edited is read again from its stored
 * original, so opening it shows what the app produces today. Returns the fresh record.
 */
export async function refreshIfOutdated(conversion: Conversion, options: ExtractOptions): Promise<Conversion> {
  const outdated = (conversion.extractor ?? 1) < EXTRACTOR_VERSION && !conversion.edited_json && !!conversion.original_file && conversion.method !== null && IMPROVED.includes(conversion.method);
  if (!outdated) return conversion;
  try {
    await reExtract(conversion, options);
  } catch {
    // Keep the old result rather than failing to open it.
    await db.conversions.update(conversion.id, { extractor: EXTRACTOR_VERSION });
  }
  return (await db.conversions.get(conversion.id)) ?? conversion;
}

/** Saving normally takes milliseconds; some phone browsers' storage can stall instead of failing. */
const SAVE_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Saving on this device took too long')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Ingest + extract a new upload and store it as a conversion. Returns the conversion id. */
export async function createConversion(file: File, options: ExtractOptions): Promise<string> {
  const kind = await detectFile(file);
  const result = await runExtraction(file, kind, options);
  const id = uid();
  const record: Conversion = {
    id,
    name: file.name || 'Quotation',
    original_file: await storable(file),
    original_type: kind,
    extracted_json: result.doc,
    edited_json: null,
    template_id: null,
    sign: { on: false, signature_id: null },
    output_pdf: null,
    output_name: null,
    output_docx: null,
    status: 'extracted',
    created_at: Date.now(),
    source_text: result.sourceText,
    removed: result.removed,
    warnings: result.warnings,
    method: result.method,
    pages: result.pages,
    output_pages: 0,
    error: null,
    extractor: EXTRACTOR_VERSION,
  };
  try {
    await withTimeout(db.conversions.add(record), SAVE_TIMEOUT_MS);
  } catch {
    // Phone storage full, blocked or stuck: keep the quotation, but without its original
    // file (only needed for "read again"), which is by far the biggest part of the record.
    // If even that does not finish, the upload screen shows "Try again" instead of hanging.
    await withTimeout(db.conversions.put({ ...record, original_file: null }), SAVE_TIMEOUT_MS);
  }
  return id;
}

/** Runs extraction again on the stored original (e.g. forcing OCR when a PDF's text layer is garbled). */
export async function reExtract(conversion: Conversion, options: ExtractOptions): Promise<void> {
  if (!conversion.original_file) throw new Error('The original file is no longer stored on this device.');
  const result = await runExtraction(conversion.original_file, conversion.original_type, options);
  await db.conversions.update(conversion.id, {
    extracted_json: result.doc,
    edited_json: null,
    output_pdf: null,
    status: 'extracted',
    source_text: result.sourceText,
    removed: result.removed,
    warnings: result.warnings,
    method: result.method,
    pages: result.pages,
    output_pages: 0,
    error: null,
    extractor: EXTRACTOR_VERSION,
  });
}

export function currentDoc(conversion: Conversion): CanonicalDoc | null {
  return conversion.edited_json ?? conversion.extracted_json;
}

// ---------------------------------------------------------------------------------------
// Rendering (with a small cache: thumbnails, preview and the final PDF reuse each other)
// ---------------------------------------------------------------------------------------

function hash(text: string): string {
  // FNV-1a, enough to tell documents apart in a tiny in-memory cache.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}-${text.length}`;
}

const cache = new Map<string, Promise<RenderResult>>();
const CACHE_LIMIT = 8;

export function renderKey(doc: CanonicalDoc, templateId: string, fitPages = 0): string {
  return `${templateId}|${fitPages}|${hash(JSON.stringify(doc.blocks))}`;
}

/**
 * @param fitPages pages of the original quotation; the layout is tightened (within limits)
 *   so a one-page quotation stays one page on the letterhead.
 */
export function renderForTemplate(doc: CanonicalDoc, templateId: string, title?: string, fitPages = 0): Promise<RenderResult> {
  const key = renderKey(doc, templateId, fitPages);
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      const [{ renderOnTemplate }, template] = await Promise.all([import('@/render'), loadTemplateBundle(templateId)]);
      return renderOnTemplate({ doc, template, title, fitPages });
    })();
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  return hit;
}

/** The finished PDF: the rendered pages plus the signature when it is switched on. */
export async function finalPdf(rendered: RenderResult, templateId: string, signature: SavedSignature | null, title?: string): Promise<Uint8Array> {
  if (!signature || !rendered.slot) return rendered.pdf;
  const [{ addSignature }, offset, png] = await Promise.all([import('@/render'), signaturePosition.get(templateId), blobBytes(signature.png)]);
  return addSignature({
    pdf: rendered.pdf,
    slot: rendered.slot,
    offset: offset ?? DEFAULT_OFFSET,
    png,
    imageWidth: signature.width,
    imageHeight: signature.height,
    title,
  });
}

/**
 * Final safety net: read the text back out of the finished PDF and compare it with what
 * should have been printed. Only Latin words and numbers are compared, because Tamil and
 * Hindi glyphs do not survive a PDF text round trip reliably.
 */
export async function verifyOutput(pdf: Uint8Array, doc: CanonicalDoc, def: TemplateDef): Promise<CoverageReport> {
  const { openPdf } = await import('@/extract/pdfjs');
  const { doc: pdfDoc, close } = await openPdf(pdf);
  let text = '';
  try {
    for (let n = 1; n <= pdfDoc.numPages; n++) {
      const content = await (await pdfDoc.getPage(n)).getTextContent();
      text += content.items.map((item) => ('str' in item ? item.str : '')).join(' ') + '\n';
    }
  } finally {
    await close().catch(() => undefined);
  }
  return compareCoverage(asciiTokens(docText(resolveForTemplate(doc, def))), asciiTokens(text));
}

// ---------------------------------------------------------------------------------------
// File name: <Bill No> - <Letterpad name>.pdf
// ---------------------------------------------------------------------------------------

const COMPANY_RE = /\b(pvt|private|ltd|limited|llp|inc|corporation|corp|company|co\.|industries|enterprises?|traders?|trading|mills|works|agencies|associates|solutions|systems|electricals?|engineering|constructions?|hospital|school|college|bank|society|trust|foundation)\b|^m\/s\.?\s|&/i;
const ROLE_RE = /^(the\s+)?(purchase|managing|general|project|accounts?|store|stores|site)?\s*(manager|director|officer|engineer|head|in-?charge|proprietor|partner|secretary|chairman|incharge|purchase)\b|^(sir|madam|dear)\b|^kind(ly)?\s+attn|^attn/i;

/** The customer's name from the "To," address, if it can be found. */
export function customerName(doc: CanonicalDoc): string | null {
  for (const block of doc.blocks) {
    if (block.type !== 'paragraph') continue;
    const lines = block.runs
      .map((r) => r.text)
      .join('')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const to = lines.findIndex((l) => /^to\s*[,:]?$/i.test(l));
    if (to < 0) continue;
    const candidates = lines.slice(to + 1, to + 5).map((l) => l.replace(/[,.]+$/, '').trim());
    const named = candidates.find((l) => COMPANY_RE.test(l) && !ROLE_RE.test(l));
    const first = candidates.find((l) => !ROLE_RE.test(l) && /[a-z]/i.test(l) && !/^\d/.test(l));
    const pick = (named ?? first)?.replace(/^m\/s\.?\s*/i, '');
    if (pick) return pick;
  }
  return null;
}

export function referenceNumber(doc: CanonicalDoc): string | null {
  for (const block of doc.blocks) {
    if (block.type !== 'meta') continue;
    const item = block.items.find((i) => /ref|quotation|quote|qtn|offer/i.test(i.label) && !/date/i.test(i.label));
    if (item?.value.trim()) return item.value.trim();
  }
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The quotation's own date (DD-MM-YYYY), when the document states one. */
export function quotationDate(doc: CanonicalDoc): string | null {
  for (const block of doc.blocks) {
    if (block.type !== 'meta') continue;
    const item = block.items.find((i) => /date/i.test(i.label) && !/valid|due|delivery/i.test(i.label));
    const v = item?.value.trim();
    if (!v) continue;
    let m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
    if (m) {
      const year = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}-${year}`;
    }
    m = v.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3})[a-z]*[\s,-]+(\d{4})$/i);
    if (m && MONTHS.includes(m[2].toLowerCase())) {
      return `${m[1].padStart(2, '0')}-${String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[3]}`;
    }
  }
  return null;
}

/** Turns free text into a safe file-name part: letters, digits and hyphens. */
export function filePart(text: string, max = 40): string {
  return (
    text
      .normalize('NFKC')
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || ''
  );
}

/** Every "label: value" written in the document: reference details, the details box, text lines. */
function labelledValues(doc: CanonicalDoc): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const fromText = (text: string) => {
    for (const line of text.split('\n')) for (const p of splitPairs(line) ?? []) if (p.value) out.push(p);
  };
  for (const block of doc.blocks) {
    if (block.type === 'meta') out.push(...block.items);
    else if (block.type === 'table') block.rows.slice(0, 3).forEach((row) => row.forEach(fromText));
    else if (block.type === 'paragraph') fromText(block.runs.map((r) => r.text).join(''));
  }
  return out;
}

const NUMBER_LABEL = /\b(no|number|num|#)\b\.?$|\bno\.?\s*$/i;
const BILL_LABELS = [
  /\b(bill|invoice|inv)\b/i,
  /\b(quotation|quote|qtn|estimate|proforma|offer)\b/i,
  /\bref(erence)?\b/i,
];

/** The bill / invoice / quotation number the document gives itself (not the customer's PO number). */
export function billNumber(doc: CanonicalDoc): string | null {
  const pairs = labelledValues(doc).filter((p) => !/date|vendor|gst|pan|p\.?\s*o\b|order|enquiry|enq|mobile|phone|cell/i.test(p.label));
  for (const kind of BILL_LABELS) {
    const hit = pairs.find((p) => kind.test(p.label) && (NUMBER_LABEL.test(p.label.trim()) || /^ref(erence)?$/i.test(p.label.trim())));
    const value = hit?.value.trim().split(/\s{2,}/)[0];
    if (value) return value;
  }
  return null;
}

/**
 * Download name: "<Bill No> - <Letterpad name>.pdf", e.g. "334 - Mass Service Tech.pdf".
 * Without a number: the customer, else the date, in its place.
 */
export function outputFileName(def: TemplateDef, doc: CanonicalDoc, createdAt: number): string {
  const pad = def.display_name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Quotation';
  const first = filePart(billNumber(doc) ?? '', 40) || filePart(customerName(doc) ?? '', 40) || (quotationDate(doc) ?? formatDateDMY(new Date(createdAt)));
  return `${first} - ${pad}.pdf`;
}
