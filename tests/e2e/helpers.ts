import { expect, type Page } from '@playwright/test';
import { join } from 'node:path';

export const SAMPLES = join(process.cwd(), 'samples');
export const sampleFile = (name: string) => join(SAMPLES, name);

/** The two real companies. */
export const TEMPLATE_A = 'mass-service-tech';
export const TEMPLATE_B = 'rm-smart-service-tech';

/**
 * "Invoice or quotation?" (after reading) -> Choose template. Taps the given type, or the
 * one the app suggests.
 */
export async function pickType(page: Page, type?: 'quotation' | 'invoice', timeout = 110_000): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Invoice or quotation?' })).toBeVisible({ timeout });
  const card = page.locator(type ? `[data-testid="type-card"][data-type="${type}"]` : '[data-testid="type-card"][data-suggested="true"]');
  await card.click();
  await expect(page.getByRole('heading', { name: 'Choose template' })).toBeVisible();
}

/** Home (upload) -> file -> "Reading..." -> Invoice or quotation -> Choose template screen. */
export async function uploadQuotation(page: Page, file: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('quotation-file').setInputFiles(sampleFile(file));
  await pickType(page);
  await expect(page.getByTestId('template-card')).toHaveCount(2);
}

/** Tap a template card; ends on Review & sign with the preview drawn. */
export async function chooseTemplate(page: Page, templateId = TEMPLATE_A): Promise<void> {
  await page.locator(`[data-testid="template-card"][data-template="${templateId}"]`).click();
  await expect(page.getByRole('heading', { name: 'Review & sign' })).toBeVisible();
  await expect(page.getByTestId('pdf-pages').first()).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await expect(page.getByTestId('check-banner')).toHaveAttribute('data-count', /\d+/);
}

/** Review -> Finish (confirming the "before you finish" sheet when it appears) -> Done. */
export async function finish(page: Page): Promise<void> {
  await page.getByTestId('finish').click();
  const anyway = page.getByTestId('finish-anyway');
  const banner = page.getByTestId('done-banner');
  await expect(anyway.or(banner)).toBeVisible({ timeout: 60_000 });
  if (await anyway.isVisible()) await anyway.click();
  await expect(banner).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('pdf-pages')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
}

/** The values of every editable field on the review screen, joined - handy for content assertions. */
export async function reviewText(page: Page): Promise<string> {
  return page.getByTestId('blocks').evaluate((root) => {
    const parts: string[] = [];
    // Phones list table items as buttons (tap to edit), so their text counts too.
    root.querySelectorAll('textarea, input, [contenteditable], [data-testid="signature-block"], [data-testid="item-row"]').forEach((el) => {
      parts.push(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : (el.textContent ?? ''));
    });
    return parts.join('\n');
  });
}

/** PNG bytes of one rendered page, as drawn on screen (width = shown width x pixel ratio). */
export async function pagePng(page: Page, n: number, scope = page.locator('body')): Promise<Buffer> {
  const dataUrl = await scope.locator(`canvas[data-page="${n}"]`).first().evaluate((c) => (c as HTMLCanvasElement).toDataURL('image/png'));
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** Draws a signature-like squiggle on the signature pad with mouse or touch-like strokes. */
export async function drawSignature(page: Page): Promise<void> {
  const canvas = page.getByTestId('signature-canvas');
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const strokes = [
    [
      [0.15, 0.7],
      [0.25, 0.25],
      [0.35, 0.65],
      [0.45, 0.3],
      [0.55, 0.6],
      [0.65, 0.35],
      [0.8, 0.55],
    ],
    [
      [0.2, 0.8],
      [0.85, 0.75],
    ],
  ];
  for (const stroke of strokes) {
    const [first, ...rest] = stroke.map(([fx, fy]) => at(fx, fy));
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    for (const p of rest) await page.mouse.move(p.x, p.y, { steps: 8 });
    await page.mouse.up();
  }
}

/** Replaces the Web Share API with a recorder so tests can see what would be shared. */
export async function stubShare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data: { files?: File[] }) => !!data?.files?.length });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: { files?: File[] }) => {
        const log = JSON.parse(sessionStorage.getItem('qp-test-shared') ?? '[]') as unknown[];
        for (const f of data.files ?? []) log.push({ name: f.name, type: f.type, size: f.size });
        sessionStorage.setItem('qp-test-shared', JSON.stringify(log));
      },
    });
  });
}

export async function sharedFiles(page: Page): Promise<{ name: string; type: string; size: number }[]> {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('qp-test-shared') ?? '[]') as { name: string; type: string; size: number }[]);
}
