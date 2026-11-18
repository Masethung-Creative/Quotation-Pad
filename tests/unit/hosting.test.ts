// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers';

/** Cloudflare Pages (public/_headers) and Vercel (vercel.json) must send the same security headers. */

function pagesHeaders(): Record<string, string> {
  const text = readFileSync(join(ROOT, 'public', '_headers'), 'utf8');
  const out: Record<string, string> = {};
  let inRoot = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inRoot = line.trim() === '/*';
      continue;
    }
    if (!inRoot) continue;
    const at = line.indexOf(':');
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

describe('hosting configuration', () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
    buildCommand: string;
    outputDirectory: string;
    rewrites: { source: string; destination: string }[];
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };

  it('Cloudflare and Vercel send identical security headers', () => {
    const fromVercel = Object.fromEntries(vercel.headers.find((h) => h.source === '/(.*)')!.headers.map((h) => [h.key, h.value]));
    expect(fromVercel).toEqual(pagesHeaders());
  });

  it('the CSP keeps every request on this site', () => {
    const csp = pagesHeaders()['Content-Security-Policy'];
    expect(csp).toContain("connect-src 'self' blob: data:");
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/https?:/);
  });

  it('Vercel builds the same output and serves the app for every address', () => {
    expect(vercel.buildCommand).toBe('npm run build');
    expect(vercel.outputDirectory).toBe('dist');
    expect(vercel.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
  });

  it('allows exactly the inline script of the static first screen (by hash), nothing else inline', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(inline).toHaveLength(1);
    const hash = createHash('sha256').update(inline[0]).digest('base64');
    const csp = pagesHeaders()['Content-Security-Policy'];
    expect(csp).toContain(`'sha256-${hash}'`);
    expect(csp).not.toContain("'unsafe-inline' 'wasm");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('the static first screen matches the live upload screen text', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const home = readFileSync(join(ROOT, 'src', 'pages', 'Home.tsx'), 'utf8');
    for (const text of ['Upload quotation', 'PDF, Word (.docx) or photo · up to 20 MB', 'Take a photo of a quotation']) {
      expect(html).toContain(text);
      expect(home).toContain(text);
    }
  });

  it('the Pages project name is quotationpad', () => {
    expect(readFileSync(join(ROOT, 'wrangler.toml'), 'utf8')).toMatch(/^name = "quotationpad"$/m);
  });
});
