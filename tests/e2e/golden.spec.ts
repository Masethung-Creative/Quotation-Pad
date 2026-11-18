import { expect, test, type Page } from '@playwright/test';
import { chooseTemplate, pickType, finish, pagePng, sampleFile, TEMPLATE_A, TEMPLATE_B, uploadQuotation } from './helpers';

/**
 * Golden-file visual tests: render through the real app, then compare every finished page
 * (drawn at the width shown on the 1440 px desktop screen) with the approved PNG within a small tolerance.
 * Update after an intended change with: npm run test:golden:update
 */

const TOLERANCE = { maxDiffPixelRatio: 0.01, threshold: 0.2 };

async function expectPages(page: Page, name: string, pages: number): Promise<void> {
  await expect(page.getByTestId('pdf-pages')).toHaveAttribute('data-pages', String(pages));
  for (let n = 1; n <= pages; n++) expect(await pagePng(page, n)).toMatchSnapshot(`${name}-p${n}.png`, TOLERANCE);
}

test.describe('Golden pages', () => {
  test('Word quotation on Mass Service Tech (original letterpad behind every page)', async ({ page }) => {
    await uploadQuotation(page, 'quotation.docx');
    await chooseTemplate(page, TEMPLATE_A);
    await finish(page);
    await expectPages(page, 'word-mass', 2);
  });

  test('Word quotation on RM Smart Service Tech (Tamil and Hindi lines)', async ({ page }) => {
    await uploadQuotation(page, 'quotation.docx');
    await chooseTemplate(page, TEMPLATE_B);
    await finish(page);
    await expectPages(page, 'word-rm', 2);
  });

  test('2-page digital PDF on Mass Service Tech (table continues with its header)', async ({ page }) => {
    await uploadQuotation(page, 'quotation-digital.pdf');
    await chooseTemplate(page, TEMPLATE_A);
    await finish(page);
    await expectPages(page, 'digital-mass', 2);
  });

  test('specification example with a photographed signature', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('quotation-file').setInputFiles(sampleFile('spec-example.json'));
    await pickType(page);
    await chooseTemplate(page, TEMPLATE_B);
    await page.getByTestId('sign-toggle').click();
    await page.getByRole('radio', { name: /Photo/ }).click();
    await page.getByTestId('signature-photo').setInputFiles(sampleFile('signature-photo.jpg'));
    await expect(page.getByTestId('signature-photo-preview')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('save-signature').click();
    await expect(page.getByTestId('signature-box')).toBeVisible();
    await finish(page);
    await expectPages(page, 'spec-rm-signed', 1);
  });
});
