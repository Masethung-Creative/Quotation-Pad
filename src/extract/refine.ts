import { looksNumeric } from '@/lib/format';
import { blockText, type TotalsItem } from '@/schema/canonical';
import { classifyTotalsLabel } from '@/validate/totals';
import { inferColAlign } from './tableUtil';
import type { XBlock } from './types';

/**
 * Block-level clean-up shared by every extractor (Word, PDF, OCR):
 *  - joins a table that continued on the next page
 *  - lifts "Sub Total / GST / Grand Total" rows out of the table into a totals block
 *  - attaches the "Rupees ... Only" line to the totals
 *  - recognises the signature block
 */

type XTable = Extract<XBlock, { type: 'table' }>;
type XTotals = Extract<XBlock, { type: 'totals' }>;
type XParagraph = Extract<XBlock, { type: 'paragraph' }>;

const WORDS_RE = /^\(?\s*(((amount|total|rupees|rs\.?|inr)\b.*\b(only|paise)\b.*)|(.*\bin\s+words\b.*))$/i;
const SIGN_RE = /(authori[sz]ed\s+signator(y|ies)|\bproprietor\b|\bpartner\b|\bdirector\b|\bsignature\b|\bsignatory\b|seal\s*(&|and)\s*sign)/i;
const FOR_RE = /^for[\s,]+\S/i;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function mergeTables(blocks: XBlock[], repeated: string[]): XBlock[] {
  const out: XBlock[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    if (block.type === 'table' && prev?.type === 'table' && prev.columns.length === block.columns.length) {
      const sameHeader = block.columns.every((c, i) => norm(c) === norm(prev.columns[i]));
      const noHeader = block.columns.every((c) => !c.trim());
      const otherPage = prev._page !== undefined && block._page !== undefined && prev._page !== block._page;
      if (sameHeader || noHeader || otherPage) {
        // The heading row printed again on the next page is dropped on purpose; remember it so
        // the content-loss check does not count it as missing.
        if (sameHeader && !noHeader) repeated.push(block.columns.filter((c) => c.trim()).join(' '));
        const extra = sameHeader || noHeader ? block.rows : [block.columns, ...block.rows];
        const offset = prev.rows.length + (sameHeader || noHeader ? 0 : 1);
        const lowCells = [
          ...(prev._lowCells ?? []),
          ...(block._lowCells ?? [])
            .map((key) => key.split(':').map(Number))
            .filter(([r]) => r >= 0 || !(sameHeader || noHeader))
            .map(([r, c]) => `${r + offset}:${c}`),
        ];
        out[out.length - 1] = {
          ...prev,
          rows: [...prev.rows, ...extra],
          _conf: Math.min(prev._conf ?? 1, block._conf ?? 1),
          _lowCells: lowCells,
          _page: block._page,
        };
        continue;
      }
    }
    out.push(block);
  }
  return out;
}

function splitTableTotals(blocks: XBlock[]): XBlock[] {
  const out: XBlock[] = [];
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    if (block.type !== 'table') {
      out.push(block);
      continue;
    }
    const table: XTable = { ...block, rows: [...block.rows] };
    const items: TotalsItem[] = [];
    const low: string[] = [];
    let words: string | undefined;
    const lowSet = new Set(table._lowCells ?? []);

    let trailingEmpty = 0;
    while (table.rows.length > 1) {
      const r = table.rows.length - 1;
      const row = table.rows[r];
      const filled = row.map((c, i) => (c.trim() ? i : -1)).filter((i) => i >= 0);
      if (filled.length === 0) {
        table.rows.pop();
        trailingEmpty++;
        continue;
      }
      const joined = filled.map((i) => row[i].trim()).join(' ');
      if (filled.length <= 2 && WORDS_RE.test(joined) && !looksNumeric(row[filled[filled.length - 1]])) {
        words = words ?? joined;
        table.rows.pop();
        continue;
      }
      if (filled.length < 2 || filled.length > 3) break;
      const value = row[filled[filled.length - 1]].trim();
      if (!looksNumeric(value)) break;
      const label = filled
        .slice(0, -1)
        .map((i) => row[i].trim())
        .join(' ')
        .replace(/\s*:\s*$/, '');
      const kind = classifyTotalsLabel(label);
      if (kind === 'other') break;
      items.unshift({ label, value, ...(kind === 'grand' ? { bold: true } : {}) });
      filled.forEach((c) => lowSet.has(`${r}:${c}`) && low.push(row[c]));
      table.rows.pop();
    }

    if (!items.length) {
      // Nothing was a totals row: keep the table exactly as it was (restore empty rows).
      for (let e = 0; e < trailingEmpty; e++) table.rows.push(Array<string>(table.columns.length || (table.rows[0]?.length ?? 0)).fill(''));
      out.push(block.rows.length === table.rows.length ? block : table);
      continue;
    }
    // A lone "Total" at the very end is the grand total.
    const last = items[items.length - 1];
    if (classifyTotalsLabel(last.label) === 'total') last.bold = true;

    // Restore empty rows that were between the last item row and the totals.
    for (let e = 0; e < trailingEmpty; e++) table.rows.push(Array<string>(table.columns.length || (table.rows[0]?.length ?? 0)).fill(''));

    // The totals rows made numeric columns look like text; judge alignment again without them.
    table.col_align = inferColAlign(table.columns, table.rows);
    table._lowCells = (table._lowCells ?? []).filter((key) => Number(key.split(':')[0]) < table.rows.length);
    out.push(table);

    const next = blocks[b + 1];
    if (next?.type === 'totals') {
      blocks[b + 1] = {
        ...next,
        items: [...items, ...next.items],
        amount_in_words: next.amount_in_words ?? words,
        _low: [...low, ...(next._low ?? [])],
      };
    } else {
      out.push({ type: 'totals', items, ...(words ? { amount_in_words: words } : {}), _conf: table._conf, _low: low, _page: table._page });
    }
  }
  return out;
}

function attachAmountInWords(blocks: XBlock[]): XBlock[] {
  const out = [...blocks];
  for (let i = 0; i < out.length; i++) {
    const totals = out[i];
    if (totals.type !== 'totals' || totals.amount_in_words) continue;
    for (let j = i + 1, seen = 0; j < out.length && seen < 2; j++) {
      const cand = out[j];
      if (cand.type === 'spacer') continue;
      seen++;
      if (cand.type !== 'paragraph') break;
      const text = blockText(cand).replace(/\s+/g, ' ').trim();
      // "(Rupees ... Only)" followed by more lines in the same paragraph (the company name
      // above the signature): only the words up to "Only" are the amount in words.
      const full = blockText(cand).trim();
      const cut = full.match(/^([\s\S]*?\bonly\b[).\/-]*)\s+(\S[\s\S]*)$/i);
      if (cut) {
        const words = cut[1].replace(/\s+/g, ' ').trim();
        if (words.length <= 220 && WORDS_RE.test(words)) {
          const rest = cut[2].trim();
          const bold = cand.runs.every((r) => r.bold || !r.text.trim());
          out[i] = { ...totals, amount_in_words: words, _low: [...(totals._low ?? []), ...(cand._low ?? [])], _conf: Math.min(totals._conf ?? 1, cand._conf ?? 1) } as XTotals;
          out[j] = { ...cand, runs: [{ text: rest, ...(bold ? { bold: true } : {}) }] };
          break;
        }
      }
      if (text.length <= 220 && WORDS_RE.test(text)) {
        out[i] = { ...totals, amount_in_words: text, _low: [...(totals._low ?? []), ...(cand._low ?? [])], _conf: Math.min(totals._conf ?? 1, cand._conf ?? 1) } as XTotals;
        out.splice(j, 1);
        // Drop a spacer that only separated the two.
        if (out[j - 1]?.type === 'spacer' && j - 1 > i) out.splice(j - 1, 1);
        break;
      }
    }
  }
  return out;
}

function detectSignature(blocks: XBlock[]): XBlock[] {
  const isShortPara = (b: XBlock | undefined, max: number): b is XParagraph => b?.type === 'paragraph' && blockText(b).trim().length <= max;
  const tailStart = Math.max(0, blocks.length - 8);

  let anchor = -1;
  for (let i = blocks.length - 1; i >= tailStart; i--) {
    const b = blocks[i];
    if (isShortPara(b, 140) && SIGN_RE.test(blockText(b))) {
      anchor = i;
      break;
    }
  }
  let start = anchor;
  let end = anchor;
  if (anchor < 0) {
    // No "Authorised Signatory" line: accept a closing "For <Company>" near the end.
    for (let i = blocks.length - 1, seen = 0; i >= tailStart && seen < 3; i--) {
      const b = blocks[i];
      if (b.type === 'spacer') continue;
      seen++;
      if (isShortPara(b, 90) && FOR_RE.test(blockText(b).trim())) {
        start = end = i;
        break;
      }
    }
    if (start < 0) return blocks;
  } else {
    for (let i = anchor - 1, seen = 0; i >= 0 && seen < 3; i--) {
      const b = blocks[i];
      if (b.type === 'spacer') continue;
      seen++;
      if (isShortPara(b, 90) && FOR_RE.test(blockText(b).trim())) {
        start = i;
        break;
      }
      if (!isShortPara(b, 60)) break;
    }
    if (start === anchor) {
      // "MASS SERVICE TECH" printed above "Proprietor" (no "For"): the company line is part of the signature.
      let k = anchor - 1;
      while (k >= 0 && blocks[k].type === 'spacer') k--;
      const prev = blocks[k];
      if (isShortPara(prev, 60)) {
        const t = blockText(prev).trim();
        if (/[A-Z]{2}/.test(t) && t === t.toUpperCase() && !/\d/.test(t) && !t.includes('\n')) start = k;
      }
    }
    // Name / designation lines under the signature line.
    for (let i = anchor + 1, taken = 0; i < blocks.length && taken < 2; i++) {
      const b = blocks[i];
      if (b.type === 'spacer') continue;
      if (!isShortPara(b, 60)) break;
      end = i;
      taken++;
    }
    if (blocks.slice(end + 1).some((b) => b.type !== 'spacer')) end = anchor;
  }

  const lines: string[] = [];
  const low: string[] = [];
  let conf = 1;
  let align: 'left' | 'center' | 'right' = 'left';
  for (let i = start; i <= end; i++) {
    const b = blocks[i];
    if (b.type === 'spacer') {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      continue;
    }
    if (b.type !== 'paragraph') return blocks;
    lines.push(...blockText(b).split('\n').map((l) => l.trim()));
    low.push(...(b._low ?? []));
    conf = Math.min(conf, b._conf ?? 1);
    if (i === start) {
      if (b.align === 'right' || b.align === 'center') align = b.align;
      else if ((b._indent ?? 0) > 0.45) align = 'right';
    }
  }
  // Leave room to actually sign between "For <Company>" and "Authorised Signatory".
  if (lines.length >= 2 && !lines.includes('') && FOR_RE.test(lines[0])) lines.splice(1, 0, '');

  const signature: XBlock = { type: 'signature', lines, align, _conf: conf, _low: low, _page: blocks[start]._page };
  return [...blocks.slice(0, start), signature, ...blocks.slice(end + 1)];
}

function mergeMeta(blocks: XBlock[]): XBlock[] {
  const out: XBlock[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    if (block.type === 'meta' && prev?.type === 'meta') {
      const incoming = block.items.map((item, i) => (i === 0 ? { ...item, break: true as const } : item));
      out[out.length - 1] = {
        ...prev,
        items: [...prev.items, ...incoming],
        _conf: Math.min(prev._conf ?? 1, block._conf ?? 1),
        _low: [...(prev._low ?? []), ...(block._low ?? [])],
      };
    } else {
      out.push(block);
    }
  }
  return out;
}

function tidySpacers(blocks: XBlock[]): XBlock[] {
  const out: XBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'spacer' && (out.length === 0 || out[out.length - 1].type === 'spacer')) continue;
    out.push(block);
  }
  while (out.length && out[out.length - 1].type === 'spacer') out.pop();
  return out;
}

function dropEmpty(blocks: XBlock[]): XBlock[] {
  return blocks.filter((b) => {
    switch (b.type) {
      case 'spacer':
        return true;
      case 'table':
        return b.rows.length > 0 || b.columns.some((c) => c.trim());
      case 'meta':
      case 'totals':
      case 'list':
        return b.items.length > 0;
      default:
        return blockText(b).trim() !== '';
    }
  });
}

const DOC_TYPE_RE = /\b(?:type|document)\s*:\s*(tax\s+invoice|proforma\s+invoice|pro-forma\s+invoice|invoice|quotation|estimate|proforma|purchase\s+order|delivery\s+challan|work\s+order)\b/i;
const CONTACT_RE = /@[\w-]+\.\w|(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b|\b\d{6}\b/;

/**
 * The sender's own letterhead typed after the signature (company name, address, phone,
 * e-mail): the chosen template prints the letterhead, so these lines are left out (and
 * listed as left out on purpose, so the content check does not count them as lost).
 */
function dropTrailingLetterhead(blocks: XBlock[], repeated: string[]): XBlock[] {
  let sig = -1;
  for (let i = blocks.length - 1; i >= 0 && sig < 0; i--) if (blocks[i].type === 'signature') sig = i;
  if (sig < 0) return blocks;
  const tail = blocks.slice(sig + 1).filter((b) => b.type !== 'spacer');
  if (tail.length < 2 || tail.length > 6) return blocks;
  const short = tail.every((b) => (b.type === 'paragraph' || b.type === 'heading') && !blockText(b).includes('\n') && blockText(b).length <= 130);
  const contacts = tail.filter((b) => CONTACT_RE.test(blockText(b))).length;
  if (!short || contacts < 2) return blocks;
  repeated.push(...tail.map((b) => blockText(b)));
  return blocks.slice(0, sig + 1);
}

/**
 * No title in the source, but it says what it is ("TYPE: INVOICE" in the details box):
 * print that as the title. It is an ordinary heading block, so it can be edited or removed.
 */
function addTitle(blocks: XBlock[]): XBlock[] {
  const head = blocks.filter((b) => b.type !== 'spacer').slice(0, 4);
  if (head.some((b) => b.type === 'heading')) return blocks;
  for (const b of head) {
    const m = blockText(b).match(DOC_TYPE_RE);
    if (m) return [{ type: 'heading', text: m[1].replace(/\s+/g, ' ').toUpperCase(), level: 1, align: 'center', _conf: 1 }, ...blocks];
  }
  return blocks;
}

/**
 * @param repeated receives text left out on purpose: table heading rows repeated on the
 *   next page, and the sender's letterhead typed after the signature.
 */
export function refineBlocks(blocks: XBlock[], repeated: string[] = []): XBlock[] {
  let out = dropEmpty(blocks);
  out = mergeTables(out, repeated);
  out = splitTableTotals(out);
  out = attachAmountInWords(out);
  out = detectSignature(out);
  out = dropTrailingLetterhead(out, repeated);
  out = mergeMeta(out);
  out = addTitle(out);
  return tidySpacers(out);
}
