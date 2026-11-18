import type { PageMasks } from './marker';
import { referencedFiles, templateSchema, type TemplateDef } from './schema';

export { referencedFiles };

/**
 * Company templates are built into the app: one folder per company in src/templates/.
 * Adding a company = add a folder with template.json (+ letterpad.pdf or logo.svg) and redeploy.
 */

const definitions = import.meta.glob<unknown>('./*/template.json', { eager: true, import: 'default' });
const assetUrls = import.meta.glob<string>('./*/*.{svg,png,jpg,jpeg,pdf,ttf,otf}', { eager: true, query: '?url', import: 'default' });

function folderOf(path: string): string {
  return path.split('/')[1];
}

function load(): TemplateDef[] {
  const out: TemplateDef[] = [];
  for (const [path, raw] of Object.entries(definitions)) {
    const def = templateSchema.parse(raw);
    if (def.id !== folderOf(path)) throw new Error(`Template ${path}: "id" must match its folder name (${folderOf(path)}).`);
    out.push(def);
  }
  return out.sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export const TEMPLATES: TemplateDef[] = load();

export function getTemplate(id: string | null | undefined): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function templateAssetUrl(id: string, file: string | undefined): string | undefined {
  return file ? assetUrls[`./${id}/${file}`] : undefined;
}

/** A template plus the bytes of the files it references, ready to send to the render worker. */
export interface TemplateBundle {
  def: TemplateDef;
  files: Record<string, Uint8Array>;
  /** Where the Word placeholder (e.g. "{@body}") sits on the background PDF, to be covered. */
  masks?: PageMasks;
}

async function findMasks(def: TemplateDef, files: Record<string, Uint8Array>): Promise<PageMasks | undefined> {
  if (!def.body_marker || !def.background) return undefined;
  const { openPdf } = await import('@/extract/pdfjs');
  const { markerBoxesOnPage } = await import('./marker');
  const boxesFor = async (ref: { file: string; page: number }) => {
    const { doc, close } = await openPdf(files[ref.file]);
    try {
      return await markerBoxesOnPage(doc, ref.page, def.body_marker!);
    } finally {
      await close().catch(() => undefined);
    }
  };
  const first = await boxesFor(def.background.first);
  const continuation = def.background.continuation ? await boxesFor(def.background.continuation) : first;
  return { first, continuation };
}

const bundles = new Map<string, Promise<TemplateBundle>>();

export function loadTemplateBundle(id: string): Promise<TemplateBundle> {
  let hit = bundles.get(id);
  if (!hit) {
    const def = getTemplate(id);
    if (!def) return Promise.reject(new Error(`Unknown template "${id}".`));
    hit = (async () => {
      const files: Record<string, Uint8Array> = {};
      await Promise.all(
        referencedFiles(def).map(async (file) => {
          const url = templateAssetUrl(id, file);
          if (!url) throw new Error(`Template ${id}: file "${file}" is missing from its folder.`);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Template ${id}: could not load ${file}.`);
          files[file] = new Uint8Array(await res.arrayBuffer());
        }),
      );
      return { def, files, masks: await findMasks(def, files) };
    })();
    hit.catch(() => bundles.delete(id));
    bundles.set(id, hit);
  }
  return hit;
}
