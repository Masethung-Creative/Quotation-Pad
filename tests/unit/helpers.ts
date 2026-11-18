import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageWords } from '@/extract/types';
import type { TemplateInput } from '@/render/docdef';

export const ROOT = process.cwd();

/** pdf.js reads its standard fonts (Helvetica, Times...) from disk in Node. */
const STANDARD_FONTS = join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts').split(String.fromCharCode(92)).join('/') + '/';

export function sample(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, 'samples', name)));
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export const loadFontFromDisk = async (file: string): Promise<Uint8Array> => new Uint8Array(readFileSync(join(ROOT, 'public', 'fonts', file)));

/** Real company templates live in src/templates; fictional test companies in tests/fixtures/templates. */
export const TEMPLATE_DIRS = [join(ROOT, 'src', 'templates'), join(ROOT, 'tests', 'fixtures', 'templates')];

export function templateDir(id: string): string {
  const dir = TEMPLATE_DIRS.map((d) => join(d, id)).find((d) => existsSync(join(d, 'template.json')));
  if (!dir) throw new Error(`No template folder "${id}"`);
  return dir;
}

/** Every template folder on disk: [id, folder]. */
export function allTemplates(): [string, string][] {
  const out: [string, string][] = [];
  for (const base of TEMPLATE_DIRS) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join(base, d.name, 'template.json'))) out.push([d.name, join(base, d.name)]);
    }
  }
  return out;
}

/** A company template read from disk, exactly as the app bundles it (including placeholder masks). */
export async function templateFromDisk(id: string): Promise<TemplateInput> {
  const { templateSchema, referencedFiles } = await import('@/templates/schema');
  const dir = templateDir(id);
  const def = templateSchema.parse(JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8')));
  const files: Record<string, Uint8Array> = {};
  for (const file of referencedFiles(def)) files[file] = new Uint8Array(readFileSync(join(dir, file)));
  let masks: TemplateInput['masks'];
  if (def.body_marker && def.background) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { markerBoxesOnPage } = await import('@/templates/marker');
    const boxes = async (ref: { file: string; page: number }) => {
      const task = getDocument({ data: files[ref.file].slice(), useSystemFonts: false, standardFontDataUrl: STANDARD_FONTS });
      const doc = await task.promise;
      try {
        return await markerBoxesOnPage(doc, ref.page, def.body_marker!);
      } finally {
        await task.destroy();
      }
    };
    const first = await boxes(def.background.first);
    masks = { first, continuation: def.background.continuation ? await boxes(def.background.continuation) : first };
  }
  return { def, files, masks };
}

export function templateFile(id: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(templateDir(id), file)));
}

/** Opens a PDF with pdf.js in Node and returns the positioned words of every page. */
export async function pdfPages(bytes: Uint8Array): Promise<PageWords[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { pageTextWords } = await import('@/extract/pdf');
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false, fontExtraProperties: true, standardFontDataUrl: STANDARD_FONTS });
  const doc = await task.promise;
  const pages: PageWords[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const text = await pageTextWords(await doc.getPage(n));
    pages.push({ width: text.width, height: text.height, words: text.words, ocr: false, rules: text.rules });
  }
  await task.destroy();
  return pages;
}

/** Plain text of a PDF (all pages), via pdf.js. */
export async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const pages = await pdfPageTexts(bytes);
  return { text: pages.join('\n'), pages: pages.length };
}

/** Text of every page of a PDF, one string per page. */
export async function pdfPageTexts(bytes: Uint8Array): Promise<string[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false, fontExtraProperties: true, standardFontDataUrl: STANDARD_FONTS });
  const doc = await task.promise;
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    out.push(content.items.map((i) => ('str' in i ? i.str : '')).join(' '));
  }
  await task.destroy();
  return out;
}

/** Builds a synthetic line of words: [text, x] pairs at a given baseline, 10-unit font. */
export function row(y: number, cells: [string, number][], size = 10): PageWords['words'] {
  return cells.map(([text, x]) => ({ text, x0: x, x1: x + text.length * size * 0.5, y0: y, y1: y + size }));
}
