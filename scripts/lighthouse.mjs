// Lighthouse (mobile) for every screen of the app, against the production build.
// Usage: npm run build && npm run preview   (in another terminal)  then  npm run lighthouse
// Targets from the brief: performance >= 85 and accessibility >= 95.
//
// The screens after the upload need a quotation in the browser's storage, so a real
// quotation is first put through the app with Playwright in the same Chrome profile; then
// Lighthouse audits each address with storage kept (disableStorageReset).
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import lighthouse from 'lighthouse';

const BASE = process.env.QP_URL ?? 'http://localhost:4391';
const PORT = 9333;
const PERF_MIN = 0.85;
const A11Y_MIN = 0.95;
const outDir = join(process.cwd(), 'reports', 'lighthouse');
await mkdir(outDir, { recursive: true });

const profile = await mkdtemp(join(tmpdir(), 'qp-lh-'));
const context = await chromium.launchPersistentContext(profile, { headless: true, args: [`--remote-debugging-port=${PORT}`] });

let id = '';
try {
  const page = await context.newPage();
  await page.goto(BASE);
  await page.getByTestId('quotation-file').setInputFiles(join(process.cwd(), 'samples', 'quotation.docx'));
  await page.getByRole('heading', { name: 'Choose template' }).waitFor({ timeout: 60_000 });
  id = new URL(page.url()).pathname.split('/').pop();
  await page.getByTestId('template-card').first().click();
  await page.getByTestId('finish').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="finish"]')?.hasAttribute('disabled'), null, { timeout: 60_000 });
  await page.getByTestId('finish').click();
  await page.getByTestId('done-banner').waitFor({ timeout: 60_000 });
  await page.close();

  const screens = [
    ['Upload (first screen)', '/'],
    ['Choose template', `/template/${id}`],
    ['Review & sign', `/review/${id}`],
    ['Done', `/done/${id}`],
    ['Settings', '/settings'],
  ];
  // Lighthouse scores vary from run to run on a busy machine (it multiplies observed CPU time
  // by 4), so every screen is measured RUNS times and the median score is used.
  const RUNS = Number(process.env.LH_RUNS ?? 3);
  const median = (xs) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
  const rows = [];
  let failed = false;
  for (const [name, path] of screens) {
    const perfs = [];
    const a11ys = [];
    const failing = new Set();
    let report = '';
    for (let run = 0; run < RUNS; run++) {
      const result = await lighthouse(`${BASE}${path}`, {
        port: PORT,
        output: 'html',
        logLevel: 'error',
        onlyCategories: ['performance', 'accessibility'],
        disableStorageReset: true,
      });
      const { performance, accessibility } = result.lhr.categories;
      perfs.push(performance.score ?? 0);
      a11ys.push(accessibility.score ?? 0);
      for (const ref of accessibility.auditRefs) {
        const audit = result.lhr.audits[ref.id];
        if (ref.weight > 0 && audit.score !== null && audit.score < 1) failing.add(ref.id);
      }
      report = result.report;
    }
    const slug = name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-+$/, '');
    await writeFile(join(outDir, `${slug}.html`), report);
    const perf = median(perfs);
    const a11y = Math.min(...a11ys);
    const ok = perf >= PERF_MIN && a11y >= A11Y_MIN;
    if (!ok) failed = true;
    rows.push({
      screen: name,
      'performance (median)': Math.round(perf * 100),
      runs: perfs.map((p) => Math.round(p * 100)).join(' / '),
      accessibility: Math.round(a11y * 100),
      ok: ok ? 'yes' : 'NO',
      'a11y issues': [...failing].join(', '),
    });
  }
  console.table(rows);
  console.log(`Reports: ${outDir}`);
  if (failed) process.exitCode = 1;
} finally {
  await context.close();
}
