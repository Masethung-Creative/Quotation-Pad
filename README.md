# Quotation Pad

**Any quotation, on your letterpad.**

Upload a plain quotation (Word, PDF, scan or phone photo), pick one of your company templates, check it, optionally sign it, and download or share the PDF on your letterhead. It runs entirely in the browser: no server, no paid API, no database service. Files never leave the device.

```
Upload  ->  Reading...  ->  Invoice or quotation  ->  Choose template  ->  Review & sign  ->  Done (Download / Share)
```

Phase 1 (this repository) is the MVP: built-in company templates, Word/PDF/scan/photo reading, totals checking, signatures, offline use, Cloudflare Access. Phases 2 and 3 (Word output, seals, history, backup, template builder, etc.) are not built yet.

---

## How to use this repository (step by step)

### Step 1: install the tools (once per computer)

| Tool | Where | Check it works |
| --- | --- | --- |
| **Node.js 22 or newer** (LTS) | https://nodejs.org (Windows installer, keep the defaults) | `node -v` shows `v22...` or higher |
| **Git** | https://git-scm.com/download/win (keep the defaults) | `git --version` |
| **VS Code** (optional, recommended) | https://code.visualstudio.com | |

Open a terminal (in VS Code: **Terminal > New Terminal**) for the commands below.

### Step 2: get the code

```bash
git clone https://github.com/Masethung-Creative/Quotation-Pad.git
cd Quotation-Pad
npm install
```

`npm install` downloads the libraries (a few minutes the first time) and copies the text reader (OCR), its Tamil/Hindi/English language files and the PDF reader into `public/`. Those copies are not stored in Git; `npm install` recreates them.

### Step 3: run the app on your computer

```bash
npm run dev
```

Open **http://localhost:5173** in Chrome. Changes you save in `src/` show up immediately. Stop it with `Ctrl + C`.

To try the real production version (as it will run online, with offline support):

```bash
npm run build
npm run preview      # http://localhost:4391
```

### Step 4: use the app

1. **Upload**: tap **Choose a file** (or **Take a photo** on a phone) and pick a quotation: Word `.docx`, PDF, scanned PDF, or a photo (JPG, PNG, HEIC). Old `.doc` files: save them as `.docx` first.
2. **Reading**: the app reads it on your device. Nothing is uploaded anywhere.
3. **Invoice or quotation**: tap what the document is. The app pre-selects its guess (from words like "Invoice" near the top); just confirm it or tap the other one. It only changes the printed title: **QUOTATION** or **TAX INVOICE**. The letterheads are the same for both. Changed your mind later? Review & sign > menu (three dots) > **Change to ...**.
4. **Choose template**: tap the company the quotation should go out under (Mass Service Tech or RM Smart Service Tech). Each card shows your quotation on that letterhead.
5. **Review & sign**: check the text, tables and totals. Amber marks show what needs a look (a wrong total, amount in words that does not match, a word the scanner was unsure of). The app never changes your numbers by itself. Optionally switch on **Add signature** (draw it, or photograph it on white paper).
6. **Done**: **Download PDF** or **Share** (WhatsApp, Gmail ...). File name: `<Bill No> - <Invoice or Quotation> - <Letterpad name>.pdf`, for example `334 - Invoice - Mass Service Tech.pdf` (no bill number found: the customer, else the date).

Try it with the files in `samples/`.

### Step 5: save your changes to GitHub

```bash
npm test                     # make sure nothing broke
git add -A
git commit -m "Describe what you changed"
git push
```

If the site is connected to Cloudflare Pages (below), every `git push` publishes the new version automatically within about a minute. Phones that have the app installed switch to the new version the next time it is opened.

### Step 6: add or change a company letterhead

Copy `src/templates/mass-service-tech/` to `src/templates/<new-company-id>/`, replace `letterpad.pdf` / `letterpad.docx` / `thumbnail.png`, and edit `template.json` (name, address, phones, e-mail, signatory name, safe area in mm). Then run `npm test` and `npm run templates:check`, and push. Details: [`src/templates/README.md`](src/templates/README.md).

### What is (and is not) in Git

- Not in Git: `node_modules/`, `dist/` (build output), test reports, the OCR/PDF engine copies in `public/` (all recreated by `npm install` / `npm run build`).
- Never commit real customer documents. `samples/sample Result/` is ignored for that reason; keep test files with real client names, GST or PAN numbers there or outside the project.

---

## All commands

| Command | What it does |
| --- | --- |
| `npm run build` | Production build into `dist/` (type-check, build, then checks the Cloudflare free-plan file limits) |
| `npm run preview` | Serves `dist/` at http://localhost:4391 with the production security headers |
| `npm test` | Unit tests (Vitest): extractors, totals checker, rendering, templates, signatures, storage |
| `npm run templates:check` | Side-by-side check of every company template against its original letterpad (1 mm) |
| `npx playwright install chromium` | One-time browser download for the end-to-end tests |
| `npm run test:e2e` | End-to-end tests on Pixel 7, iPhone 14 and a 1440 px desktop, golden pages, offline and speed checks |
| `npm run test:golden:update` | Re-approve the golden PNGs after an intended visual change |
| `npm run lighthouse` | Lighthouse mobile scores (performance and accessibility) for every screen |
| `npm run licenses` | Fails if any shipped package is not MIT / Apache / BSD / ISC |
| `npm run samples` | Regenerates `samples/` (all fictional data) |

---

## Deploy: GitHub + Cloudflare Pages + Cloudflare Access (Rs 0)

### 1. GitHub

The code lives at **https://github.com/Masethung-Creative/Quotation-Pad** (branch `main`). The repository is public at the moment; to make it private: GitHub > the repository > **Settings** > **General** > **Danger Zone** > **Change visibility** > **Private**. Cloudflare Pages works the same with a private repository.

Setting up a fresh copy elsewhere:

```bash
git init && git add -A && git commit -m "Quotation Pad"
git branch -M main
git remote add origin https://github.com/<account>/<repository>.git
git push -u origin main
```

### 2. Cloudflare Pages (free plan)

1. Cloudflare dashboard > **Workers & Pages** > **Create** > **Pages** > **Connect to Git** > choose `Quotation-Pad`.
2. Project name: **`quotationpad`** (gives **https://quotationpad.pages.dev**; if the name is taken, use `quotation-pad` -> quotation-pad.pages.dev).
3. Framework preset: *None*. Build command: **`npm run build`**. Build output directory: **`dist`**.
4. Node version comes from `.node-version` (22). Nothing else to set: no environment variables, no secrets, no functions.
5. **Save and Deploy.** Every push to `main` redeploys. (Without Git: `npm run build && npx wrangler pages deploy dist --project-name quotationpad`.)

`public/_headers` sets the security headers (strict Content-Security-Policy, `connect-src 'self'`, so the page cannot send data anywhere else) and caching. There is no `404.html`, so Pages serves the app for every address (deep links work).

Free-plan limits: 20,000 files and 25 MiB per file per deployment. `npm run build` checks both; this app is ~270 files, the largest under 5 MB.

### 3. Cloudflare Access: only approved people can open the site

Cloudflare Zero Trust **Free** covers up to 50 users. Sign-up asks for payment details even for the Free plan, but nothing is charged while you stay on Free (up to 50 users).

1. Dashboard > **Zero Trust**. Pick a team name and the **Free** plan.
2. **Workers & Pages** > `quotationpad` > **Settings** > **Enable access policy** (this first protects preview deployments).
3. Select **Manage** on the policy it created. Under **Access > Applications**, open the application, select **Configure**, and in **Public hostname** > **Subdomain** delete the `*` and **Save**. Now the main address `quotationpad.pages.dev` is protected too (Cloudflare's documented way to protect a `*.pages.dev` domain).
4. In that application:
   - **Login methods:** One-time PIN (email code).
   - **Policy:** Action **Allow**, Include **Emails**: the approved addresses (one per line). Nothing else.
   - **Session duration:** **1 month** (the longest Access allows), so people log in about once every 30 days.
5. Zero Trust > **Settings** > **Authentication** > **Global session timeout**: also **1 month**.
6. Check it: open the site in a private window. You should see Cloudflare's login page. An email not on the list gets "That account does not have access". An approved one gets a code by email and lands in the app.

There is no login code inside the app. The app only notices an expired session: it fetches `/session.json`, a tiny file that Access lets through only with a valid session. Without a valid session it shows **"Please log in again"**. The Log in button opens `/login`, which the service worker never answers, so Cloudflare's login page always comes from the network. The service worker never stores HTML or redirected responses, so the Access login page can never end up in its cache. The manifest is fetched with credentials (`crossorigin="use-credentials"`) so the app stays installable behind Access.

To add or remove a person: edit the email list in the Access policy. No redeploy needed.

### Vercel instead?

**Live now on Vercel: https://quotation-pad.vercel.app** (project `quotation-pad`, connected to this GitHub repository: every push to `main` deploys automatically). `.vercelignore` keeps client documents and build leftovers out of the upload. Manual deploy from this folder: `npx vercel deploy --prod`.

The app is plain static files, so it also runs on Vercel. `vercel.json` sets the same security headers and routing as `public/_headers` (a unit test keeps the two identical). In Vercel: **Add New > Project** > import the GitHub repo. It reads `vercel.json` (build `npm run build`, output `dist`), with nothing else to configure.

Before choosing Vercel, two points against the brief:

1. **Cost.** Vercel's free *Hobby* plan is for personal, non-commercial use only. A business tool needs the paid *Pro* plan (per user per month), so the running cost is no longer Rs 0.
2. **Login by email allow-list.** Vercel's free protection only lets in people with access to your Vercel account/team, not an email list with one-time codes. Password Protection is a paid add-on. Cloudflare Access can sit in front of Vercel only through your own domain on Cloudflare (a domain is a yearly cost).

So Cloudflare Pages + Access is the setup that meets "Rs 0" and "email allow-list". Vercel works if a paid plan is acceptable.

---

## Company templates

Users never upload a letterpad: each company is built into the app as a folder. The two real companies are **Mass Service Tech** and **RM Smart Service Tech**.

```
src/templates/<company-id>/
  template.json     company details, safe area, signature block
  letterpad.pdf     the original letterpad, untouched: placed behind every page (exact A4, stays vector)
  letterpad.docx    Word letterpad for Word output (Phase 2)
  thumbnail.png     picture for the template card while the real preview is drawn
```

**Adding a company = add a folder + push.** `src/templates/README.md` explains the `template.json` fields, the safe areas and what to do when a letterhead changes. `npm test` validates every folder.

**Checks (`npm run templates:check`)** for every company, on page 1 and page 2:

- **Matches the original letterpad within 1 mm.** The template and the original are both rendered at 150 dpi. Every ink pixel of each is matched to the nearest ink pixel of the other, and the check fails unless 99.9% of them are within 1 mm. Today both companies are within 0.17 mm (anti-aliasing only). Side-by-side images (original | app | overlay: red = only in the original, blue = only in the app) are written to `reports/templates/`.
- **No letterhead ink inside the safe area**, so quotation text can never print over the header or footer.
- **No quotation text outside the safe area** (3-page test document).

**The `{@body}` marker.** Mass Service Tech's `letterpad.pdf` was exported from Word with the `{@body}` marker visible. The app finds it in the PDF and covers it with paper white before drawing the quotation. Re-exporting the PDF without the marker is cleaner; the steps are in `src/templates/README.md`.

**Drawing a letterhead in code (optional).** A template can instead draw its header/footer from elements (text, rect, line, ellipse, polygon, image; mm from the top-left, text `y` = baseline), with an optional slimmer design for page 2+. Two fictional examples are in `tests/fixtures/templates/` (`npm run templates:placeholders`): both match their originals within 1 mm. Use this when a company has no clean PDF of its letterpad.

---

## How it works

Everything runs in the browser; heavy work runs in web workers so the screen never freezes.

| Step | Code |
| --- | --- |
| Ingest: type by magic bytes, 20 MB limit, HEIC -> JPEG, `.doc` message | `src/ingest/` |
| Word: mammoth.js (worker) -> HTML -> blocks | `src/extract/docx.ts`, `src/workers/` |
| Digital PDF: pdf.js text items with positions -> lines -> paragraphs, tables, lists, totals | `src/extract/pdf.ts`, `src/extract/reconstruct.ts` |
| Boxed layouts (Excel / Tally / PDF-to-Word exports): the lines drawn in the PDF become cells, so side-by-side boxes stay side by side and boxed tables stay tables; Word layout tables with merged cells and tables typed with tabs are rebuilt the same way | `src/extract/rules.ts`, `src/extract/reconstruct.ts`, `src/extract/docx.ts` |
| Quotations read by an older version are read again when opened (if never edited) | `refreshIfOutdated` in `src/pipeline/convert.ts` |
| Scans / photos: canvas at 300 dpi -> grayscale, lighting, contrast, deskew, rule removal (worker) -> Tesseract.js (eng, tam, hin; lazy) | `src/extract/image.ts`, `src/extract/ocr.ts` |
| Sender's own header/footer and page numbers removed; table split across pages re-joined | `src/extract/headerFooter.ts`, `src/extract/refine.ts` |
| Canonical JSON (the one format every input becomes) | `src/schema/canonical.ts` |
| Checks: qty x rate, sub total, GST, grand total, amount in words (flags only, never changes a number); no content lost (>2% missing warns) | `src/validate/` |
| Render: pdfmake lays out the pages inside the template's safe areas, draws the header/footer as vector layers (continuation design from page 2), repeats table headers, never splits rows, keeps totals + signature together | `src/render/docdef.ts`, `src/render/core.ts` (worker) |
| Signature: transparent PNG drawn with pdf-lib at the template's signature box (+ the user's offset) | `src/render/signature.ts`, `src/signature/` |
| Storage: IndexedDB via Dexie (quotations, signatures, settings); originals auto-deleted after 90 days (configurable) | `src/db/db.ts` |
| Offline: service worker precaches the app, fonts and templates; the OCR engine and languages download in the background after the first visit | `vite.config.ts`, `src/extract/ocrWarm.ts` |

**Tamil and Hindi.** pdfmake (via fontkit) shapes Tamil and Devanagari correctly with the embedded Noto fonts (conjuncts such as க்க, ஸ்ரீ, क्ष, ज्ञ, श्री checked in week 1). The canvas-image fallback was therefore not needed. The golden test `word-greenleaf` keeps both lines under watch.

**Indian formats.** Amounts are kept exactly as written (Indian grouping 1,25,000.00 is preserved, never re-typed). Amount in words uses lakh/crore. CGST/SGST/IGST are understood by the checker. File names use DD-MM-YYYY.

**Security headers.** CSP allows `'wasm-unsafe-eval'` (OCR engine) and `'unsafe-eval'`. The latter is only because heic2any (iPhone HEIC photos on Android/Chrome) builds functions at start-up; remove it from `public/_headers` if HEIC support on Android is not needed. `connect-src 'self'` stops the page from talking to any other server.

## Tests

- **Unit (Vitest, `tests/unit`)**: extractors (Word, digital PDF, OCR reconstruction, header/footer removal), totals checker, content-loss check, formats, image clean-up and deskew, rendering on templates (fonts, safe areas, continuation design, fallback background), template 1 mm match and safe-area checks, signature extraction and placement, storage and migration, file names, error messages.
- **End-to-end (Playwright, `tests/e2e`)**: Pixel 7, iPhone 14, 1440 px desktop. Covers Word / digital PDF / scan / photo flows, the amber "items need a check" jump, signatures (drawn, photographed, toggle off, position per template), every error with Try again, 5 taps on a 360 px phone, 44 px tap targets, no sideways scroll, no request to any other server, and the "Please log in again" screen. iPhone 14 runs in real WebKit on CI or with `PW_WEBKIT=1`. Playwright's WebKit build does not start on some Windows machines, where Chromium with the iPhone 14 screen is used instead.
- **Golden pages (`golden.spec.ts`)**: finished pages compared with approved PNGs (1% tolerance), one folder per OS in `tests/e2e/golden/`. On a new OS or CI: `npx playwright test golden --update-snapshots=missing` once.
- **Offline (`offline.spec.ts`)**: after the first visit, network off, a Word file and a photo still go upload -> template -> share.
- **Speed (`perf.spec.ts`, Pixel 7 with 4x slower CPU)**:

  | Check | Budget | Measured |
  | --- | --- | --- |
  | First screen visible, slow 4G (1.6 Mbit/s, 150 ms) | 2 s | 0.7-0.8 s |
  | Upload button ready to tap, typical 4G (9 Mbit/s, 100 ms) | 2 s | about 1.5 s |
  | 15-row Word quotation -> finished PDF | 10 s | 5.8-7.7 s |
  | Clean scanned A4 page read | 30 s | 5.8-7.0 s |

  The first screen is fast because `index.html` carries a static copy of the upload screen, painted before any JavaScript arrives (React then takes over the identical screen). Its one-line script is allowed by hash in the CSP; `tests/unit/hosting.test.ts` keeps the hash in step.
- **Lighthouse (`npm run lighthouse`, mobile)**: every screen, median of 3 runs (scores vary from run to run on a busy machine). Last run: performance 100 / 88 / 95 / 94 / 90 (Upload / Choose template / Review & sign / Done / Settings), accessibility 100 on all. Reports in `reports/lighthouse/`.

## Licences

Everything shipped is MIT, Apache-2.0, BSD or ISC (`npm run licenses`). Fonts: Noto Sans and Liberation Sans, SIL Open Font License (free to embed). Dev-only tools such as Lighthouse are not shipped.

## Samples

`samples/` holds one Word quotation (15-row table, Tamil + Hindi lines), one 2-page digital PDF (with its own header/footer and one deliberately wrong amount), one scanned PDF, one phone photo, a photo of a signature, and the canonical JSON example. All data is fictional.
