import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, getSettings, lastTemplate, purgeOldOriginals, reviveBlobs, saveSetting, signaturePosition, storable, type Conversion } from '@/db/db';

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

describe('files on iPhones and iPads', () => {
  // Safari / WebKit reject Blob and File values in IndexedDB ("Error preparing Blob/File
  // data to be stored in object store"), so the app stores plain bytes instead.
  it('stores files as plain bytes and reads them back as Blobs', async () => {
    const now = Date.now();
    const file = new File(['%PDF-1.7 original'], 'q.pdf', { type: 'application/pdf' });
    await db.conversions.add({ ...conversion('blob1', 0, now), original_file: await storable(file), output_pdf: await storable(new Blob(['out'], { type: 'application/pdf' })) });

    // What is really in IndexedDB: no Blob anywhere.
    const raw = new Dexie('quotation-pad');
    await raw.open();
    const stored = (await raw.table('conversions').get('blob1')) as Record<string, unknown>;
    raw.close();
    expect(stored.original_file).not.toBeInstanceOf(Blob);
    expect(stored.output_pdf).not.toBeInstanceOf(Blob);

    // What the app sees: Blobs with the same bytes and type.
    const c = (await db.conversions.get('blob1'))!;
    expect(c.original_file).toBeInstanceOf(Blob);
    expect(c.original_file!.type).toBe('application/pdf');
    expect(await c.original_file!.text()).toBe('%PDF-1.7 original');
    expect(await c.output_pdf!.text()).toBe('out');
    // Also through queries, not only get().
    const [listed] = await db.conversions.where('id').equals('blob1').toArray();
    expect(await listed.original_file!.text()).toBe('%PDF-1.7 original');
  });

  it('leaves Blobs saved before this change as they are', () => {
    const old = new Blob(['original']);
    const record = { id: 'old', original_file: old, output_pdf: null };
    expect(reviveBlobs(record).original_file).toBe(old);
    expect(reviveBlobs(record).output_pdf).toBeNull();
  });

  it('stores signatures as bytes too', async () => {
    await db.signatures.add({ id: 's1', label: 'Me', png: await storable(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })), width: 10, height: 5, ink: 'blue', source: 'drawn', created_at: 1 });
    const s = (await db.signatures.get('s1'))!;
    expect(s.png).toBeInstanceOf(Blob);
    expect(s.png.type).toBe('image/png');
    expect([...new Uint8Array(await s.png.arrayBuffer())]).toEqual([137, 80, 78, 71]);
  });
});
