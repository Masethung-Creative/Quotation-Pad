import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { brokenPdf, hugePdf, legacyDoc, lockedPdf } from './fixtures';
import { chooseTemplate, pickType, drawSignature, finish, reviewText, sampleFile, sharedFiles, stubShare, TEMPLATE_A, TEMPLATE_B, uploadQuotation } from './helpers';

/** Downloads the finished PDF from the Done screen and returns its name and text. */
async function downloadResult(page: Page): Promise<{ name: string; bytes: Uint8Array; pages: string[] }> {
  const download = page.waitForEvent('download');
  await page.getByTestId('download').click();
  const file = await download;
  const bytes = new Uint8Array(readFileSync(await file.path()));
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map((i) => ('str' in i ? i.str : '')).join(' '));
  }
  await task.destroy();
  return { name: file.suggestedFilename(), bytes, pages };
}

async function imageCount(bytes: Uint8Array): Promise<{ images: number; masked: number }> {
  const doc = await PDFDocument.load(bytes);
  let images = 0;
  let masked = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      images++;
      if (obj.dict.get(PDFName.of('SMask'))) masked++;
    }
  }
  return { images, masked };
}


test.describe('Word quotation (15-row table)', () => {
  test('upload -> template -> PDF on that letterhead with every row', async ({ page }) => {
    await uploadQuotation(page, 'quotation.docx');
    await chooseTemplate(page, TEMPLATE_B);
    await expect(page.getByTestId('check-banner')).toHaveAttribute('data-count', '0');
    const text = await reviewText(page);
    expect(text).toContain('Installation and testing charges');
    expect(text).toContain('நன்றி');
    expect(text).toContain('धन्यवाद');
    await finish(page);
    // "<Bill No> - <Letterpad name>.pdf"
    await expect(page.getByTestId('file-name')).toHaveText('Q-2026-27-045 - Quotation - RM Smart Service Tech.pdf');
    const result = await downloadResult(page);
    expect(result.name).toBe('Q-2026-27-045 - Quotation - RM Smart Service Tech.pdf');
    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    expect(result.pages.length).toBeLessThanOrEqual(2);
    const all = result.pages.join('\n');
    for (const piece of ['Earthing Electrode with chemical compound', '1,94,210.00', '17,478.90', '2,29,167.80', 'For RM SMART SERVICE TECH', 'Authorised Signatory']) {
      expect(all).toContain(piece);
    }
    // The template's signature block replaced the source's.
    expect(all).not.toContain('For Sri Velan Electricals');
  });
});

test.describe('Digital PDF with a wrong amount', () => {
  test('flags the wrong amount in amber, jumps to it, and never changes it', async ({ page }) => {
    await uploadQuotation(page, 'quotation-digital.pdf');
    await chooseTemplate(page, TEMPLATE_A);
    const banner = page.getByTestId('check-banner');
    await expect(banner).toHaveAttribute('data-count', '2');
    await page.getByTestId('jump-next').click();
    const flagged = page.locator('[data-testid="blocks"] [data-flag="true"]');
    await expect(flagged.first()).toBeInViewport();
    await expect(flagged.first()).toHaveValue('9,200.00');
    // The sender's own header/footer and page numbers were left out on purpose.
    await page.getByRole('button', { name: 'Check details' }).click();
    await expect(page.getByTestId('removed-lines')).toContainText('SRI VELAN ELECTRICALS');
    await expect(page.getByTestId('removed-lines')).toContainText('Page 1 of 2');
    await page.keyboard.press('Escape');
    // Finishing asks first, then makes the PDF with the number exactly as written.
    await page.getByTestId('finish').click();
    await page.getByTestId('finish-anyway').click();
    await expect(page.getByTestId('done-banner')).toBeVisible({ timeout: 60_000 });
    const result = await downloadResult(page);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]).toContain('9,200.00');
    // The original letterpad is behind every page (its text stays real text in the PDF).
    expect(result.pages[0]).toContain('MASS SERVICE TECH');
    expect(result.pages[1]).toContain('MASS SERVICE TECH');
    expect(result.pages.join(' ')).not.toContain('Page 1 of 2');
    expect(result.name).toBe('Q-2026-27-046 - Quotation - Mass Service Tech.pdf');
  });
});

test.describe('Scans and photos (OCR)', () => {
  for (const file of ['quotation-scanned.pdf', 'quotation-photo.jpg']) {
    test(`${file}: reads every amount and offers to drop the sender's letterhead`, async ({ page }) => {
      await page.goto('/');
      await page.getByTestId('quotation-file').setInputFiles(sampleFile(file));
      await expect(page.getByTestId('extract-progress')).toBeVisible();
      await pickType(page, undefined, 120_000);
      await chooseTemplate(page, TEMPLATE_A);
      const text = await reviewText(page);
      for (const amount of ['18,500.00', '10,080.00', '18,900.00', '9,100.00', '7,500.00', '64,080.00', '5,767.20', '75,614.40']) expect(text).toContain(amount);
      await expect(page.getByTestId('letterhead-hint')).toBeVisible();
      await page.getByTestId('remove-letterhead').click();
      await expect(page.getByTestId('letterhead-hint')).toBeHidden();
      await finish(page);
      const result = await downloadResult(page);
      expect(result.pages[0]).toContain('75,614.40');
      expect(result.pages[0]).not.toContain('SRI VELAN ELECTRICALS');
    });
  }
});

test.describe('Signatures', () => {
  test('drawn signature: transparent on the PDF; switched off = no signature', async ({ page }) => {
    for (const template of [TEMPLATE_A, TEMPLATE_B]) {
      await uploadQuotation(page, 'quotation.docx');
      await chooseTemplate(page, template);
      await finish(page);
      const before = await imageCount((await downloadResult(page)).bytes);

      await page.getByRole('link', { name: 'Edit again' }).click();
      await page.getByTestId('sign-toggle').click();
      if (template === TEMPLATE_A) {
        await drawSignature(page);
        await page.getByTestId('save-signature').click();
      }
      await expect(page.getByTestId('signature-box')).toBeVisible();
      await finish(page);
      const signed = await imageCount((await downloadResult(page)).bytes);
      // Exactly one more picture, with a soft mask (its alpha channel): the ink only, no white box.
      expect(signed.images - before.images).toBe(2);
      expect(signed.masked - before.masked).toBe(1);

      await page.getByRole('link', { name: 'Edit again' }).click();
      await expect(page.getByTestId('sign-toggle')).toHaveAttribute('data-state', 'checked');
      await page.getByTestId('sign-toggle').click();
      await expect(page.getByTestId('signature-box')).toBeHidden();
      await finish(page);
      expect(await imageCount((await downloadResult(page)).bytes)).toEqual(before);
    }
  });

  test('photographed signature: white paper removed, placed above the signatory name', async ({ page }) => {
    await uploadQuotation(page, 'quotation.docx');
    await chooseTemplate(page, TEMPLATE_A);
    await finish(page);
    const before = await imageCount((await downloadResult(page)).bytes);
    await page.getByRole('link', { name: 'Edit again' }).click();
    await page.getByTestId('sign-toggle').click();
    await page.getByRole('radio', { name: /Photo/ }).click();
    await page.getByTestId('signature-photo').setInputFiles(sampleFile('signature-photo.jpg'));
    await expect(page.getByTestId('signature-photo-preview')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('save-signature').click();
    const box = page.getByTestId('signature-box');
    await expect(box).toBeVisible();
    // Sits between "For <Company>" and the signatory name on the last page.
    const pageCanvas = page.locator('[data-page-wrapper]').filter({ has: box });
    await expect(pageCanvas).toHaveCount(1);
    await finish(page);
    const result = await downloadResult(page);
    const after = await imageCount(result.bytes);
    expect(after.images - before.images).toBe(2);
    expect(after.masked - before.masked).toBe(1);
    expect(result.pages.join(' ')).toContain('For MASS SERVICE TECH');
  });

  test('the position is remembered per template', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Mouse drag; touch dragging uses the same code path');
    await uploadQuotation(page, 'quotation.docx');
    await chooseTemplate(page, TEMPLATE_A);
    await page.getByTestId('sign-toggle').click();
    await drawSignature(page);
    await page.getByTestId('save-signature').click();
    const box = page.getByTestId('signature-box');
    await box.scrollIntoViewIfNeeded();
    const before = (await box.boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 - 120, before.y + before.height / 2 - 6, { steps: 10 });
    await page.mouse.up();
    const moved = (await box.boundingBox())!;
    expect(moved.x).toBeLessThan(before.x - 60);

    await page.reload();
    await expect(page.getByTestId('pdf-pages')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
    await box.scrollIntoViewIfNeeded();
    const afterReload = (await box.boundingBox())!;
    expect(Math.abs(afterReload.x - moved.x)).toBeLessThan(3);

    // Another template has its own (default) position.
    await page.getByTestId('template-chip').filter({ hasText: 'RM Smart' }).click();
    await expect(page.getByTestId('template-chip').filter({ hasText: 'RM Smart' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('pdf-pages')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
    await box.scrollIntoViewIfNeeded();
    const other = (await box.boundingBox())!;
    expect(Math.abs(other.x - before.x)).toBeLessThan(25);
  });
});

test.describe('Errors: plain English and a Try again button', () => {
  const cases: { name: string; file: { name: string; mimeType: string; buffer: Buffer }; kind: string; text: RegExp }[] = [
    { name: 'old .doc', file: { name: 'old.doc', mimeType: 'application/msword', buffer: legacyDoc() }, kind: 'legacy-doc', text: /Please save this as \.docx or PDF and upload again\./ },
    { name: 'password-protected PDF', file: { name: 'locked.pdf', mimeType: 'application/pdf', buffer: lockedPdf() }, kind: 'password', text: /locked with a password/ },
    { name: 'damaged PDF', file: { name: 'broken.pdf', mimeType: 'application/pdf', buffer: brokenPdf() }, kind: 'unreadable', text: /could not be read/ },
    { name: 'file too large', file: { name: 'huge.pdf', mimeType: 'application/pdf', buffer: hugePdf() }, kind: 'too-large', text: /21\.0 MB\. The limit is 20 MB\./ },
    { name: 'unsupported type', file: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }, kind: 'unsupported', text: /cannot be read/ },
  ];
  for (const c of cases) {
    test(c.name, async ({ page }) => {
      await page.goto('/');
      await page.getByTestId('quotation-file').setInputFiles(c.file);
      const error = page.getByTestId('upload-error');
      await expect(error).toBeVisible({ timeout: 30_000 });
      await expect(error).toHaveAttribute('data-kind', c.kind);
      await expect(error).toContainText(c.text);
      // Try again opens the file picker, ready for another file.
      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('try-again').click();
      await (await chooser).setFiles(sampleFile('quotation.docx'));
      await pickType(page, undefined, 60_000);
    });
  }
});

test.describe('Phone flow', () => {
  test('360 px Android: upload -> type -> pick template -> share in 6 taps or fewer', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Phone check');
    await page.setViewportSize({ width: 360, height: 740 });
    await stubShare(page);
    await page.goto('/');
    let taps = 0;
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('upload-button').click();
    taps++;
    await (await chooser).setFiles(sampleFile('quotation.docx'));
    taps++; // picking the file in the phone's file picker
    await page.locator('[data-testid="type-card"][data-suggested="true"]').click();
    taps++;
    await page.locator(`[data-testid="template-card"][data-template="${TEMPLATE_A}"]`).click();
    taps++;
    await expect(page.getByTestId('finish')).toBeEnabled({ timeout: 60_000 });
    await page.getByTestId('finish').click();
    taps++;
    await expect(page.getByTestId('share')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('share').click();
    taps++;
    await expect.poll(() => sharedFiles(page)).toHaveLength(1);
    const [shared] = await sharedFiles(page);
    expect(shared.type).toBe('application/pdf');
    expect(shared.name).toBe('Q-2026-27-045 - Quotation - Mass Service Tech.pdf');
    expect(taps).toBeLessThanOrEqual(6);
  });

  test('no sideways scrolling and every control is at least 44 px', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Phone check');
    await page.setViewportSize({ width: 360, height: 740 });
    const check = async (where: string) => {
      const res = await page.evaluate(() => {
        const overflow = document.documentElement.scrollWidth - window.innerWidth;
        const small: string[] = [];
        document.querySelectorAll<HTMLElement>('button, a[href], input:not([type="file"]), select, textarea, [contenteditable="true"], [role="switch"]').forEach((el) => {
          if (el.closest('[data-sonner-toaster]') || el.closest('[aria-hidden="true"]')) return;
          const target = el.getAttribute('role') === 'switch' ? (el.closest('label') ?? el) : el;
          const r = target.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') return;
          if (r.height < 43.5 || r.width < 43.5) small.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        });
        return { overflow, small };
      });
      expect(res.overflow, `${where}: page scrolls sideways`).toBeLessThanOrEqual(0);
      expect(res.small, `${where}: tap targets under 44 px`).toEqual([]);
    };
    await page.goto('/');
    await check('upload');
    await uploadQuotation(page, 'quotation-digital.pdf');
    await check('choose template');
    await chooseTemplate(page, TEMPLATE_A);
    await check('review: preview');
    await page.getByRole('radio', { name: /Edit/ }).click();
    await check('review: edit');
    await page.getByRole('radio', { name: /Preview/ }).click();
    await finish(page);
    await check('done');
    await page.goto('/settings');
    await check('settings');
  });
});

test.describe('Privacy and access', () => {
  test('nothing is sent to any other server', async ({ page }) => {
    const origin = new URL(test.info().project.use.baseURL ?? 'http://localhost:4391').origin;
    const foreign: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return;
      if (new URL(url).origin !== origin) foreign.push(url);
    });
    await uploadQuotation(page, 'quotation-scanned.pdf');
    await chooseTemplate(page, TEMPLATE_A);
    await finish(page);
    expect(foreign).toEqual([]);
  });

  test('an expired Cloudflare Access session shows "Please log in again"', async ({ page }) => {
    await page.route('**/session.json', (route) => route.fulfill({ status: 302, headers: { location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login/quotationpad.pages.dev' } }));
    await page.route('**/login?**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Cloudflare Access sign in</h1>' }));
    await page.goto('/');
    await expect(page.getByTestId('login-again')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Please log in again' })).toBeVisible();
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/login\?next=/);
    await expect(page.getByRole('heading', { name: 'Cloudflare Access sign in' })).toBeVisible();
  });
});

test.describe('Quotation read by an older version of the app', () => {
  test('is read again from the stored original when it is opened', async ({ page }) => {
    await uploadQuotation(page, 'quotation.docx');
    const id = new URL(page.url()).pathname.split('/').pop()!;
    // Make it look like the old reader produced it: one block of text, no version stamp.
    await page.evaluate(
      (key) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('quotation-pad');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const tx = open.result.transaction('conversions', 'readwrite');
            const store = tx.objectStore('conversions');
            const get = store.get(key);
            get.onsuccess = () => {
              const rec = get.result;
              rec.extracted_json = { blocks: [{ type: 'paragraph', runs: [{ text: 'OLD LINE BY LINE RESULT' }], align: 'left' }], confidence: {} };
              delete rec.extractor;
              store.put(rec);
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
        }),
      id,
    );
    await page.reload();
    await chooseTemplate(page, TEMPLATE_A);
    const text = await reviewText(page);
    expect(text).not.toContain('OLD LINE BY LINE RESULT');
    expect(text).toContain('Installation and testing charges');
  });
});
