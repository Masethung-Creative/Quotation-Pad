import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * The production security headers live in public/_headers (Cloudflare Pages format).
 * `vite preview` serves the same "/*" headers, so end-to-end tests run under the real CSP.
 */
function headersFromPagesFile(): Record<string, string> {
  const text = readFileSync(new URL('./public/_headers', import.meta.url), 'utf8');
  const headers: Record<string, string> = {};
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
    if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

/** Workbox plugin: never store a redirect or an HTML page (e.g. the Access login page). */
const rejectLoginPages = {
  cacheWillUpdate: async ({ response }: { response: Response }) => {
    if (!response || response.status !== 200 || response.redirected || response.type === 'opaqueredirect') return null;
    if ((response.headers.get('content-type') ?? '').includes('text/html')) return null;
    return response;
  },
};

function pagesHeaders(): Plugin {
  return {
    name: 'qp-pages-headers',
    configurePreviewServer(server) {
      const headers = headersFromPagesFile();
      server.middlewares.use((_req, res, next) => {
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    pagesHeaders(),
    VitePWA({
      registerType: 'autoUpdate',
      // Behind Cloudflare Access the manifest must be fetched with the login cookie.
      useCredentials: true,
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        id: '/',
        name: 'Quotation Pad',
        short_name: 'Quotation Pad',
        description: 'Any quotation, on your letterpad.',
        theme_color: '#1d3a6b',
        background_color: '#f7f5f0',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        lang: 'en-IN',
        categories: ['business', 'productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell, every lazy chunk, fonts and template files are precached, so Word files and
        // digital PDFs work offline after the first visit.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ttf,otf,pdf}'],
        globIgnores: ['tesseract/**', 'pdfjs/**', 'samples/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: '/index.html',
        // Paths that must reach the network: Cloudflare Access login/logout and the session probe.
        navigateFallbackDenylist: [/^\/login/, /^\/cdn-cgi\//, /^\/session\.json/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        // The OCR engine + language data and pdf.js support files are large: cached on first
        // use (or by the background download after the first visit).
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === self.location.origin && /^\/(tesseract|pdfjs)\//.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'qp-heavy-assets-v1',
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 400 },
              plugins: [rejectLoginPages],
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
  },
});
