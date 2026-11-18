// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { PDFDocument, PDFName, PDFRawStream, type PDFDict } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { renderPdf, signPdf } from '@/render/core';
import { buildDocDefinition, mm, PAGE_PT, resolveForTemplate, type TemplateInput } from '@/render/docdef';
import { BODY } from '@/render/body';
import { DEFAULT_OFFSET, fitImage, offsetFromBox, signatureBox } from '@/render/signature';
import { docText, parseCanonical, type CanonicalDoc } from '@/schema/canonical';
import { asciiTokens, compareCoverage } from '@/validate/coverage';
import { loadFontFromDisk, pdfPageTexts, sample, templateFile, templateFromDisk, toArrayBuffer } from './helpers';

// The Word extractor turns HTML into blocks with DOMParser; pdf.js needs the node environment.
globalThis.DOMParser ??= new JSDOM().window.DOMParser;

const spec = parseCanonical(JSON.parse(new TextDecoder().decode(sample('spec-example.json'))));
const kaveri = await templateFromDisk('kaveri-trading');
const greenleaf = await templateFromDisk('greenleaf-agro');

function longDoc(rows: number): CanonicalDoc {
  return {
    blocks: [
      { type: 'heading', text: 'QUOTATION', level: 1, align: 'center' },
      {
        type: 'table',
        columns: ['S.No', 'Description', 'Qty', 'Rate (Rs)', 'Amount (Rs)'],
        col_align: ['center', 'left', 'right', 'right', 'right'],
        rows: Array.from({ length: rows }, (_, i) => [String(i + 1), `Item ${i + 1} with a description that is long enough to wrap onto two lines on paper`, '2', '1,500.00', '3,000.00']),
      },
      { type: 'totals', items: [{ label: 'Grand Total', value: '1,00,000.00', bold: true }], amount_in_words: 'Rupees One Lakh Only' },
      { type: 'signature', lines: [], auto: true },
    ],
    confidence: {},
  };
}

async function imageDicts(bytes: Uint8Array): Promise<PDFDict[]> {
  const doc = await PDFDocument.load(bytes);
  const found: PDFDict[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) found.push(obj.dict);
  }
  return found;
}

describe('document definition on a template', () => {
  it('uses the continuation safe area as page margins and pushes page 1 below its taller header', () => {
    const { def } = kaveri;
    const { definition } = buildDocDefinition(spec, kaveri);
    const first = def.first_page.safe_area_mm;
    const next = def.continuation!.safe_area_mm;
    expect(definition.pageMargins).toEqual([mm(Math.max(first.left, next.left)), mm(next.top + BODY.topGapMm), mm(Math.max(first.right, next.right)), mm(Math.max(first.bottom, next.bottom))]);
    const content = definition.content as { margin?: number[] }[];
    expect(content[0].margin?.[1]).toBeCloseTo(mm(first.top - next.top), 5);
  });

  it('repeats table headers, never splits rows and keeps totals + signature together', () => {
    const { definition } = buildDocDefinition(spec, kaveri);
    const json = JSON.stringify(definition.content);
    expect(json).toContain('"headerRows":1');
    expect(json).toContain('"dontBreakRows":true');
    const content = definition.content as { unbreakable?: boolean; stack?: unknown[] }[];
    const group = content.find((c) => c.unbreakable && JSON.stringify(c.stack ?? []).includes('Grand Total') && JSON.stringify(c.stack).includes('qp-signature-slot'));
    expect(group).toBeDefined();
  });

  it('only embeds the fonts that are used', () => {
    const files = buildDocDefinition(spec, kaveri).fontPlan.sources.map((s) => s.file).sort();
    // Quotation text in Noto Sans; the Kaveri header is set in Liberation Sans (Arial widths).
    expect(files).toEqual(['LiberationSans-Bold.ttf', 'LiberationSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSans-Regular.ttf']);
    const mixed: CanonicalDoc = { blocks: [{ type: 'paragraph', runs: [{ text: 'நன்றி and धन्यवाद', italic: true }], align: 'left' }], confidence: {} };
    const files2 = buildDocDefinition(mixed, kaveri).fontPlan.sources.map((s) => s.file);
    expect(files2).toEqual(expect.arrayContaining(['NotoSansTamil-Regular.ttf', 'NotoSansDevanagari-Regular.ttf', 'NotoSans-Italic.ttf']));
  });

  it('splits mixed-script text into runs with the right font', () => {
    const doc: CanonicalDoc = { blocks: [{ type: 'paragraph', runs: [{ text: 'Total தொகை ₹ 500 कुल' }], align: 'left' }], confidence: {} };
    const content = buildDocDefinition(doc, kaveri).definition.content as { text?: { text: string; font?: string }[] }[];
    const para = content.find((c) => Array.isArray(c.text))!;
    expect(para.text!.map((t) => [t.text, t.font ?? 'body'])).toEqual([
      ['Total ', 'body'],
      ['தொகை', 'NotoSansTamil'],
      [' ₹ 500 ', 'body'],
      ['कुल', 'NotoSansDevanagari'],
    ]);
  });

  it("prints the template's signature block in place of the source's", () => {
    const doc = resolveForTemplate({ blocks: [{ type: 'signature', lines: ['For Other Co', '', 'Manager'], auto: true }], confidence: {} }, kaveri.def);
    expect(doc.blocks[0]).toMatchObject({ type: 'signature', lines: ['For Kaveri Trading Company', '', 'R. Senthil Kumar', 'Proprietor'], auto: false });
    const custom = resolveForTemplate({ blocks: [{ type: 'signature', lines: ['Mine'], auto: false }], confidence: {} }, kaveri.def);
    expect(custom.blocks[0]).toMatchObject({ lines: ['Mine'] });
  });
});

describe('PDF rendering on a template (pdfmake + pdf-lib)', () => {
  it('renders the spec example on the template with every word present', async () => {
    const result = await renderPdf({ doc: spec, template: kaveri }, loadFontFromDisk);
    expect(result.pages).toBe(1);
    const pdf = await PDFDocument.load(result.pdf);
    const [w, h] = PAGE_PT.A4;
    expect(pdf.getPage(0).getSize().width).toBeCloseTo(w, 3);
    expect(pdf.getPage(0).getSize().height).toBeCloseTo(h, 3);
    const [text] = await pdfPageTexts(result.pdf);
    const coverage = compareCoverage(asciiTokens(docText(resolveForTemplate(spec, kaveri.def))), asciiTokens(text));
    expect(coverage.missing).toEqual([]);
    expect(text).toContain('KAVERI TRADING COMPANY'); // header drawn as real (vector) text
    expect(text).toContain('3,540.00');
  });

  it('uses the slimmer continuation header from page 2 and repeats the table header', async () => {
    const result = await renderPdf({ doc: longDoc(60), template: kaveri }, loadFontFromDisk);
    expect(result.pages).toBeGreaterThanOrEqual(3);
    const pages = await pdfPageTexts(result.pdf);
    pages.forEach((text, i) => {
      expect(text).toContain('KAVERI TRADING COMPANY');
      if (i === 0) expect(text).toContain('Electrical & Industrial Supplies');
      else expect(text).not.toContain('Electrical & Industrial Supplies');
      expect(text).toContain('Description');
    });
  });

  it('repeats the single design on every page when a template has no continuation design', async () => {
    const result = await renderPdf({ doc: longDoc(40), template: greenleaf }, loadFontFromDisk);
    const pages = await pdfPageTexts(result.pdf);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const text of pages) expect(text).toContain('Seeds - Fertilisers - Farm Equipment');
  });

  it('can use the original letterpad PDF as the background (fallback when code cannot match it)', async () => {
    const fallback: TemplateInput = {
      def: {
        ...kaveri.def,
        first_page: { ...kaveri.def.first_page, header: [], footer: [] },
        continuation: kaveri.def.continuation ? { ...kaveri.def.continuation, header: [], footer: [] } : null,
        background: { first: { file: 'original_letterpad.pdf', page: 1 }, continuation: { file: 'original_letterpad.pdf', page: 2 } },
      },
      files: { ...kaveri.files, 'original_letterpad.pdf': templateFile('kaveri-trading', 'original_letterpad.pdf') },
    };
    const result = await renderPdf({ doc: longDoc(60), template: fallback }, loadFontFromDisk);
    const pages = await pdfPageTexts(result.pdf);
    expect(pages[0]).toContain('Electrical & Industrial Supplies');
    expect(pages[1]).not.toContain('Electrical & Industrial Supplies');
    expect(pages[1]).toContain('KAVERI TRADING COMPANY');
    expect(pages.join(' ')).toContain('Item 60 with a description');
    // The letterpad stays vector: no images were added.
    expect(await imageDicts(result.pdf)).toHaveLength(0);
  });

  it('a 15-row Word quotation becomes a correct 1-2 page PDF on each template, quickly', async () => {
    const { docxToHtml, finishDocx } = await import('@/extract/docx');
    const { withTemplateSignature } = await import('@/pipeline/convert');
    for (const tpl of [kaveri, greenleaf]) {
      const t0 = performance.now();
      const extracted = finishDocx(await docxToHtml(toArrayBuffer(sample('quotation.docx'))));
      const doc = withTemplateSignature(extracted.doc);
      const result = await renderPdf({ doc, template: tpl }, loadFontFromDisk);
      const ms = performance.now() - t0;
      expect(result.pages).toBeGreaterThanOrEqual(1);
      expect(result.pages).toBeLessThanOrEqual(2);
      const text = (await pdfPageTexts(result.pdf)).join('\n');
      expect(compareCoverage(asciiTokens(docText(resolveForTemplate(doc, tpl.def))), asciiTokens(text)).missing).toEqual([]);
      // Desktop CPU budget; the 10 s phone budget is checked by the throttled end-to-end test.
      expect(ms).toBeLessThan(4000);
    }
  });
});

describe('signature placement', () => {
  const slot = { page: 1, x: 400, y: 600, w: mm(40), h: mm(15), bounds: { x: 51, y: 113, w: 500, h: 650 } };

  it('starts in the template box and moves / scales in millimetres', () => {
    expect(signatureBox(slot, DEFAULT_OFFSET)).toEqual({ page: 1, x: 400, y: 600, w: slot.w, h: slot.h });
    const moved = signatureBox(slot, { dx: -10, dy: 5, scale: 1 });
    expect(moved.x).toBeCloseTo(400 - mm(10), 6);
    expect(moved.y).toBeCloseTo(600 + mm(5), 6);
    const bigger = signatureBox(slot, { dx: 0, dy: 0, scale: 1.5 });
    expect(bigger.w).toBeCloseTo(slot.w * 1.5, 6);
    // The bottom edge stays on the name line.
    expect(bigger.y + bigger.h).toBeCloseTo(slot.y + slot.h, 6);
  });

  it('can never be dragged outside the safe area (so never over the header or footer)', () => {
    const far = signatureBox(slot, { dx: 500, dy: 500, scale: 1 });
    expect(far.x + far.w).toBeLessThanOrEqual(slot.bounds.x + slot.bounds.w + 1e-9);
    expect(far.y + far.h).toBeLessThanOrEqual(slot.bounds.y + slot.bounds.h + 1e-9);
    const up = signatureBox(slot, { dx: -900, dy: -900, scale: 5 });
    expect(up.x).toBeGreaterThanOrEqual(slot.bounds.x);
    expect(up.y).toBeGreaterThanOrEqual(slot.bounds.y);
    expect(up.w).toBeCloseTo(slot.w * 2.5, 6); // the scale is capped
  });

  it('turns a dragged box back into the same offset', () => {
    const offset = { dx: -12.5, dy: 3.2, scale: 1.2 };
    expect(offsetFromBox(slot, signatureBox(slot, offset))).toEqual(offset);
  });

  it('fits the image inside the box without stretching', () => {
    const box = signatureBox(slot, DEFAULT_OFFSET);
    const wide = fitImage(box, 400, 100);
    expect(wide.w).toBeCloseTo(box.w, 6);
    expect(wide.h).toBeCloseTo(box.w / 4, 6);
    expect(wide.y + wide.h).toBeCloseTo(box.y + box.h, 6);
    expect(fitImage(box, 100, 100).h).toBeCloseTo(box.h, 6);
  });

  it('stamps the signature as a transparent image (no white box)', async () => {
    const result = await renderPdf({ doc: longDoc(5), template: kaveri }, loadFontFromDisk);
    expect(result.slot).not.toBeNull();
    // 4 x 2 RGBA PNG: transparent paper with blue ink.
    const canvas = createCanvas(4, 2);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(22,45,128)';
    ctx.fillRect(1, 0, 2, 1);
    const png = new Uint8Array(canvas.toBuffer('image/png'));
    const signed = await signPdf({ pdf: result.pdf, slot: result.slot!, offset: DEFAULT_OFFSET, png, imageWidth: 4, imageHeight: 2 });
    expect(await imageDicts(result.pdf)).toHaveLength(0);
    // One picture plus its soft mask (the alpha channel): the paper around the ink stays see-through.
    const added = await imageDicts(signed);
    expect(added).toHaveLength(2);
    expect(added.filter((d) => d.get(PDFName.of('SMask')))).toHaveLength(1);
  });
});
