// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { pdfToPngs } from '../../scripts/pdf-to-png.mjs';
import { renderBlankTemplate, renderPdf } from '@/render/core';
import { mm, PAGE_PT, type TemplateInput } from '@/render/docdef';
import { BUILTIN_ASCENDER, readAscender } from '@/render/fonts';
import type { CanonicalDoc } from '@/schema/canonical';
import type { MaskBox } from '@/templates/marker';
import { designFor, fillPlaceholders, referencedFiles, type TemplateDef } from '@/templates/schema';
import { compareInk, inkMask, sideBySide, type RgbaImage } from '../templates/compare';
import { allTemplates, loadFontFromDisk, ROOT, templateFromDisk } from './helpers';

/**
 * Acceptance checks for every company template (the real ones in src/templates and the
 * fictional test companies in tests/fixtures/templates):
 *  - matches the original letterpad within 1 mm (side-by-side PNG check), page 1 and page 2
 *  - no header / footer ink inside the safe area, and no quotation text outside it
 */

const DPI = 150;
const PX_PER_MM = DPI / 25.4;
const A4_PX = { w: Math.round(210 * PX_PER_MM), h: Math.round(297 * PX_PER_MM) };
const OUT_DIR = join(ROOT, 'reports', 'templates');

const templates = allTemplates();

async function rasterPdf(bytes: Uint8Array, page: number): Promise<RgbaImage> {
  const [rendered] = await pdfToPngs(bytes, DPI, { pages: [page] });
  if (!rendered) throw new Error(`page ${page} missing`);
  // Normalise to exactly A4 at DPI so both images line up pixel for pixel.
  const canvas = createCanvas(A4_PX.w, A4_PX.h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(rendered.canvas, 0, 0, A4_PX.w, A4_PX.h);
  return ctx.getImageData(0, 0, A4_PX.w, A4_PX.h);
}

async function rasterOriginal(folder: string, ref: { file: string; page: number }, masks: MaskBox[]): Promise<RgbaImage> {
  const path = join(folder, ref.file);
  let img: RgbaImage;
  if (/\.pdf$/i.test(ref.file)) {
    img = await rasterPdf(new Uint8Array(readFileSync(path)), ref.page);
  } else {
    const picture = await loadImage(readFileSync(path));
    const canvas = createCanvas(A4_PX.w, A4_PX.h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, A4_PX.w, A4_PX.h);
    ctx.drawImage(picture, 0, 0, A4_PX.w, A4_PX.h);
    img = ctx.getImageData(0, 0, A4_PX.w, A4_PX.h);
  }
  // The Word placeholder ("{@body}") is not part of the letterhead: blank it out here too.
  for (const m of masks) {
    const x0 = Math.floor(m.x * img.width);
    const y0 = Math.floor(m.y * img.height);
    const x1 = Math.ceil((m.x + m.w) * img.width);
    const y1 = Math.ceil((m.y + m.h) * img.height);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set([255, 255, 255, 255], (y * img.width + x) * 4);
  }
  return img;
}

function savePng(img: RgbaImage, name: string): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  const data = ctx.createImageData(img.width, img.height);
  data.data.set(img.data);
  ctx.putImageData(data, 0, 0);
  writeFileSync(join(OUT_DIR, name), canvas.toBuffer('image/png'));
}

/** A quotation long enough for three pages. */
function longDoc(): CanonicalDoc {
  return {
    blocks: [
      { type: 'heading', text: 'QUOTATION', level: 1, align: 'center' },
      { type: 'meta', items: [{ label: 'Ref No', value: 'Q/2026-27/099' }, { label: 'Date', value: '18-11-2026' }] },
      { type: 'paragraph', runs: [{ text: 'To,\nThe Manager,\nSample Customer Pvt Ltd,\nChennai - 600001' }], align: 'left' },
      {
        type: 'table',
        columns: ['S.No', 'Description', 'Qty', 'Rate (Rs)', 'Amount (Rs)'],
        col_align: ['center', 'left', 'right', 'right', 'right'],
        rows: Array.from({ length: 70 }, (_, i) => [String(i + 1), `Item number ${i + 1} with a fairly long description that wraps`, '2', '1,500.00', '3,000.00']),
      },
      { type: 'totals', items: [{ label: 'Grand Total', value: '2,10,000.00', bold: true }], amount_in_words: 'Rupees Two Lakh Ten Thousand Only' },
      { type: 'list', ordered: true, items: ['Validity: 30 days', 'Payment: 50% advance'] },
      { type: 'signature', lines: ['For Someone Else', '', 'Authorised Signatory'], auto: true },
    ],
    confidence: {},
  };
}

describe('built-in font metrics', () => {
  it('match the font files (used to place template text on its baseline)', () => {
    for (const [file, value] of Object.entries(BUILTIN_ASCENDER)) {
      expect(readAscender(new Uint8Array(readFileSync(join(ROOT, 'public', 'fonts', file)))), file).toBeCloseTo(value, 3);
    }
  });
});

describe('template folders', () => {
  it('include the two real companies', () => {
    const ids = templates.map(([id]) => id);
    expect(ids).toEqual(expect.arrayContaining(['mass-service-tech', 'rm-smart-service-tech']));
  });
});

describe.each(templates)('template %s', (id, folder) => {
  it('is valid, matches its folder and has every file it references', async () => {
    const { def } = await templateFromDisk(id);
    expect(def.id).toBe(id);
    for (const file of referencedFiles(def)) expect(existsSync(join(folder, file)), file).toBe(true);
    if (def.original) expect(existsSync(join(folder, def.original.first.file))).toBe(true);
    if (def.thumbnail) expect(existsSync(join(folder, def.thumbnail))).toBe(true);
  });

  it('matches the original letterpad within 1 mm on page 1 and page 2', async () => {
    const tpl = await templateFromDisk(id);
    const { def } = tpl;
    if (!def.original) return;
    const blank = await renderBlankTemplate(tpl, 2, loadFontFromDisk);
    const original = def.original;
    // Page 2 is compared with the original continuation sheet; without one, with page 1.
    const refs = [original.first, original.continuation ?? (def.continuation ? null : original.first)];
    for (const [i, ref] of refs.entries()) {
      if (!ref) continue;
      const page = i + 1;
      const masks = (page === 1 ? tpl.masks?.first : tpl.masks?.continuation) ?? [];
      const a = await rasterOriginal(folder, ref, masks);
      const b = await rasterPdf(blank, page);
      const report = compareInk(a, b, PX_PER_MM);
      savePng(sideBySide(a, b), `${id}-page${page}.png`);
      console.log(`[template ${id}] page ${page}: 99.9% of ink within ${report.p999.toFixed(2)} mm (mean ${report.mean.toFixed(3)} mm, max ${report.max.toFixed(2)} mm)`);
      expect(report.inkA).toBeGreaterThan(1000);
      expect(report.inkB).toBeGreaterThan(1000);
      expect(report.p999, `page ${page} differs from the original by more than 1 mm - see reports/templates/${id}-page${page}.png`).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the safe area free of header and footer ink (page 1 and page 2)', async () => {
    const tpl = await templateFromDisk(id);
    const blank = await renderBlankTemplate(tpl, 2, loadFontFromDisk);
    for (const page of [1, 2]) {
      const img = await rasterPdf(blank, page);
      const mask = inkMask(img);
      const safe = designFor(tpl.def, page).safe_area_mm;
      const inset = 0.5;
      const x0 = Math.ceil((safe.left + inset) * PX_PER_MM);
      const x1 = Math.floor((210 - safe.right - inset) * PX_PER_MM);
      const y0 = Math.ceil((safe.top + inset) * PX_PER_MM);
      const y1 = Math.floor((297 - safe.bottom - inset) * PX_PER_MM);
      let ink = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) ink += mask[y * img.width + x];
      expect(ink, `header/footer ink inside the safe area on page ${page}`).toBe(0);
    }
  });

  it('keeps every line of the quotation inside the safe area on every page', async () => {
    const tpl = await templateFromDisk(id);
    const { def } = tpl;
    // Same template without its letterhead, so every text item on the page is quotation text.
    const stripped: TemplateDef = {
      ...def,
      first_page: { ...def.first_page, header: [], footer: [] },
      continuation: def.continuation ? { ...def.continuation, header: [], footer: [] } : null,
      background: null,
    };
    const input: TemplateInput = { def: stripped, files: tpl.files };
    const result = await renderPdf({ doc: longDoc(), template: input }, loadFontFromDisk);
    expect(result.pages).toBeGreaterThanOrEqual(3);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: result.pdf.slice() });
    const pdf = await task.promise;
    const [pageW, pageH] = PAGE_PT.A4;
    const tolerance = 1;
    for (let n = 1; n <= pdf.numPages; n++) {
      const safe = designFor(def, n).safe_area_mm;
      const content = await (await pdf.getPage(n)).getTextContent();
      let items = 0;
      for (const raw of content.items) {
        if (!('str' in raw) || !raw.str.trim()) continue;
        items++;
        const [, , , d, x, baseline] = raw.transform;
        const yTop = pageH - baseline - Math.abs(d) * 0.8;
        const yBottom = pageH - baseline + Math.abs(d) * 0.25;
        const where = `page ${n}: "${raw.str}"`;
        expect(x, where).toBeGreaterThanOrEqual(mm(safe.left) - tolerance);
        expect(x + raw.width, where).toBeLessThanOrEqual(pageW - mm(safe.right) + tolerance);
        expect(yTop, where).toBeGreaterThanOrEqual(mm(n === 1 ? safe.top : designFor(def, 2).safe_area_mm.top) - tolerance);
        expect(yBottom, where).toBeLessThanOrEqual(pageH - mm(safe.bottom) + tolerance);
      }
      expect(items).toBeGreaterThan(0);
    }
    await task.destroy();
  });

  it("prints the template's own signature block and reports where the signature goes", async () => {
    const tpl = await templateFromDisk(id);
    const { def } = tpl;
    const result = await renderPdf({ doc: longDoc(), template: tpl }, loadFontFromDisk);
    expect(result.slot).not.toBeNull();
    const slot = result.slot!;
    expect(slot.page).toBe(result.pages);
    expect(slot.w).toBeCloseTo(mm(def.signature.box_mm.w), 3);
    expect(slot.h).toBeCloseTo(mm(def.signature.box_mm.h), 3);
    expect(slot.x).toBeGreaterThanOrEqual(slot.bounds.x - 0.01);
    expect(slot.x + slot.w).toBeLessThanOrEqual(slot.bounds.x + slot.bounds.w + 0.01);
    expect(slot.y).toBeGreaterThanOrEqual(slot.bounds.y);
    expect(slot.y + slot.h).toBeLessThanOrEqual(slot.bounds.y + slot.bounds.h);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: result.pdf.slice() });
    const pdf = await task.promise;
    const last = await (await pdf.getPage(pdf.numPages)).getTextContent();
    const text = last.items.map((i) => ('str' in i ? i.str : '')).join(' ');
    await task.destroy();
    expect(text).toContain(fillPlaceholders(def.signature.for_line, def));
    expect(text).toContain(def.signature.designation);
    expect(text).not.toContain('For Someone Else');
  });
});

describe('real company letterpads', () => {
  it("cover the Word placeholder printed in Mass Service Tech's PDF", async () => {
    const mass = await templateFromDisk('mass-service-tech');
    expect(mass.def.body_marker).toBe('{@body}');
    expect(mass.masks?.first).toHaveLength(1);
    const [box] = mass.masks!.first;
    // About 25 mm from the left, 51-56 mm from the top: inside the body area.
    expect(box.x * 210).toBeGreaterThan(23);
    expect(box.x * 210).toBeLessThan(27);
    expect(box.y * 297).toBeGreaterThan(49);
    expect((box.y + box.h) * 297).toBeLessThan(58);
    const rm = await templateFromDisk('rm-smart-service-tech');
    expect(rm.masks?.first ?? []).toHaveLength(0);
  });

  it('read the owner\'s template.json format', async () => {
    const { def } = await templateFromDisk('mass-service-tech');
    expect(def).toMatchObject({
      id: 'mass-service-tech',
      display_name: 'Mass Service Tech',
      company: { name: 'MASS SERVICE TECH', phone: '9677641647, 9003820867', email: 'massservicetech@gmail.com' },
      first_page: { safe_area_mm: { top: 49, bottom: 17, left: 20, right: 20 }, header: [], footer: [] },
      background: { first: { file: 'letterpad.pdf', page: 1 } },
      signature: { for_line: 'For MASS SERVICE TECH', designation: 'Authorised Signatory' },
      thumbnail: 'thumbnail.png',
      docx: 'letterpad.docx',
    });
  });
});
