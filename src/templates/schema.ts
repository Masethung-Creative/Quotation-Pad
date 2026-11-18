import { z } from 'zod';

/**
 * Company template definition: src/templates/<company-id>/template.json.
 *
 * Two formats are accepted:
 *
 * 1. The letterpad-folder format (used by the real companies): the original letterpad PDF
 *    is placed behind every page, untouched, plus company details, safe area and signature
 *    block. Keys: name, files.pdf, safeArea_mm, company.legalName, phones, signature.forLine.
 *
 * 2. The full format, where the header and footer are drawn in code from elements. All
 *    positions are in millimetres from the TOP-LEFT corner of the page; text `y` is the
 *    BASELINE. Text may use {{company.name}}, {{company.address}}, {{company.gstin}},
 *    {{company.phone}}, {{company.email}}, {{company.website}}. Colours are "#rrggbb" or a
 *    name from `colours`.
 *
 * Both end up as the same TemplateDef.
 */

const num = z.number().finite();
const colour = z.string().min(1);

const textElement = z.object({
  type: z.literal('text'),
  x: num,
  y: num,
  text: z.string(),
  size: z.number().positive(),
  font: z.string().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  colour: colour.optional(),
  /** Where `x` is: the left edge, the centre or the right edge of the text. */
  align: z.enum(['left', 'center', 'right']).default('left'),
  /** Extra space between letters, in points. */
  letter_spacing: z.number().optional(),
  /** Overrides the template's `fonts.kerning` for this text. */
  kerning: z.boolean().optional(),
});

const rectElement = z.object({
  type: z.literal('rect'),
  x: num,
  y: num,
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
  fill: colour.optional(),
  stroke: colour.optional(),
  stroke_width: z.number().nonnegative().optional(),
  radius: z.number().nonnegative().optional(),
});

const lineElement = z.object({
  type: z.literal('line'),
  x1: num,
  y1: num,
  x2: num,
  y2: num,
  colour: colour.optional(),
  width: z.number().positive().default(0.3),
  dash: z.tuple([z.number().positive(), z.number().positive()]).optional(),
});

const ellipseElement = z.object({
  type: z.literal('ellipse'),
  cx: num,
  cy: num,
  rx: z.number().positive(),
  ry: z.number().positive(),
  fill: colour.optional(),
  stroke: colour.optional(),
  stroke_width: z.number().nonnegative().optional(),
});

const polygonElement = z.object({
  type: z.literal('polygon'),
  points: z.array(z.tuple([num, num])).min(2),
  closed: z.boolean().default(true),
  fill: colour.optional(),
  stroke: colour.optional(),
  stroke_width: z.number().nonnegative().optional(),
});

const imageElement = z.object({
  type: z.literal('image'),
  /** A file in the template folder: logo.svg (preferred) or a 600 dpi PNG / JPG. */
  src: z.string().min(1),
  x: num,
  y: num,
  w: z.number().positive(),
  h: z.number().positive(),
});

export const elementSchema = z.discriminatedUnion('type', [textElement, rectElement, lineElement, ellipseElement, polygonElement, imageElement]);
export type TemplateElement = z.infer<typeof elementSchema>;

const margins = z.object({ top: num, right: num, bottom: num, left: num });
export type SafeArea = z.infer<typeof margins>;

const pageDesign = z.object({
  header: z.array(elementSchema).default([]),
  footer: z.array(elementSchema).default([]),
  /** Where the quotation text may go on this page. */
  safe_area_mm: margins,
});
export type PageDesign = z.infer<typeof pageDesign>;

const fontFamily = z.object({
  family: z.string().min(1),
  normal: z.string().min(1),
  bold: z.string().optional(),
  italics: z.string().optional(),
  bolditalics: z.string().optional(),
});

const fileRef = z.object({ file: z.string().min(1), page: z.number().int().positive().default(1) });

const fullSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, digits and hyphens'),
  display_name: z.string().min(1),
  /** Short name used at the start of output file names. Defaults to the display name. */
  file_prefix: z.string().optional(),
  page_size: z.literal('A4').default('A4'),
  company: z.object({
    name: z.string().min(1),
    address: z.string().default(''),
    gstin: z.string().default(''),
    phone: z.string().default(''),
    email: z.string().default(''),
    website: z.string().default(''),
  }),
  colours: z.record(z.string(), z.string()).default({}),
  fonts: z
    .object({
      /** Font of the quotation text: NotoSans (default) or LiberationSans (same widths as Arial). */
      body: z.string().default('NotoSans'),
      size_pt: z.number().min(7).max(16).default(10),
      /** Extra fonts shipped in the template folder (e.g. to match the original letterhead). */
      custom: z.array(fontFamily).default([]),
      /**
       * Kerning and ligatures in header/footer text. Word leaves both off by default, so
       * letterheads made in Word match best with false; designer-made ones often use true.
       */
      kerning: z.boolean().default(false),
    })
    .default({ body: 'NotoSans', size_pt: 10, custom: [], kerning: false }),
  first_page: pageDesign,
  /** Optional slimmer header/footer for page 2+. Omit to repeat the first-page design. */
  continuation: pageDesign.nullable().default(null),
  /**
   * The original letterpad PDF placed behind every page (page 1 -> first, page 2+ ->
   * continuation or first). Header/footer layers may then be empty.
   */
  background: z.object({ first: fileRef, continuation: fileRef.optional() }).nullable().default(null),
  signature: z
    .object({
      for_line: z.string().default('For {{company.name}}'),
      name: z.string().default(''),
      designation: z.string().default('Authorised Signatory'),
      align: z.enum(['left', 'center', 'right']).default('right'),
      /** Space kept for the signature image, in mm. */
      box_mm: z.object({ w: z.number().positive(), h: z.number().positive() }).default({ w: 40, h: 15 }),
    })
    .default({ for_line: 'For {{company.name}}', name: '', designation: 'Authorised Signatory', align: 'right', box_mm: { w: 40, h: 15 } }),
  /** The original letterpad, for the 1 mm side-by-side check. */
  original: z.object({ first: fileRef, continuation: fileRef.optional() }).nullable().default(null),
  /** Picture of the letterpad for the template card while the real preview is drawn. */
  thumbnail: z.string().optional(),
  /**
   * Placeholder text from the Word letterpad (e.g. "{@body}") that may have been exported
   * into the PDF. Wherever it appears on the background it is covered with paper white.
   */
  body_marker: z.string().optional(),
  /** The Word letterpad, for Word output (Phase 2). */
  docx: z.string().optional(),
});

/** The letterpad-folder format (see samples/templates/README.md). */
const folderSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  page: z.object({ size: z.string().optional(), width_mm: z.number().optional(), height_mm: z.number().optional() }).optional(),
  docxBodyMarker: z.string().optional(),
  files: z.object({
    pdf: z.string().min(1),
    docx: z.string().optional(),
    thumbnail: z.string().optional(),
    /** Optional second letterpad PDF for page 2+. */
    continuationPdf: z.string().optional(),
  }),
  safeArea_mm: z.object({ top: num, bottom: num, left: num, right: num }),
  continuationSafeArea_mm: z.object({ top: num, bottom: num, left: num, right: num }).optional(),
  company: z.object({
    legalName: z.string().min(1),
    address: z.string().default(''),
    phones: z.array(z.string()).default([]),
    email: z.string().default(''),
    gstin: z.string().default(''),
  }),
  signature: z
    .object({
      forLine: z.string().optional(),
      name: z.string().default(''),
      designation: z.string().default('Authorised Signatory'),
    })
    .optional(),
});

function fromFolderFormat(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !('safeArea_mm' in raw)) return raw;
  const f = folderSchema.parse(raw);
  return {
    id: f.id,
    display_name: f.name,
    page_size: 'A4',
    company: { name: f.company.legalName, address: f.company.address, gstin: f.company.gstin, phone: f.company.phones.join(', '), email: f.company.email },
    first_page: { header: [], footer: [], safe_area_mm: f.safeArea_mm },
    continuation: f.continuationSafeArea_mm ? { header: [], footer: [], safe_area_mm: f.continuationSafeArea_mm } : null,
    background: {
      first: { file: f.files.pdf, page: 1 },
      ...(f.files.continuationPdf ? { continuation: { file: f.files.continuationPdf, page: 1 } } : {}),
    },
    signature: {
      for_line: f.signature?.forLine ?? `For ${f.company.legalName}`,
      name: f.signature?.name ?? '',
      designation: f.signature?.designation ?? 'Authorised Signatory',
    },
    original: { first: { file: f.files.pdf, page: 1 } },
    thumbnail: f.files.thumbnail,
    body_marker: f.docxBodyMarker,
    docx: f.files.docx,
  };
}

export const templateSchema = z.preprocess(fromFolderFormat, fullSchema);

export type TemplateDef = z.infer<typeof fullSchema>;

/** Page sizes in millimetres. */
export const PAGE_MM = { A4: [210, 297] as [number, number] };

export function fillPlaceholders(text: string, def: Pick<TemplateDef, 'company'>): string {
  return text.replace(/\{\{\s*company\.(\w+)\s*\}\}/g, (_m, key: string) => {
    const value = (def.company as Record<string, string | undefined>)[key];
    return value ?? '';
  });
}

export function resolveColour(value: string | undefined, def: Pick<TemplateDef, 'colours'>, fallback = '#111111'): string {
  if (!value) return fallback;
  if (value.startsWith('#')) return value;
  return def.colours[value] ?? fallback;
}

/** The page design used for a page (1-based). */
export function designFor(def: TemplateDef, page: number): PageDesign {
  return page > 1 && def.continuation ? def.continuation : def.first_page;
}

/** Every file a template needs at render time (logos, background PDFs, custom fonts). */
export function referencedFiles(def: TemplateDef): string[] {
  const files = new Set<string>();
  const layers = [def.first_page.header, def.first_page.footer, def.continuation?.header ?? [], def.continuation?.footer ?? []];
  for (const layer of layers) for (const el of layer) if (el.type === 'image') files.add(el.src);
  if (def.background) {
    files.add(def.background.first.file);
    if (def.background.continuation) files.add(def.background.continuation.file);
  }
  for (const f of def.fonts.custom) for (const file of [f.normal, f.bold, f.italics, f.bolditalics]) if (file) files.add(file);
  return [...files];
}
