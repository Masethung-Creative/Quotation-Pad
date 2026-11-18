// Post-build guard for the Cloudflare Pages free plan: at most 20,000 files and 25 MiB per
// file. Also prints how much JavaScript + CSS the first screen downloads (gzip).
import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const MAX_FILES = 20_000;
const MAX_BYTES = 25 * 1024 * 1024;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const files = await walk(dist);
let total = 0;
const tooBig = [];
for (const f of files) {
  const { size } = await stat(f);
  total += size;
  if (size > MAX_BYTES) tooBig.push(`${relative(dist, f)} (${(size / 1048576).toFixed(1)} MiB)`);
}

// First screen = the files index.html references directly (entry script, its preloads, CSS).
const html = await readFile(join(dist, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
let firstGzip = 0;
for (const ref of new Set(refs)) firstGzip += gzipSync(await readFile(join(dist, ref))).length;

console.log(`[check-dist] ${files.length} files, ${(total / 1048576).toFixed(1)} MiB in total`);
console.log(`[check-dist] first screen: ${refs.length} files, ${(firstGzip / 1024).toFixed(0)} KB gzip`);
if (files.length > MAX_FILES) {
  console.error(`[check-dist] too many files for Cloudflare Pages: ${files.length} > ${MAX_FILES}`);
  process.exit(1);
}
if (tooBig.length) {
  console.error(`[check-dist] files over 25 MiB (Cloudflare Pages limit):\n  ${tooBig.join('\n  ')}`);
  process.exit(1);
}
