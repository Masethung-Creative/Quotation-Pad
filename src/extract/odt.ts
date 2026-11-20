import type { Align } from '@/schema/canonical';
import { htmlToBlocks } from './docx';
import { refineBlocks } from './refine';
import { subtractTokens } from '@/validate/coverage';
import { finalizeBlocks, type ExtractResult } from './types';

/**
 * OpenDocument Text (.odt) -> canonical blocks.
 * ODT files are ZIP archives; content.xml holds the body in ODF XML.
 * We convert that XML to the same simple HTML that mammoth produces from DOCX,
 * then reuse htmlToBlocks.
 */

async function readZipEntry(buffer: ArrayBuffer, name: string): Promise<string | null> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entries = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  for (let n = 0; n < entries && p + 46 <= bytes.length; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) return null;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const skip = nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const entryName = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + skip;
    if (entryName !== name) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.slice(start, start + size);
    if (method === 0) return new TextDecoder().decode(raw);
    if (method === 8 && typeof DecompressionStream !== 'undefined') {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    }
    return null;
  }
  return null;
}

const ALIGN_MAP: Record<string, Align> = {
  start: 'left', left: 'left',
  center: 'center',
  end: 'right', right: 'right',
  justify: 'justify',
};

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Convert ODF content.xml to simple HTML (paragraphs, headings, bold/italic/underline, tables, lists). */
function odfToHtml(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
  const TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
  const FO_NS = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0';
  const STYLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';

  // Collect automatic styles for alignment and text properties.
  const styleAlign = new Map<string, string>();
  const styleBold = new Set<string>();
  const styleItalic = new Set<string>();
  const styleUnderline = new Set<string>();

  for (const style of Array.from(doc.getElementsByTagNameNS(STYLE_NS, 'style'))) {
    const name = style.getAttribute(STYLE_NS + ':name') ?? style.getAttributeNS(STYLE_NS, 'name') ?? style.getAttribute('style:name') ?? '';
    if (!name) continue;
    const pp = style.getElementsByTagNameNS(STYLE_NS, 'paragraph-properties')[0];
    if (pp) {
      const align = pp.getAttributeNS(FO_NS, 'text-align') ?? pp.getAttribute('fo:text-align') ?? '';
      if (align) styleAlign.set(name, align.toLowerCase());
    }
    const tp = style.getElementsByTagNameNS(STYLE_NS, 'text-properties')[0];
    if (tp) {
      const weight = tp.getAttributeNS(FO_NS, 'font-weight') ?? tp.getAttribute('fo:font-weight') ?? '';
      if (weight === 'bold' || Number(weight) >= 700) styleBold.add(name);
      const fStyle = tp.getAttributeNS(FO_NS, 'font-style') ?? tp.getAttribute('fo:font-style') ?? '';
      if (fStyle === 'italic' || fStyle === 'oblique') styleItalic.add(name);
      const uStyle = tp.getAttributeNS(STYLE_NS, 'text-underline-style') ?? tp.getAttribute('style:text-underline-style') ?? '';
      if (uStyle && uStyle !== 'none') styleUnderline.add(name);
    }
  }

  const html: string[] = [];

  function alignClass(styleName: string): string {
    const a = styleAlign.get(styleName);
    const mapped = a ? ALIGN_MAP[a] : undefined;
    if (mapped && mapped !== 'left') return ` class="qp-${mapped === 'justify' ? 'both' : mapped}"`;
    return '';
  }

  function convertSpan(node: Node): string {
    if (node.nodeType === 3) return esc(node.textContent ?? '');
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    const local = el.localName;
    if (local === 'line-break') return '<br/>';
    if (local === 'tab') return '\t';
    if (local === 's') {
      const count = Number(el.getAttributeNS(NS, 'c') ?? el.getAttribute('text:c') ?? '1');
      return ' '.repeat(count);
    }
    if (local === 'span') {
      const sName = el.getAttributeNS(NS, 'style-name') ?? el.getAttribute('text:style-name') ?? '';
      let inner = '';
      for (const child of Array.from(el.childNodes)) inner += convertSpan(child);
      if (styleBold.has(sName)) inner = `<strong>${inner}</strong>`;
      if (styleItalic.has(sName)) inner = `<em>${inner}</em>`;
      if (styleUnderline.has(sName)) inner = `<u>${inner}</u>`;
      return inner;
    }
    if (local === 'a') {
      let inner = '';
      for (const child of Array.from(el.childNodes)) inner += convertSpan(child);
      return inner;
    }
    let inner = '';
    for (const child of Array.from(el.childNodes)) inner += convertSpan(child);
    return inner;
  }

  function convertParagraph(el: Element, tag: string): string {
    const sName = el.getAttributeNS(NS, 'style-name') ?? el.getAttribute('text:style-name') ?? '';
    const cls = alignClass(sName);
    let inner = '';
    for (const child of Array.from(el.childNodes)) inner += convertSpan(child);
    // Whole-paragraph bold/italic from the paragraph style
    if (styleBold.has(sName)) inner = `<strong>${inner}</strong>`;
    if (styleItalic.has(sName)) inner = `<em>${inner}</em>`;
    return `<${tag}${cls}>${inner}</${tag}>`;
  }

  function convertElement(el: Element): void {
    const local = el.localName;
    if (local === 'p') {
      html.push(convertParagraph(el, 'p'));
    } else if (local === 'h') {
      const level = Math.min(3, Math.max(1, Number(el.getAttributeNS(NS, 'outline-level') ?? el.getAttribute('text:outline-level') ?? '1')));
      html.push(convertParagraph(el, `h${level}`));
    } else if (local === 'list') {
      const items: string[] = [];
      for (const item of Array.from(el.children)) {
        if (item.localName === 'list-item') {
          const parts: string[] = [];
          for (const child of Array.from(item.children)) {
            if (child.localName === 'p') {
              let inner = '';
              for (const c of Array.from(child.childNodes)) inner += convertSpan(c);
              parts.push(inner);
            }
          }
          items.push(`<li>${parts.join('<br/>')}</li>`);
        }
      }
      // ODF does not mark ordered vs unordered clearly; check for bullet style.
      const isOrdered = el.getAttributeNS(NS, 'style-name')?.includes('L') ?? false;
      const tag = isOrdered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.join('')}</${tag}>`);
    } else if (local === 'table') {
      html.push('<table>');
      for (const child of Array.from(el.children)) {
        if (child.localName === 'table-row') {
          html.push('<tr>');
          for (const cell of Array.from(child.children)) {
            if (cell.localName === 'table-cell') {
              const span = cell.getAttributeNS(TABLE_NS, 'number-columns-spanned') ??
                           cell.getAttribute('table:number-columns-spanned') ?? '';
              const spanAttr = span && Number(span) > 1 ? ` colspan="${span}"` : '';
              const repeat = Number(cell.getAttributeNS(TABLE_NS, 'number-columns-repeated') ??
                                    cell.getAttribute('table:number-columns-repeated') ?? '1');
              for (let r = 0; r < repeat; r++) {
                html.push(`<td${spanAttr}>`);
                for (const p of Array.from(cell.children)) {
                  if (p.localName === 'p' || p.localName === 'h') {
                    html.push(convertParagraph(p, 'p'));
                  }
                }
                html.push('</td>');
              }
            }
          }
          html.push('</tr>');
        }
      }
      html.push('</table>');
    } else if (local === 'section' || local === 'text') {
      for (const child of Array.from(el.children)) convertElement(child as Element);
    }
  }

  // Find the body > text element.
  const bodies = doc.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:office:1.0', 'body');
  const body = bodies[0];
  if (body) {
    const textEl = body.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:office:1.0', 'text')[0];
    if (textEl) {
      for (const child of Array.from(textEl.children)) convertElement(child as Element);
    }
  }

  return html.join('');
}

export interface OdtHtml {
  html: string;
  messages: string[];
}

export async function odtToHtml(arrayBuffer: ArrayBuffer): Promise<OdtHtml> {
  const xml = await readZipEntry(arrayBuffer, 'content.xml');
  if (!xml) throw new Error('This ODT file does not contain content.xml.');
  const html = odfToHtml(xml);
  return { html, messages: [] };
}

export function finishOdt(parsed: OdtHtml): ExtractResult {
  const { blocks, text, images } = htmlToBlocks(parsed.html);
  const warnings: string[] = [];
  if (images > 0) {
    warnings.push(`${images} picture${images > 1 ? 's' : ''} in the ODT file ${images > 1 ? 'were' : 'was'} not copied.`);
  }
  const repeated: string[] = [];
  const doc = finalizeBlocks(refineBlocks(blocks, repeated));
  return {
    doc,
    sourceText: subtractTokens(text, repeated.join(' ')),
    removed: repeated,
    warnings,
    method: 'odt',
    pages: 0,
  };
}
