import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, getSettings, lastTemplate, purgeOldOriginals, saveSetting, signaturePosition, type Conversion } from '@/db/db';

const DAY = 24 * 60 * 60 * 1000;

function conversion(id: string, ageDays: number, now: number): Conversion {
  return {
    id,
    name: `${id}.pdf`,
    original_file: new Blob(['original']),
    original_type: 'pdf',
    extracted_json: { blocks: [], confidence: {} },
    edited_json: null,
    template_id: 'kaveri-trading',
    sign: { on: false, signature_id: null },
    output_pdf: new Blob(['pdf']),
    output_name: null,
    output_docx: null,
    status: 'rendered',
    created_at: now - ageDays * DAY,
    source_text: '',
    removed: [],
    warnings: [],
    method: 'pdf-text',
    pages: 1,
    output_pages: 1,
    error: null,
  };
}

beforeEach(async () => {
  await db.conversions.clear();
  await db.settings.clear();
  await db.signatures.clear();
});

describe('settings', () => {
  it('has sensible defaults and remembers changes', async () => {
    expect(await getSettings()).toEqual({ retention_days: 90, ocr_langs: ['eng'] });
    await saveSetting('ocr_langs', ['eng', 'tam']);
    expect((await getSettings()).ocr_langs).toEqual(['eng', 'tam']);
  });

  it('remembers the last template and the signature position per template', async () => {
    expect(await lastTemplate.get()).toBeNull();
    await lastTemplate.set('greenleaf-agro');
    expect(await lastTemplate.get()).toBe('greenleaf-agro');
    await signaturePosition.set('kaveri-trading', { dx: 4, dy: -2, scale: 1.2 });
    expect(await signaturePosition.get('kaveri-trading')).toEqual({ dx: 4, dy: -2, scale: 1.2 });
    expect(await signaturePosition.get('greenleaf-agro')).toBeNull();
  });
});

describe('auto-delete of original uploads', () => {
  it('removes originals older than 90 days but keeps the content and the PDF', async () => {
    const now = Date.now();
    await db.conversions.bulkAdd([conversion('old', 120, now), conversion('recent', 10, now)]);
    expect(await purgeOldOriginals(now)).toBe(1);
    const old = await db.conversions.get('old');
    expect(old?.original_file).toBeNull();
    expect(old?.output_pdf).not.toBeNull();
    expect(old?.extracted_json).not.toBeNull();
    expect((await db.conversions.get('recent'))?.original_file).not.toBeNull();
  });

  it('follows the configured period, and 0 keeps originals forever', async () => {
    const now = Date.now();
    await db.conversions.bulkAdd([conversion('a', 40, now), conversion('b', 400, now)]);
    await saveSetting('retention_days', 0);
    expect(await purgeOldOriginals(now)).toBe(0);
    await saveSetting('retention_days', 30);
    expect(await purgeOldOriginals(now)).toBe(2);
  });
});

describe('upgrade from the first database version', () => {
  it('drops the old letterpads and gives old quotations the new fields', async () => {
    const name = 'qp-upgrade-test';
    const v1 = new Dexie(name);
    v1.version(1).stores({ letterpads: 'id, created_at', conversions: 'id, letterpad_id, created_at, status', settings: 'key' });
    await v1.table('letterpads').add({ id: 'lp1', created_at: 1 });
    await v1.table('conversions').add({ id: 'c1', letterpad_id: 'lp1', created_at: 1, status: 'rendered' });
    v1.close();

    const { db: _unused, ...rest } = await import('@/db/db');
    void _unused;
    void rest;
    // Open the same database with the app's current schema.
    const QuotationPadDB = (db.constructor as unknown as new (name: string) => typeof db);
    const upgraded = new QuotationPadDB(name);
    await upgraded.open();
    expect(upgraded.tables.map((t) => t.name).sort()).toEqual(['conversions', 'settings', 'signatures']);
    const c = (await upgraded.conversions.get('c1')) as unknown as Record<string, unknown>;
    expect(c.letterpad_id).toBeUndefined();
    expect(c.template_id).toBeNull();
    expect(c.sign).toEqual({ on: false, signature_id: null });
    upgraded.close();
  });
});
