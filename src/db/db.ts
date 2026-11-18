import Dexie, { type EntityTable } from 'dexie';
import type { ExtractMethod } from '@/extract/types';
import type { OcrLang } from '@/extract/ocr';
import type { FileKind } from '@/ingest/detect';
import type { SignatureOffset } from '@/render/signature';
import type { CanonicalDoc } from '@/schema/canonical';

/**
 * Everything lives in IndexedDB on this device: quotations, saved signatures, settings.
 * Nothing is uploaded anywhere. Company templates are built into the app (src/templates).
 */

export type ConversionStatus = 'extracted' | 'reviewed' | 'rendered' | 'failed';

export interface SignChoice {
  /** "Add signature" toggle for this quotation (off by default). */
  on: boolean;
  signature_id: string | null;
}

export interface Conversion {
  id: string;
  name: string;
  /** Removed automatically after the retention period to save phone storage. */
  original_file: Blob | null;
  original_type: FileKind;
  extracted_json: CanonicalDoc | null;
  edited_json: CanonicalDoc | null;
  /** Chosen company template (null until one is picked). */
  template_id: string | null;
  sign: SignChoice;
  output_pdf: Blob | null;
  output_name: string | null;
  /** Phase 2. */
  output_docx: Blob | null;
  status: ConversionStatus;
  created_at: number;
  /** Source text for the "no content loss" comparison. */
  source_text: string;
  /** Lines left out on purpose: the sender's header/footer, page numbers, parts the user removed. */
  removed: string[];
  warnings: string[];
  method: ExtractMethod | null;
  pages: number;
  output_pages: number;
  error: string | null;
  /** Version of the reader that produced extracted_json (missing = 1). */
  extractor?: number;
}

/** A signature saved on this device only (never in the code, never uploaded). */
export interface SavedSignature {
  id: string;
  label: string;
  /** Transparent PNG: the ink only, cropped. */
  png: Blob;
  width: number;
  height: number;
  ink: 'blue' | 'black';
  source: 'drawn' | 'photo';
  created_at: number;
}

export interface Setting {
  key: string;
  value: unknown;
}

class QuotationPadDB extends Dexie {
  conversions!: EntityTable<Conversion, 'id'>;
  signatures!: EntityTable<SavedSignature, 'id'>;
  settings!: EntityTable<Setting, 'key'>;

  constructor(name = 'quotation-pad') {
    super(name);
    this.version(1).stores({
      letterpads: 'id, created_at',
      conversions: 'id, letterpad_id, created_at, status',
      settings: 'key',
    });
    // Phase 1: company templates are built in, letterpads are no longer uploaded.
    this.version(2)
      .stores({
        letterpads: null,
        conversions: 'id, template_id, created_at, status',
        signatures: 'id, created_at',
        settings: 'key',
      })
      .upgrade((tx) =>
        tx
          .table('conversions')
          .toCollection()
          .modify((c: Record<string, unknown>) => {
            delete c.letterpad_id;
            c.template_id ??= null;
            c.sign ??= { on: false, signature_id: null };
            c.output_name ??= null;
          }),
      );
  }
}

export const db = new QuotationPadDB();

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

export interface AppSettings {
  retention_days: number;
  ocr_langs: OcrLang[];
}

export const DEFAULT_SETTINGS: AppSettings = { retention_days: 90, ocr_langs: ['eng'] };

export async function getSettings(): Promise<AppSettings> {
  const [days, langs] = await Promise.all([getSetting<unknown>('retention_days', undefined), getSetting<unknown>('ocr_langs', undefined)]);
  return {
    retention_days: typeof days === 'number' && days >= 0 ? days : DEFAULT_SETTINGS.retention_days,
    ocr_langs: Array.isArray(langs) && langs.length ? (langs as OcrLang[]) : DEFAULT_SETTINGS.ocr_langs,
  };
}

export async function saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
  await setSetting(key, value);
}

/** Last template used: pre-selected next time. */
export const lastTemplate = {
  get: () => getSetting<string | null>('last_template', null),
  set: (id: string) => setSetting('last_template', id),
};

/** Where the signature sits on each template (dragged / pinched by the user). */
export const signaturePosition = {
  get: (templateId: string) => getSetting<SignatureOffset | null>(`sigpos:${templateId}`, null),
  set: (templateId: string, offset: SignatureOffset) => setSetting(`sigpos:${templateId}`, offset),
};

// ---------------------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------------------

/**
 * Deletes original uploads older than the retention period (default 90 days). The
 * extracted content and the finished PDF are kept, so old quotations stay available.
 * Returns how many originals were removed.
 */
export async function purgeOldOriginals(now = Date.now()): Promise<number> {
  const { retention_days } = await getSettings();
  if (retention_days <= 0) return 0;
  const cutoff = now - retention_days * 24 * 60 * 60 * 1000;
  const old = await db.conversions.where('created_at').below(cutoff).toArray();
  let removed = 0;
  for (const c of old) {
    if (c.original_file) {
      await db.conversions.update(c.id, { original_file: null });
      removed++;
    }
  }
  return removed;
}

/** Asks the browser not to evict our data when the phone runs low on space. */
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // Not supported: nothing to do.
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    return est ? { usage: est.usage ?? 0, quota: est.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
