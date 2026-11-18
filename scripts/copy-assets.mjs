// Copies the self-hosted runtime assets (OCR engine, OCR language data, pdf.js support
// files) out of node_modules into public/, so the app never calls a CDN at runtime.
// Runs automatically after `npm install`.
import { cp, mkdir, copyFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => join(root, 'node_modules', ...p);
const pub = (...p) => join(root, 'public', ...p);

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copy(from, to) {
  if (!(await exists(from))) {
    console.warn('[copy-assets] missing', from);
    return;
  }
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

// Tesseract.js worker + LSTM-only cores (the worker picks one by CPU feature detection).
await copy(nm('tesseract.js', 'dist', 'worker.min.js'), pub('tesseract', 'worker.min.js'));
for (const variant of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
  await copy(nm('tesseract.js-core', `${variant}.wasm.js`), pub('tesseract', 'core', `${variant}.wasm.js`));
}

// Language data: English, Tamil, Hindi (LSTM "best_int" models, a few MB each).
for (const lang of ['eng', 'tam', 'hin']) {
  await copy(
    nm('@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`),
    pub('tesseract', 'lang', `${lang}.traineddata.gz`),
  );
}

// pdf.js fallback fonts and character maps (needed only for PDFs that do not embed their fonts).
for (const dir of ['standard_fonts', 'cmaps', 'wasm']) {
  if (await exists(nm('pdfjs-dist', dir))) {
    await cp(nm('pdfjs-dist', dir), pub('pdfjs', dir), { recursive: true });
  }
}

console.log('[copy-assets] runtime assets copied to public/');
