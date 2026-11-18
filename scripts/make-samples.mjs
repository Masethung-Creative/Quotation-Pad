// Generates everything in /samples (all fictional data):
//   quotation.docx            - Word quotation with a 15-row table (+ one Tamil and one Hindi line)
//   quotation-digital.pdf     - 2-page digital PDF with its own header/footer and ONE wrong amount on purpose
//   quotation-scanned.pdf     - 1-page scan (image only, no text layer, slightly skewed)
//   quotation-photo.jpg       - phone photo of the same page (tilted, uneven light)
//   signature-photo.jpg       - phone photo of a signature on white paper (for the signature tools)
//   spec-example.json         - the canonical JSON example from the spec
// The template "original letterpads" are made by scripts/make-placeholder-templates.mjs.
// Run: npm run samples
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pdfmake from 'pdfmake';
import { PDFDocument } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as docx from 'docx';
import { pdfToPngs } from './pdf-to-png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'samples');
const font = (name) => join(root, 'public', 'fonts', name);
await mkdir(out, { recursive: true });

pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy?.(() => true);
pdfmake.setFonts({
  NotoSans: {
    normal: font('NotoSans-Regular.ttf'),
    bold: font('NotoSans-Bold.ttf'),
    italics: font('NotoSans-Italic.ttf'),
    bolditalics: font('NotoSans-BoldItalic.ttf'),
  },
});

const inr = (n) => {
  const [i, f] = n.toFixed(2).split('.');
  const last3 = i.slice(-3);
  const rest = i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest ? rest + ',' : ''}${last3}.${f}`;
};

const SELLER = 'SRI VELAN ELECTRICALS';
const SELLER_LINE = 'No. 14, Gandhi Road, Erode - 638001 | GSTIN 33ABCDE1234F1Z5 | Ph: 98765 43210';
const BUYER = ['To,', 'The Purchase Manager,', 'Kaveri Textile Mills Pvt Ltd,', 'SIDCO Industrial Estate,', 'Coimbatore - 641021'];
const TERMS = [
  'Validity: 30 days from the date of quotation.',
  'Payment: 50% advance, balance on delivery.',
  'Delivery: Within 10 working days from the order.',
  'Warranty: 12 months from the date of supply.',
];
const ITEMS = [
  ['LED Flood Light 100W', 10, 1850],
  ['MCB 32A Double Pole', 24, 420],
  ['Copper Cable 2.5 sq.mm (90 m coil)', 6, 3150],
  ['Distribution Board 8 Way', 4, 2275],
  ['Installation and testing charges', 1, 7500],
];
const sub = ITEMS.reduce((s, [, q, r]) => s + q * r, 0); // 64,080.00
const gst = sub * 0.09;
const grand = sub + 2 * gst; // 75,614.40
const WORDS = 'Rupees Seventy Five Thousand Six Hundred Fourteen and Paise Forty Only';

// The Word sample: 15 rows (acceptance check: "a Word quotation with a 15-row table").
const WORD_ITEMS = [
  ['LED Flood Light 100W', 10, 1850], ['LED Flood Light 50W', 12, 1120], ['MCB 32A Double Pole', 24, 420],
  ['MCB 16A Single Pole', 40, 185], ['Copper Cable 2.5 sq.mm (90 m coil)', 6, 3150], ['Copper Cable 1.5 sq.mm (90 m coil)', 8, 2040],
  ['Distribution Board 8 Way', 4, 2275], ['Modular Switch 6A', 150, 42], ['Modular Socket 16A', 60, 118],
  ['Ceiling Fan 1200 mm', 18, 1695], ['LED Tube Light 20W', 80, 265], ['PVC Conduit Pipe 25 mm (3 m)', 200, 68],
  ['Junction Box 4 Way', 120, 24], ['Earthing Electrode with chemical compound', 4, 2850], ['Installation and testing charges', 1, 7500],
];
const wSub = WORD_ITEMS.reduce((t, [, q, r]) => t + q * r, 0); // 1,94,210.00
const wGst = Math.round(wSub * 0.09 * 100) / 100; // 17,478.90
const wGrand = wSub + 2 * wGst; // 2,29,167.80
const W_WORDS = 'Rupees Two Lakh Twenty Nine Thousand One Hundred Sixty Seven and Paise Eighty Only';

// ------------------------------------------------------------------------------------
// 1. Word quotation
// ------------------------------------------------------------------------------------
{
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, TabStopType, LevelFormat } = docx;
  const p = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, bold: opts.bold, italics: opts.italics, underline: opts.underline ? {} : undefined })], alignment: opts.align, spacing: { after: opts.after ?? 60 } });
  const cell = (text, opts = {}) =>
    new TableCell({
      columnSpan: opts.span,
      children: [new Paragraph({ children: [new TextRun({ text, bold: opts.bold })], alignment: opts.align ?? AlignmentType.LEFT })],
    });
  const header = ['S.No', 'Description', 'Qty', 'Rate (Rs)', 'Amount (Rs)'];
  const rows = [
    new TableRow({ tableHeader: true, children: header.map((h) => cell(h, { bold: true, align: AlignmentType.CENTER })) }),
    ...WORD_ITEMS.map(
      ([d, q, r], i) =>
        new TableRow({
          children: [
            cell(String(i + 1), { align: AlignmentType.CENTER }),
            cell(d),
            cell(String(q), { align: AlignmentType.RIGHT }),
            cell(inr(r), { align: AlignmentType.RIGHT }),
            cell(inr(q * r), { align: AlignmentType.RIGHT }),
          ],
        }),
    ),
    ...[
      ['Sub Total', inr(wSub)],
      ['CGST 9%', inr(wGst)],
      ['SGST 9%', inr(wGst)],
      ['Grand Total', inr(wGrand)],
    ].map(([l, v]) => new TableRow({ children: [cell(l, { span: 4, align: AlignmentType.RIGHT, bold: l === 'Grand Total' }), cell(v, { align: AlignmentType.RIGHT, bold: l === 'Grand Total' })] })),
  ];
  const doc = new Document({
    creator: 'Quotation Pad samples',
    numbering: { config: [{ reference: 'terms', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 360 } } } }] }] },
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [
      {
        children: [
          new Paragraph({ text: 'QUOTATION', heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
          new Paragraph({
            tabStops: [{ type: TabStopType.RIGHT, position: 9026 }],
            children: [new TextRun('Ref No: Q/2026-27/045'), new TextRun({ text: '\tDate: 17-11-2026' })],
            spacing: { after: 160 },
          }),
          ...BUYER.map((l) => p(l, { after: 0 })),
          p('', { after: 60 }),
          new Paragraph({ children: [new TextRun({ text: 'Sub: ', bold: true }), new TextRun({ text: 'Quotation for supply of electrical items', underline: {} })], spacing: { after: 120 } }),
          p('Dear Sir,'),
          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            spacing: { after: 160 },
            children: [
              new TextRun('With reference to your enquiry, we are pleased to quote our '),
              new TextRun({ text: 'best prices', bold: true }),
              new TextRun(' for the following items. All items are '),
              new TextRun({ text: 'ISI marked', italics: true }),
              new TextRun(' and will be supplied from ready stock.'),
            ],
          }),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }),
          p('', { after: 60 }),
          p(`Amount in words: ${W_WORDS}`, { bold: true, after: 160 }),
          p('Terms and Conditions:', { bold: true }),
          ...TERMS.map((t) => new Paragraph({ text: t, numbering: { reference: 'terms', level: 0 } })),
          p('', { after: 60 }),
          p('நன்றி. உங்கள் ஆர்டரை எதிர்பார்க்கிறோம்.'),
          p('धन्यवाद। हमें आपके आदेश की प्रतीक्षा है।', { after: 240 }),
          p('For Sri Velan Electricals', { bold: true, align: AlignmentType.RIGHT, after: 600 }),
          p('Authorised Signatory', { align: AlignmentType.RIGHT }),
        ],
      },
    ],
  });
  await writeFile(join(out, 'quotation.docx'), await Packer.toBuffer(doc));
  console.log('samples/quotation.docx');
}

// ------------------------------------------------------------------------------------
// Shared pdfmake helpers
// ------------------------------------------------------------------------------------
const grid = {
  hLineWidth: () => 0.7,
  vLineWidth: () => 0.7,
  paddingLeft: () => 5,
  paddingRight: () => 5,
  paddingTop: () => 3,
  paddingBottom: () => 3,
};

const sellerHeader = () => ({
  margin: [40, 24, 40, 0],
  stack: [
    { text: SELLER, bold: true, fontSize: 15, alignment: 'center' },
    { text: SELLER_LINE, fontSize: 8, alignment: 'center', margin: [0, 2, 0, 4] },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1 }] },
  ],
});

// ------------------------------------------------------------------------------------
// 2. Digital PDF, two pages, own header/footer, one deliberate arithmetic mistake
// ------------------------------------------------------------------------------------
{
  const catalogue = [
    ['LED Flood Light 100W', 10, 1850], ['LED Flood Light 50W', 12, 1120], ['MCB 32A Double Pole', 24, 420],
    ['MCB 16A Single Pole', 40, 185], ['Copper Cable 2.5 sq.mm (90 m coil)', 6, 3150], ['Copper Cable 1.5 sq.mm (90 m coil)', 8, 2040],
    ['Distribution Board 8 Way', 4, 2275], ['Distribution Board 12 Way', 2, 3460], ['Modular Switch 6A', 150, 42],
    ['Modular Socket 16A', 60, 118], ['Ceiling Fan 1200 mm', 18, 1695], ['Exhaust Fan 300 mm', 6, 1480],
    ['LED Tube Light 20W', 80, 265], ['LED Panel Light 15W', 45, 540], ['PVC Conduit Pipe 25 mm (3 m)', 200, 68],
    ['Junction Box 4 Way', 120, 24], ['Earthing Electrode with chemical compound', 4, 2850], ['Changeover Switch 63A', 2, 3975],
    ['Energy Meter Three Phase', 1, 4650], ['Cable Tray 100 mm (2.5 m)', 30, 615], ['Industrial Plug and Socket 32A', 10, 890],
    ['Street Light Fitting 60W with arm', 8, 2380], ['Insulation Tape (box of 10)', 5, 210], ['Lugs and glands assorted kit', 3, 1250],
    ['Panel wiring and termination', 1, 9500], ['Installation, testing and commissioning', 1, 18500],
  ];
  let subtotal = 0;
  const body = [
    ['S.No', 'Description', 'Qty', 'Rate (Rs)', 'Amount (Rs)'].map((t) => ({ text: t, bold: true, alignment: 'center' })),
    ...catalogue.map(([d, q, r], i) => {
      subtotal += q * r;
      // Row 7 is wrong on purpose (9,100.00 printed as 9,200.00) so the checker has something to flag.
      const amount = i === 6 ? q * r + 100 : q * r;
      return [{ text: String(i + 1), alignment: 'center' }, d, { text: String(q), alignment: 'right' }, { text: inr(r), alignment: 'right' }, { text: inr(amount), alignment: 'right' }];
    }),
  ];
  const tax = subtotal * 0.09;
  const dd = {
    pageSize: 'A4',
    pageMargins: [40, 86, 40, 56],
    defaultStyle: { font: 'NotoSans', fontSize: 10 },
    header: sellerHeader,
    footer: (page, pages) => ({ margin: [40, 16, 40, 0], columns: [{ text: 'Sri Velan Electricals - Quotation', fontSize: 8 }, { text: `Page ${page} of ${pages}`, fontSize: 8, alignment: 'right' }] }),
    content: [
      { text: 'QUOTATION', bold: true, fontSize: 15, alignment: 'center', margin: [0, 0, 0, 10] },
      { columns: [{ text: 'Ref No: Q/2026-27/046' }, { text: 'Date: 17-11-2026', alignment: 'right' }], margin: [0, 0, 0, 10] },
      { text: BUYER.join('\n'), margin: [0, 0, 0, 10] },
      { text: [{ text: 'Sub: ', bold: true }, 'Quotation for electrical items for the new weaving shed'], margin: [0, 0, 0, 8] },
      { text: 'Dear Sir,', margin: [0, 0, 0, 4] },
      {
        text: 'With reference to your enquiry dated 10-11-2026, we are pleased to submit our lowest offer for the items listed below. We assure you of our best service and prompt delivery at all times.',
        alignment: 'justify',
        margin: [0, 0, 0, 10],
      },
      { table: { headerRows: 1, dontBreakRows: true, widths: [32, '*', 40, 70, 80], body }, layout: grid },
      {
        margin: [0, 6, 0, 0],
        unbreakable: true,
        stack: [
          ...[
            ['Sub Total', inr(subtotal)],
            ['CGST 9%', inr(tax)],
            ['SGST 9%', inr(tax)],
            ['Grand Total', inr(subtotal + 2 * tax)],
          ].map(([l, v]) => ({ columns: [{ text: l, alignment: 'right', bold: l === 'Grand Total', width: '*' }, { text: v, alignment: 'right', bold: l === 'Grand Total', width: 90 }], columnGap: 30, margin: [0, 2, 5, 2] })),
          { text: 'Terms and Conditions:', bold: true, margin: [0, 12, 0, 4] },
          { ol: TERMS },
          { text: 'For Sri Velan Electricals', bold: true, alignment: 'right', margin: [0, 24, 0, 36] },
          { text: 'Authorised Signatory', alignment: 'right' },
        ],
      },
    ],
  };
  await writeFile(join(out, 'quotation-digital.pdf'), await pdfmake.createPdf(dd).getBuffer());
  console.log('samples/quotation-digital.pdf');
}

// ------------------------------------------------------------------------------------
// 3 + 4. One clean page -> "scanned" PDF and "phone photo"
// ------------------------------------------------------------------------------------
{
  const dd = {
    pageSize: 'A4',
    pageMargins: [48, 50, 48, 50],
    defaultStyle: { font: 'NotoSans', fontSize: 11 },
    content: [
      { text: SELLER, bold: true, fontSize: 17, alignment: 'center' },
      { text: SELLER_LINE, fontSize: 9, alignment: 'center', margin: [0, 2, 0, 14] },
      { text: 'QUOTATION', bold: true, fontSize: 16, alignment: 'center', margin: [0, 0, 0, 12] },
      { columns: [{ text: 'Ref No: Q/2026-27/045' }, { text: 'Date: 17-11-2026', alignment: 'right' }], margin: [0, 0, 0, 12] },
      { text: BUYER.join('\n'), margin: [0, 0, 0, 12] },
      { text: 'Sub: Quotation for supply of electrical items', margin: [0, 0, 0, 10] },
      { text: 'Dear Sir,', margin: [0, 0, 0, 4] },
      { text: 'With reference to your enquiry, we are pleased to quote our best prices for the following items.', margin: [0, 0, 0, 12] },
      {
        table: {
          headerRows: 1,
          widths: [36, '*', 44, 78, 88],
          body: [
            ['S.No', 'Description', 'Qty', 'Rate (Rs)', 'Amount (Rs)'].map((t) => ({ text: t, bold: true, alignment: 'center' })),
            ...ITEMS.map(([d, q, r], i) => [{ text: String(i + 1), alignment: 'center' }, d, { text: String(q), alignment: 'right' }, { text: inr(r), alignment: 'right' }, { text: inr(q * r), alignment: 'right' }]),
          ],
        },
        layout: { ...grid, paddingTop: () => 5, paddingBottom: () => 5 },
      },
      ...[
        ['Sub Total', inr(sub)],
        ['CGST 9%', inr(gst)],
        ['SGST 9%', inr(gst)],
        ['Grand Total', inr(grand)],
      ].map(([l, v], i) => ({ columns: [{ text: l, alignment: 'right', bold: l === 'Grand Total', width: '*' }, { text: v, alignment: 'right', bold: l === 'Grand Total', width: 96 }], columnGap: 30, margin: [0, i === 0 ? 8 : 3, 5, 3] })),
      { text: WORDS, margin: [0, 10, 0, 14] },
      { text: 'Terms and Conditions:', bold: true, margin: [0, 0, 0, 4] },
      { ol: TERMS },
      { text: 'For Sri Velan Electricals', bold: true, alignment: 'right', margin: [0, 30, 0, 44] },
      { text: 'Authorised Signatory', alignment: 'right' },
    ],
  };
  const clean = await pdfmake.createPdf(dd).getBuffer();
  const [{ png }] = await pdfToPngs(clean, 200);
  const page = await loadImage(png);

  // Deterministic noise so the samples do not change on every run.
  let seed = 20261117;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  // Scan: slight skew, grey paper tone, speckles.
  {
    const c = createCanvas(page.width, page.height);
    const g = c.getContext('2d');
    g.fillStyle = '#f4f2ee';
    g.fillRect(0, 0, c.width, c.height);
    g.translate(c.width / 2, c.height / 2);
    g.rotate((1.4 * Math.PI) / 180);
    g.globalCompositeOperation = 'multiply';
    g.drawImage(page, -page.width / 2, -page.height / 2);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 1400; i++) {
      g.fillStyle = `rgba(60,60,60,${0.08 + rand() * 0.25})`;
      g.fillRect(rand() * c.width, rand() * c.height, 1 + rand() * 1.5, 1 + rand() * 1.5);
    }
    const jpg = c.toBuffer('image/jpeg', 82);
    const pdf = await PDFDocument.create();
    const img = await pdf.embedJpg(jpg);
    pdf.addPage([595.28, 841.89]).drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
    pdf.setProducer('Sample scanner');
    await writeFile(join(out, 'quotation-scanned.pdf'), await pdf.save());
    console.log('samples/quotation-scanned.pdf');
  }

  // Phone photo: page lying on a desk, tilted the other way, shadow across one corner.
  {
    const W = 1500;
    const H = 2000;
    const c = createCanvas(W, H);
    const g = c.getContext('2d');
    g.fillStyle = '#5b4a3c';
    g.fillRect(0, 0, W, H);
    const pw = 1340;
    const ph = Math.round((pw * page.height) / page.width);
    g.translate(W / 2, H / 2);
    g.rotate((-2.2 * Math.PI) / 180);
    g.fillStyle = '#fbfaf6';
    g.fillRect(-pw / 2, -ph / 2, pw, ph);
    g.globalCompositeOperation = 'multiply';
    g.drawImage(page, -pw / 2, -ph / 2, pw, ph);
    g.setTransform(1, 0, 0, 1, 0, 0);
    const shade = g.createLinearGradient(0, 0, W, H);
    shade.addColorStop(0, 'rgba(255,255,255,1)');
    shade.addColorStop(0.55, 'rgba(225,222,215,1)');
    shade.addColorStop(1, 'rgba(150,146,140,1)');
    g.fillStyle = shade;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
    await writeFile(join(out, 'quotation-photo.jpg'), c.toBuffer('image/jpeg', 80));
    console.log('samples/quotation-photo.jpg');
  }
}

// ------------------------------------------------------------------------------------
// 5. Photo of a signature on white paper (uneven light, a little paper texture)
// ------------------------------------------------------------------------------------
{
  const W = 1200;
  const H = 700;
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  const paper = g.createLinearGradient(0, 0, W, H);
  paper.addColorStop(0, '#f7f5f0');
  paper.addColorStop(1, '#c9c4ba');
  g.fillStyle = paper;
  g.fillRect(0, 0, W, H);
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = `rgba(120,110,100,${0.03 + rand() * 0.06})`;
    g.fillRect(rand() * W, rand() * H, 1.5, 1.5);
  }
  g.strokeStyle = '#1f2a5a';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(170, 430);
  g.bezierCurveTo(200, 220, 290, 200, 300, 330);
  g.bezierCurveTo(310, 460, 230, 470, 260, 380);
  g.bezierCurveTo(300, 270, 400, 300, 420, 400);
  g.bezierCurveTo(440, 480, 500, 300, 560, 360);
  g.bezierCurveTo(610, 410, 640, 300, 700, 330);
  g.bezierCurveTo(760, 360, 780, 420, 850, 350);
  g.bezierCurveTo(900, 300, 960, 330, 1010, 360);
  g.stroke();
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(220, 500);
  g.bezierCurveTo(450, 470, 750, 520, 1000, 470);
  g.stroke();
  g.beginPath();
  g.arc(640, 250, 6, 0, Math.PI * 2);
  g.fillStyle = '#1f2a5a';
  g.fill();
  await writeFile(join(out, 'signature-photo.jpg'), c.toBuffer('image/jpeg', 85));
  console.log('samples/signature-photo.jpg');
}

// ------------------------------------------------------------------------------------
// 6. Canonical JSON example (from the specification)
// ------------------------------------------------------------------------------------
{
  const spec = {
    blocks: [
      { type: 'heading', text: 'QUOTATION', level: 1, align: 'center' },
      { type: 'meta', items: [{ label: 'Ref No', value: 'Q/2026-27/045' }, { label: 'Date', value: '17-11-2026' }] },
      { type: 'paragraph', runs: [{ text: 'To,', bold: false, italic: false, underline: false }], align: 'left' },
      {
        type: 'table',
        columns: ['S.No', 'Description', 'Qty', 'Rate (Rs)', 'Amount (Rs)'],
        col_align: ['center', 'left', 'right', 'right', 'right'],
        rows: [['1', 'Item description', '2', '1,500.00', '3,000.00']],
      },
      {
        type: 'totals',
        items: [
          { label: 'Sub Total', value: '3,000.00' },
          { label: 'CGST 9%', value: '270.00' },
          { label: 'SGST 9%', value: '270.00' },
          { label: 'Grand Total', value: '3,540.00', bold: true },
        ],
        amount_in_words: 'Rupees Three Thousand Five Hundred Forty Only',
      },
      { type: 'list', ordered: true, items: ['Validity: 30 days', 'Payment: 50% advance'] },
      { type: 'signature', lines: ['For <Company Name>', '', 'Authorised Signatory'] },
      { type: 'spacer', mm: 5 },
    ],
    confidence: {},
  };
  await writeFile(join(out, 'spec-example.json'), JSON.stringify(spec, null, 2));
  console.log('samples/spec-example.json');
}
