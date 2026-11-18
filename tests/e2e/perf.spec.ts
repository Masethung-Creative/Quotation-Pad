import { expect, test, type Page } from '@playwright/test';
import { sampleFile, TEMPLATE_A } from './helpers';

/**
 * Performance budgets on an emulated mid-range Android phone (Pixel 7 screen, CPU slowed
 * 4x like Lighthouse's mobile profile) - Chromium only, through the DevTools protocol.
 *  - first screen on screen in under 2 s on slow 4G (Lighthouse: 150 ms RTT, 1.6 Mbit/s)
 *  - upload button ready to tap in under 2 s on typical 4G (100 ms RTT, 9 Mbit/s)
 *  - a 15-row Word quotation -> finished PDF in under 10 s
 *  - a clean scanned A4 page read in under 30 s
 */

const NETWORKS = {
  slow4g: { latency: 150, down: 1.6, up: 0.75 },
  typical4g: { latency: 100, down: 9, up: 3 },
};

async function slowPhone(page: Page, network: keyof typeof NETWORKS | null): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  if (network) {
    const n = NETWORKS[network];
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: n.latency,
      downloadThroughput: (n.down * 1024 * 1024) / 8,
      uploadThroughput: (n.up * 1024 * 1024) / 8,
    });
  }
}

/** First contentful paint, largest contentful paint, and when the live upload button appeared. */
async function firstScreen(page: Page): Promise<{ fcp: number; lcp: number; ready: number }> {
  await page.goto('/', { waitUntil: 'commit' });
  await expect(page.getByTestId('upload-button')).toBeVisible({ timeout: 15_000 });
  return page.evaluate(
    () =>
      new Promise<{ fcp: number; lcp: number; ready: number }>((resolve) => {
        const ready = performance.now();
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1;
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          resolve({ fcp, lcp: entries[entries.length - 1]?.startTime ?? -1, ready });
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      }),
  );
}

test.describe('Performance on a mid-range phone', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Needs the Chromium DevTools protocol');

  test('first screen on screen in under 2 s on slow 4G', async ({ page }) => {
    await slowPhone(page, 'slow4g');
    const t = await firstScreen(page);
    console.log(`[perf] slow 4G, 4x slower CPU: first paint ${Math.round(t.fcp)} ms, largest paint ${Math.round(t.lcp)} ms, ready to tap ${Math.round(t.ready)} ms`);
    expect(t.fcp).toBeGreaterThan(0);
    expect(t.fcp).toBeLessThan(2000);
    expect(t.lcp).toBeLessThan(2000);
  });

  test('upload button ready to tap in under 2 s on typical 4G', async ({ page }) => {
    await slowPhone(page, 'typical4g');
    const t = await firstScreen(page);
    console.log(`[perf] typical 4G, 4x slower CPU: first paint ${Math.round(t.fcp)} ms, ready to tap ${Math.round(t.ready)} ms`);
    expect(t.ready).toBeLessThan(2000);
  });

  test('a 15-row Word quotation becomes a PDF in under 10 s', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('upload-button')).toBeVisible();
    await slowPhone(page, null);
    const t0 = Date.now();
    await page.getByTestId('quotation-file').setInputFiles(sampleFile('quotation.docx'));
    await expect(page.getByRole('heading', { name: 'Choose template' })).toBeVisible({ timeout: 30_000 });
    const tRead = Date.now() - t0;
    const t1 = Date.now();
    await page.locator(`[data-testid="template-card"][data-template="${TEMPLATE_A}"]`).click();
    await expect(page.getByTestId('finish')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('finish').click();
    await expect(page.getByTestId('done-banner')).toBeVisible({ timeout: 30_000 });
    const tMake = Date.now() - t1;
    console.log(`[perf] Word, 4x slower CPU: read ${tRead} ms, template + PDF ${tMake} ms, total ${tRead + tMake} ms`);
    expect(tRead + tMake).toBeLessThan(10_000);
  });

  test('a clean scanned A4 page is read in under 30 s', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('upload-button')).toBeVisible();
    // The OCR engine and English data are already on the phone after the first visit.
    await page.evaluate(async () => {
      for (const url of ['/tesseract/worker.min.js', '/tesseract/lang/eng.traineddata.gz']) await (await fetch(url)).arrayBuffer();
    });
    await slowPhone(page, null);
    const t0 = Date.now();
    await page.getByTestId('quotation-file').setInputFiles(sampleFile('quotation-scanned.pdf'));
    await expect(page.getByRole('heading', { name: 'Choose template' })).toBeVisible({ timeout: 60_000 });
    const ms = Date.now() - t0;
    console.log(`[perf] scanned page, 4x slower CPU: ${ms} ms`);
    expect(ms).toBeLessThan(30_000);
  });
});
