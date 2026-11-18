// Draws the app icons (PWA manifest + favicon). Run: node scripts/make-icons.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'icons');
await mkdir(out, { recursive: true });

const NAVY = '#1d3a6b';
const GOLD = '#e0a526';

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function draw(size, maskable) {
  const c = createCanvas(size, size);
  const g = c.getContext('2d');
  // Maskable icons need the artwork inside the central 80% "safe zone".
  g.fillStyle = maskable ? NAVY : '#f7f5f0';
  if (maskable) g.fillRect(0, 0, size, size);
  else {
    roundRect(g, 0, 0, size, size, size * 0.22);
    g.fill();
  }
  const s = size * (maskable ? 0.5 : 0.62);
  const w = s * 0.82;
  const h = s;
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  const r = s * 0.11;
  // Sheet of paper
  g.fillStyle = maskable ? '#ffffff' : NAVY;
  roundRect(g, x, y, w, h, r);
  g.fill();
  // Letterhead band
  g.save();
  roundRect(g, x, y, w, h, r);
  g.clip();
  g.fillStyle = GOLD;
  g.fillRect(x, y, w, h * 0.26);
  g.restore();
  // Text lines
  g.fillStyle = maskable ? NAVY : '#ffffff';
  const lh = h * 0.07;
  [0.42, 0.58, 0.74].forEach((t, i) => {
    g.globalAlpha = 1 - i * 0.2;
    roundRect(g, x + w * 0.18, y + h * t, w * (i === 2 ? 0.38 : 0.64), lh, lh / 2);
    g.fill();
  });
  g.globalAlpha = 1;
  return c.toBuffer('image/png');
}

await writeFile(join(out, 'icon-192.png'), draw(192, false));
await writeFile(join(out, 'icon-512.png'), draw(512, false));
await writeFile(join(out, 'icon-maskable-512.png'), draw(512, true));

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="6" y="3" width="36" height="42" rx="6" fill="${NAVY}"/><path d="M6 9a6 6 0 0 1 6-6h24a6 6 0 0 1 6 6v5H6z" fill="${GOLD}"/><rect x="13" y="21" width="22" height="3" rx="1.5" fill="#fff"/><rect x="13" y="28" width="22" height="3" rx="1.5" fill="#fff" opacity=".8"/><rect x="13" y="35" width="13" height="3" rx="1.5" fill="#fff" opacity=".6"/></svg>\n`;
await writeFile(join(root, 'public', 'favicon.svg'), favicon);
console.log('icons written to public/icons and public/favicon.svg');
