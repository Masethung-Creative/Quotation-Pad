# Company templates

One folder per company. Adding a company = add a folder here and redeploy.

```
src/templates/<company-id>/
  template.json     company details, safe area, signature block
  letterpad.pdf     the original letterpad, untouched: placed behind every page (exact A4)
  letterpad.docx    Word letterpad for Word output (Phase 2); body holds one paragraph {@body}
  thumbnail.png     picture for the template card while the real preview is drawn
```

`schema.ts`, `index.ts`, `marker.ts` and `suggest.ts` in this folder are the app's code, not companies.

## template.json

```json
{
  "id": "mass-service-tech",               // must equal the folder name
  "name": "Mass Service Tech",             // shown on the card; also starts the PDF file name
  "docxBodyMarker": "{@body}",
  "files": { "pdf": "letterpad.pdf", "docx": "letterpad.docx", "thumbnail": "thumbnail.png" },
  "safeArea_mm": { "top": 49, "bottom": 17, "left": 20, "right": 20 },
  "company": { "legalName": "MASS SERVICE TECH", "address": "...", "phones": ["..."], "email": "..." },
  "signature": { "forLine": "For MASS SERVICE TECH", "name": "", "designation": "Authorised Signatory" }
}
```

Optional: `"files": { "continuationPdf": "letterpad-page2.pdf" }` plus `"continuationSafeArea_mm"` for a slimmer letterpad on page 2+. Without them, page 2+ uses the same letterpad and safe area.

| Company | Top | Bottom | Left | Right |
|---|---|---|---|---|
| Mass Service Tech | 49 | 17 | 20 | 20 |
| RM Smart Service Tech | 48 | 21 | 20 | 20 |

Safe areas were measured from the PDFs: the lowest printed pixel of the header and the highest of the footer, plus 5 mm. `npm run templates:check` confirms that no letterhead ink falls inside them, and that quotation text never falls outside them.

## The `{@body}` marker in letterpad.pdf

`Mass Service Tech/letterpad.pdf` was saved from Word with the `{@body}` marker visible in the body area. The app finds that text in the PDF and covers it with paper white before the quotation is drawn, so it never shows. The cleanest fix is to export the PDF without the marker:

1. In Word, open `letterpad.docx`, delete `{@body}`, then **File > Save as PDF** to replace `letterpad.pdf`.
2. Close **without saving** the .docx (the marker must stay in the Word file for Phase 2).

## Fill in

`signature.name` is empty in both `template.json` files. Add the signatory's name (and change the designation if needed): it prints under the signature.

## If a letterhead changes

1. Edit the `.docx` header/footer in Word, then **File > Save as PDF** to replace `letterpad.pdf`.
2. If the header or footer got taller or shorter, update `safeArea_mm` (and Layout > Margins in the .docx).
3. Run `npm test`: the template checks fail if letterhead ink falls inside the safe area.

## Fonts

The Mass Service Tech header uses **Arial Black**. PDF output is unaffected because it uses the original PDF.

## Drawing a letterhead in code instead (advanced)

A template can also draw its header/footer from elements (text, rect, line, ellipse, polygon, image) instead of using a PDF. That format, and the 1 mm side-by-side check, are described in the main README; working examples are in `tests/fixtures/templates/`.
