import { looksNumeric } from '@/lib/format';
import type { Align } from '@/schema/canonical';

const SERIAL_HEADER_RE = /^(s\.?\s*no|sl\.?\s*no|sr\.?\s*no|#|no)\.?$/i;

/** Numbers go right, the serial-number column is centred, text stays left. */
export function inferColAlign(columns: string[], rows: string[][]): Align[] {
  return columns.map((header, c) => {
    const values = rows.map((r) => r[c] ?? '').filter((v) => v.trim());
    if (!values.length) return 'left';
    const numeric = values.filter((v) => looksNumeric(v) || /^\d[\d,.]*\s*%$/.test(v.trim())).length / values.length;
    if (numeric < 0.6) return 'left';
    if (c === 0 || SERIAL_HEADER_RE.test(header.trim())) return 'center';
    return 'right';
  });
}
