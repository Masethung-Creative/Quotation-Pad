// Downloads the Noto fonts (SIL Open Font License 1.1) that get embedded into output PDFs.
// The fonts are committed under public/fonts, so this only needs to run when updating them.
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'fonts');
const base = 'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts';
const files = [
  ['NotoSans/hinted/ttf/NotoSans-Regular.ttf', 'NotoSans-Regular.ttf'],
  ['NotoSans/hinted/ttf/NotoSans-Bold.ttf', 'NotoSans-Bold.ttf'],
  ['NotoSans/hinted/ttf/NotoSans-Italic.ttf', 'NotoSans-Italic.ttf'],
  ['NotoSans/hinted/ttf/NotoSans-BoldItalic.ttf', 'NotoSans-BoldItalic.ttf'],
  ['NotoSansTamil/hinted/ttf/NotoSansTamil-Regular.ttf', 'NotoSansTamil-Regular.ttf'],
  ['NotoSansTamil/hinted/ttf/NotoSansTamil-Bold.ttf', 'NotoSansTamil-Bold.ttf'],
  ['NotoSansDevanagari/hinted/ttf/NotoSansDevanagari-Regular.ttf', 'NotoSansDevanagari-Regular.ttf'],
  ['NotoSansDevanagari/hinted/ttf/NotoSansDevanagari-Bold.ttf', 'NotoSansDevanagari-Bold.ttf'],
];

await mkdir(out, { recursive: true });
const force = process.argv.includes('--force');
for (const [src, name] of files) {
  const dest = join(out, name);
  if (!force) {
    try {
      await stat(dest);
      console.log('have  ', name);
      continue;
    } catch {}
  }
  const res = await fetch(`${base}/${src}`);
  if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.readUInt32BE(0) !== 0x00010000) throw new Error(`${src}: not a TrueType file`);
  await writeFile(dest, buf);
  console.log('fetched', name, (buf.length / 1024).toFixed(0) + ' KB');
}
