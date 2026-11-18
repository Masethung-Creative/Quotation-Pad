import { blobBytes, db, signaturePosition, type Conversion, type SavedSignature } from '@/db/db';
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
 * version are read again (2: ruled boxes in PDFs, layout tables and tab tables in Word).
 */
export const EXTRACTOR_VERSION = 2;

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

/** Ingest + extract a new upload and store it as a conversion. Returns the conversion id. */
export async function createConversion(file: File, options: ExtractOptions): Promise<string> {
  const kind = await detectFile(file);
  const result = await runExtraction(file, kind, options);
  const id = uid();
  const record: Conversion = {
    id,
    name: file.name || 'Quotation',
    original_file: file,
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
  await db.conversions.add(record);
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

export function renderKey(doc: CanonicalDoc, templateId: string): string {
  return `${templateId}|${hash(JSON.stringify(doc.blocks))}`;
}

export function renderForTemplate(doc: CanonicalDoc, templateId: string, title?: string): Promise<RenderResult> {
  const key = renderKey(doc, templateId);
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      const [{ renderOnTemplate }, template] = await Promise.all([import('@/render'), loadTemplateBundle(templateId)]);
      return renderOnTemplate({ doc, template, title });
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
// File name: <template>_<customer or ref>_<DD-MM-YYYY>.pdf
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

export function outputFileName(def: TemplateDef, doc: CanonicalDoc, createdAt: number): string {
  const who = filePart(customerName(doc) ?? referenceNumber(doc) ?? '') || 'Quotation';
  const date = quotationDate(doc) ?? formatDateDMY(new Date(createdAt));
  return `${filePart(def.file_prefix ?? def.display_name, 30) || 'Quotation'}_${who}_${date}.pdf`;
}
