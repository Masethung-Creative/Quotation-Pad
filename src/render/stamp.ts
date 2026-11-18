import { PDFDocument, rgb, type PDFEmbeddedPage } from 'pdf-lib';
import type { MaskBox, PageMasks } from '@/templates/marker';

/**
 * pdf-lib post-processing of the pdfmake output:
 *  - original-letterpad fallback: draw a page of the original letterpad PDF behind each
 *    content page (page 1 -> first background, page 2+ -> continuation). It stays vector.
 *  - signature: draw the signature PNG (transparent background) on top.
 */

export interface PdfBackground {
  bytes: Uint8Array;
  /** 1-based page of that PDF to use. */
  page: number;
}

export interface StampInput {
  content: Uint8Array;
  first: PdfBackground;
  continuation: PdfBackground | null;
  pageSize: [number, number];
  /** Placeholder text on the letterpad (e.g. "{@body}") to cover with paper white. */
  masks?: PageMasks;
  title?: string;
}

async function embed(out: PDFDocument, bg: PdfBackground): Promise<PDFEmbeddedPage> {
  const src = await PDFDocument.load(bg.bytes, { ignoreEncryption: true, updateMetadata: false });
  const index = Math.min(Math.max(bg.page, 1), src.getPageCount()) - 1;
  const [page] = await out.embedPdf(src, [index]);
  return page;
}

function setInfo(doc: PDFDocument, title?: string): void {
  doc.setTitle(title ?? 'Quotation');
  doc.setCreator('Quotation Pad');
  doc.setProducer('Quotation Pad (pdfmake + pdf-lib)');
}

export async function stampOnBackground(input: StampInput): Promise<{ pdf: Uint8Array; pages: number }> {
  const [width, height] = input.pageSize;
  const out = await PDFDocument.create();
  const content = await PDFDocument.load(input.content, { updateMetadata: false });
  const count = content.getPageCount();
  const firstBg = await embed(out, input.first);
  const nextBg = input.continuation && count > 1 ? await embed(out, input.continuation) : firstBg;
  const pages = await out.embedPdf(
    content,
    Array.from({ length: count }, (_, i) => i),
  );
  for (let i = 0; i < count; i++) {
    const page = out.addPage([width, height]);
    // The letterpad fills the whole sheet, exactly like pre-printed paper.
    page.drawPage(i === 0 ? firstBg : nextBg, { x: 0, y: 0, width, height });
    const masks: MaskBox[] = (i === 0 ? input.masks?.first : input.masks?.continuation) ?? [];
    for (const m of masks) page.drawRectangle({ x: m.x * width, y: height - (m.y + m.h) * height, width: m.w * width, height: m.h * height, color: rgb(1, 1, 1) });
    page.drawPage(pages[i], { x: 0, y: 0, width, height });
  }
  setInfo(out, input.title);
  return { pdf: await out.save({ useObjectStreams: true }), pages: count };
}

/** Box in points, origin at the top-left of the page (as pdfmake reports positions). */
export interface Placement {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Draws a transparent PNG (the signature) onto one page. Without a PNG the PDF is returned unchanged. */
export async function stampImage(pdf: Uint8Array, png: Uint8Array, placement: Placement, title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const page = doc.getPage(Math.min(Math.max(placement.page, 1), doc.getPageCount()) - 1);
  const image = await doc.embedPng(png);
  const { height } = page.getSize();
  page.drawImage(image, { x: placement.x, y: height - placement.y - placement.h, width: placement.w, height: placement.h });
  setInfo(doc, title);
  return doc.save({ useObjectStreams: true });
}

export async function countPages(pdf: Uint8Array): Promise<number> {
  return (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
}
