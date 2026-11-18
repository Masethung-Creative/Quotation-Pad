# Samples

All quotation data here is fictional. Regenerate the quotations with `npm run samples` (it does not touch `templates/`).

| File | What it tests |
| --- | --- |
| `quotation.docx` | Word quotation: heading, Ref No / Date, address, bold/italic/underline, a **15-row** table, CGST + SGST totals, amount in words, numbered terms, one Tamil and one Hindi line, signature block |
| `quotation-digital.pdf` | 2-page digital PDF with the sender's own header, footer and "Page n of 2". Row 7 is **deliberately wrong** (4 x 2,275.00 printed as 9,200.00), so the sub total does not add up either. Both must show in amber and must not be changed |
| `quotation-scanned.pdf` | Image-only scan (no text layer), slightly skewed, with speckles |
| `quotation-photo.jpg` | Phone photo of a printed quotation: tilted, uneven light, background visible |
| `signature-photo.jpg` | Photo of a signature on off-white paper with a shadow, for the "photograph a signature" tool |
| `spec-example.json` | The canonical JSON example from the specification (upload it like any other file) |
| `templates/` | The owner's hand-over copy of the two company letterpads. The app uses the copies in `src/templates/` |
