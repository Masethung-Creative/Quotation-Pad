import type { CanonicalDoc } from '@/schema/canonical';
import { buildDocDefinition, DENSITIES, PAGE_PT, type BuiltDocument, type SignatureSlot, type TemplateInput } from './docdef';
import { fitImage, signatureBox, type SignatureOffset } from './signature';
import { countPages, stampImage, stampOnBackground } from './stamp';

/**
 * Step 5 of the pipeline: canonical JSON -> pages on a company template (pdfmake), plus
 * the original-letterpad fallback and the signature (pdf-lib). Environment-neutral: runs
 * in the render worker, on the main thread as a fallback, and in Node for tests.
 */

export interface RenderRequest {
  doc: CanonicalDoc;
  template: TemplateInput;
  title?: string;
  /** Pages of the original quotation: the layout is tightened (within limits) to fit them. */
  fitPages?: number;
}

export interface RenderResult {
  pdf: Uint8Array;
  pages: number;
  /** Layout density used (index into DENSITIES; 0 = normal). */
  density?: number;
  /** Where the template's signature box landed (null when the document has no signature block). */
  slot: SignatureSlot | null;
}

export interface SignRequest {
  pdf: Uint8Array;
  slot: SignatureSlot;
  offset: SignatureOffset;
  png: Uint8Array;
  imageWidth: number;
  imageHeight: number;
  title?: string;
}

export type FontLoader = (file: string) => Promise<Uint8Array>;

const fontCache = new Map<string, Promise<Uint8Array>>();

export const fetchFont: FontLoader = (file) => {
  let hit = fontCache.get(file);
  if (!hit) {
    hit = fetch(`/fonts/${file}`).then(async (res) => {
      if (!res.ok) throw new Error(`Font ${file} could not be loaded (${res.status}).`);
      return new Uint8Array(await res.arrayBuffer());
    });
    hit.catch(() => fontCache.delete(file));
    fontCache.set(file, hit);
  }
  return hit;
};

interface VirtualFs {
  writeFileSync: (name: string, content: Uint8Array) => void;
  existsSync: (name: string) => boolean;
}

interface PdfMakeLike {
  createPdf: (definition: unknown) => { getBuffer: () => Promise<Uint8Array> };
  setFonts: (fonts: unknown) => void;
  virtualfs?: VirtualFs;
  sharedVirtualfs?: VirtualFs;
  setUrlAccessPolicy?: (cb: (url: string) => boolean) => void;
}

let pdfMakePromise: Promise<PdfMakeLike> | null = null;

function loadPdfMake(): Promise<PdfMakeLike> {
  pdfMakePromise ??= import('pdfmake/build/pdfmake.js').then((mod) => {
    const lib = ((mod as { default?: unknown }).default ?? mod) as PdfMakeLike;
    // Content never references remote files; refuse any URL outright.
    lib.setUrlAccessPolicy?.(() => false);
    return lib;
  });
  return pdfMakePromise;
}

export async function renderPdf(req: RenderRequest, loadFont: FontLoader = fetchFont): Promise<RenderResult> {
  const once = async (density: number) => {
    const built = buildDocDefinition(req.doc, req.template, { title: req.title, density });
    const { pdf, pages } = await produce(built, req.template, loadFont, req.title);
    return { pdf, pages, slot: built.slot.value, density };
  };
  let best = await once(0);
  // A one-page quotation should stay one page: set it tighter until it fits the original.
  // Original page count unknown: only less spacing (same text size), and only when that
  // saves a page, e.g. the signature alone on an almost empty last page.
  const target = req.fitPages && req.fitPages > 0 ? req.fitPages : Math.max(1, best.pages - 1);
  const lastLevel = req.fitPages && req.fitPages > 0 ? DENSITIES.length - 1 : 1;
  for (let level = 1; best.pages > target && level <= lastLevel; level++) {
    const next = await once(level);
    if (next.pages < best.pages) best = next;
    if (next.pages <= target) break;
  }
  return best;
}

/**
 * The bare template: `pages` empty pages with the header and footer only. Used for the
 * side-by-side check against the original letterpad.
 */
export async function renderBlankTemplate(template: TemplateInput, pages = 2, loadFont: FontLoader = fetchFont): Promise<Uint8Array> {
  const built = buildDocDefinition({ blocks: [], confidence: {} }, template);
  built.definition.content = Array.from({ length: pages }, (_, i) => ({ text: ' ', ...(i > 0 ? { pageBreak: 'before' as const } : {}) }));
  return (await produce(built, template, loadFont)).pdf;
}

async function produce(built: BuiltDocument, template: TemplateInput, loadFont: FontLoader, title?: string): Promise<{ pdf: Uint8Array; pages: number }> {
  const { def, files } = template;
  const pdfMake = await loadPdfMake();
  const vfs = pdfMake.sharedVirtualfs ?? pdfMake.virtualfs;
  if (!vfs) throw new Error('pdfmake virtual file system is not available');
  await Promise.all(
    built.fontPlan.sources.map(async (source) => {
      if (vfs.existsSync(source.vfsName)) return;
      const bytes = source.from === 'public' ? await loadFont(source.file) : files[source.file];
      if (!bytes) throw new Error(`Template ${def.id}: font ${source.file} is missing.`);
      vfs.writeFileSync(source.vfsName, bytes);
    }),
  );
  pdfMake.setFonts(built.fontPlan.families);
  let pdf: Uint8Array = new Uint8Array(await pdfMake.createPdf(built.definition).getBuffer());
  let pages: number;

  if (def.background) {
    const bg = def.background;
    const bytes = (file: string) => {
      const b = files[file];
      if (!b) throw new Error(`Template ${def.id}: background ${file} is missing.`);
      return b;
    };
    const stamped = await stampOnBackground({
      content: pdf,
      first: { bytes: bytes(bg.first.file), page: bg.first.page },
      continuation: bg.continuation ? { bytes: bytes(bg.continuation.file), page: bg.continuation.page } : null,
      pageSize: PAGE_PT.A4,
      masks: template.masks,
      title,
    });
    pdf = stamped.pdf;
    pages = stamped.pages;
  } else {
    pages = await countPages(pdf);
  }
  return { pdf, pages };
}

/** Adds the signature image (transparent PNG) at the user's position. */
export async function signPdf(req: SignRequest): Promise<Uint8Array> {
  const box = signatureBox(req.slot, req.offset);
  return stampImage(req.pdf, req.png, fitImage(box, req.imageWidth, req.imageHeight), req.title);
}
