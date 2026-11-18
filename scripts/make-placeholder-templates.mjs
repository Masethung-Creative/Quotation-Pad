// Generates the "original letterpads" and logos of two fictional test companies
// (fictional: Kaveri Trading Company, Greenleaf Agro Products). They play the role of the
// real letterpads the owner will provide, so the template rebuild and the 1 mm side-by-side
// check can be exercised end to end. Run: node scripts/make-placeholder-templates.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import * as fontkit from 'fontkit';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Test fixtures for the code-drawn template path (the real companies live in src/templates).
const tpl = (...p) => join(root, 'tests', 'fixtures', 'templates', ...p);
const font = (name) => join(root, 'public', 'fonts', name);

// ------------------------------------------------------------------------------------
// Kaveri Trading Company: vector letterpad made in a "word processor" (pdf-lib, Helvetica)
// ------------------------------------------------------------------------------------
{
  await mkdir(tpl('kaveri-trading'), { recursive: true });
  const A4 = [595.28, 841.89];
  const H = A4[1];
  const pdf = await PDFDocument.create();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const blue = rgb(0.11, 0.23, 0.42);
  const gold = rgb(0.85, 0.62, 0.15);

  const p1 = pdf.addPage(A4);
  p1.drawRectangle({ x: 0, y: H - 92, width: A4[0], height: 92, color: blue });
  p1.drawRectangle({ x: 0, y: H - 97, width: A4[0], height: 5, color: gold });
  p1.drawCircle({ x: 62, y: H - 46, size: 26, color: gold });
  p1.drawText('K', { x: 51, y: H - 58, size: 34, font: bold, color: blue });
  p1.drawText('KAVERI TRADING COMPANY', { x: 104, y: H - 44, size: 21, font: bold, color: rgb(1, 1, 1) });
  p1.drawText('Electrical & Industrial Supplies  |  GSTIN 33AAAAA0000A1Z5', { x: 104, y: H - 64, size: 9.5, font: regular, color: rgb(0.86, 0.9, 0.96) });
  p1.drawRectangle({ x: 0, y: 0, width: A4[0], height: 44, color: blue });
  p1.drawRectangle({ x: 0, y: 44, width: A4[0], height: 3, color: gold });
  p1.drawText('27, Brough Road, Erode - 638001, Tamil Nadu   |   +91 98765 00000   |   sales@kaveritrading.example', { x: 48, y: 17, size: 8.5, font: regular, color: rgb(1, 1, 1) });
  p1.drawRectangle({ x: 0, y: 47, width: 9, height: H - 144, color: rgb(0.9, 0.93, 0.97) });

  // Continuation sheet for page 2+.
  const p2 = pdf.addPage(A4);
  p2.drawRectangle({ x: 0, y: H - 34, width: A4[0], height: 34, color: blue });
  p2.drawText('KAVERI TRADING COMPANY', { x: 40, y: H - 23, size: 11, font: bold, color: rgb(1, 1, 1) });
  p2.drawRectangle({ x: 0, y: 0, width: A4[0], height: 16, color: blue });
  pdf.setProducer('Word processor (sample)');
  await writeFile(tpl('kaveri-trading', 'original_letterpad.pdf'), await pdf.save());

  // logo.svg: the gold disc with the "K" traced as an outline (no font needed).
  const lib = fontkit.openSync(font('LiberationSans-Bold.ttf'));
  const glyph = lib.layout('K').glyphs[0];
  const s = 34 / lib.unitsPerEm;
  const k = glyph.path.transform(s, 0, 0, -s, 51, 58).toSVG();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="36 20 52 52" width="52" height="52"><circle cx="62" cy="46" r="26" fill="#d99e26"/><path d="${k}" fill="#1c3b6b"/></svg>\n`;
  await writeFile(tpl('kaveri-trading', 'logo.svg'), svg);
  console.log('tests/fixtures/templates/kaveri-trading: original_letterpad.pdf, logo.svg');
}

// ------------------------------------------------------------------------------------
// Greenleaf Agro Products: a scanned / image letterpad (PNG, A4 at 150 dpi)
// ------------------------------------------------------------------------------------
{
  await mkdir(tpl('greenleaf-agro'), { recursive: true });
  GlobalFonts.registerFromPath(font('LiberationSans-Regular.ttf'), 'Liberation Sans');
  GlobalFonts.registerFromPath(font('LiberationSans-Bold.ttf'), 'Liberation Sans');
  const W = 1240;
  const H = 1754;
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#14532d';
  g.fillRect(0, 0, W, 26);
  g.beginPath();
  g.moveTo(70, 80);
  g.lineTo(150, 80);
  g.lineTo(110, 190);
  g.closePath();
  g.fill();
  g.fillStyle = '#65a30d';
  g.beginPath();
  g.arc(110, 92, 34, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#14532d';
  g.font = 'bold 54px "Liberation Sans"';
  g.fillText('GREENLEAF AGRO PRODUCTS', 190, 122);
  g.fillStyle = '#3f6212';
  g.font = '24px "Liberation Sans"';
  g.fillText('Seeds - Fertilisers - Farm Equipment', 192, 164);
  g.fillStyle = '#14532d';
  g.fillRect(70, 214, W - 140, 4);
  g.fillRect(0, H - 96, W, 4);
  g.font = '22px "Liberation Sans"';
  g.fillText('5/118, Salem Main Road, Namakkal - 637001  |  Ph: 04286 220000  |  GSTIN 33BBBBB1111B1Z6', 70, H - 52);
  g.fillRect(0, H - 22, W, 22);
  await writeFile(tpl('greenleaf-agro', 'original_letterpad.png'), c.toBuffer('image/png'));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="70 58 80 132" width="80" height="132"><polygon points="70,80 150,80 110,190" fill="#14532d"/><circle cx="110" cy="92" r="34" fill="#65a30d"/></svg>\n`;
  await writeFile(tpl('greenleaf-agro', 'logo.svg'), svg);
  console.log('tests/fixtures/templates/greenleaf-agro: original_letterpad.png, logo.svg');
}
