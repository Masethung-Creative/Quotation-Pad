import { expect, test } from '@playwright/test';
import { chooseTemplate, sampleFile, sharedFiles, stubShare, TEMPLATE_A } from './helpers';

/**
 * "With mobile data off (after the first load): upload -> template -> share still works."
 * Playwright's WebKit support for service workers is partial, so this runs in Chromium.
 */
test.describe('Offline after the first load', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Service-worker offline mode is tested in Chromium');

  test('Word and photo quotations work with the network off', async ({ page, context }) => {
    await stubShare(page);
    await page.goto('/');
    // First visit: the service worker installs and takes control.
    await page.evaluate(() => navigator.serviceWorker.ready);
    if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);

    // The text scanner (OCR) is saved for offline use after the first visit.
    await page.goto('/settings');
    await page.getByRole('button', { name: /Download the text scanner/ }).click();
    await expect(page.getByTestId('ocr-offline-status')).toHaveText('Ready to read scans and photos offline.', { timeout: 120_000 });

    await context.setOffline(true);
    await page.goto('/');
    await expect(page.getByTestId('upload-button')).toBeVisible();

    for (const file of ['quotation.docx', 'quotation-photo.jpg']) {
      await page.goto('/');
      await page.getByTestId('quotation-file').setInputFiles(sampleFile(file));
      await expect(page.getByRole('heading', { name: 'Choose template' })).toBeVisible({ timeout: 120_000 });
      await chooseTemplate(page, TEMPLATE_A);
      await page.getByTestId('finish').click();
      const anyway = page.getByTestId('finish-anyway');
      const share = page.getByTestId('share');
      await expect(anyway.or(share)).toBeVisible({ timeout: 60_000 });
      if (await anyway.isVisible()) await anyway.click();
      await share.click();
    }
    await expect.poll(() => sharedFiles(page)).toHaveLength(2);
    for (const f of await sharedFiles(page)) expect(f.type).toBe('application/pdf');
    await context.setOffline(false);
  });
});
