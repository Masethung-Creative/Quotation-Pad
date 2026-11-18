/**
 * "No content loss" check. Every word and number of the source must reach the output.
 * We compare token multisets and warn when more than 2% of the source tokens are missing.
 */

const TOKEN_RE = /[\p{L}\p{M}]+|\d[\d,]*(?:\.\d+)?/gu;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const norm = text.normalize('NFKC');
  for (const m of norm.matchAll(TOKEN_RE)) {
    let t = m[0];
    if (/^\d/.test(t)) t = t.replace(/,/g, '').replace(/\.$/, '');
    else t = t.toLowerCase();
    if (t) out.push(t);
  }
  return out;
}

export interface CoverageReport {
  sourceCount: number;
  outputCount: number;
  /** Source tokens that do not appear in the output (with repeats). */
  missing: string[];
  missingCount: number;
  missingPct: number;
  /** True when more than `threshold` of the source is missing. */
  warn: boolean;
}

export const COVERAGE_THRESHOLD = 0.02;

export function compareCoverage(sourceText: string, outputText: string, threshold = COVERAGE_THRESHOLD): CoverageReport {
  const source = tokenize(sourceText);
  const output = tokenize(outputText);
  const have = new Map<string, number>();
  for (const t of output) have.set(t, (have.get(t) ?? 0) + 1);

  const missing: string[] = [];
  for (const t of source) {
    const n = have.get(t) ?? 0;
    if (n > 0) have.set(t, n - 1);
    else missing.push(t);
  }
  const missingPct = source.length ? missing.length / source.length : 0;
  return {
    sourceCount: source.length,
    outputCount: output.length,
    missing,
    missingCount: missing.length,
    missingPct,
    warn: missingPct > threshold,
  };
}

/** Only the tokens that survive a PDF text round-trip reliably (ASCII letters and digits). */
export function asciiTokens(text: string): string {
  return tokenize(text)
    .filter((t) => /^[a-z0-9.]+$/.test(t))
    .join(' ');
}

/** Removes the tokens of `remove` (once each) from `source`. Used for text that was dropped on purpose. */
export function subtractTokens(source: string, remove: string): string {
  const drop = new Map<string, number>();
  for (const t of tokenize(remove)) drop.set(t, (drop.get(t) ?? 0) + 1);
  if (!drop.size) return source;
  const kept: string[] = [];
  for (const t of tokenize(source)) {
    const n = drop.get(t) ?? 0;
    if (n > 0) drop.set(t, n - 1);
    else kept.push(t);
  }
  return kept.join(' ');
}
