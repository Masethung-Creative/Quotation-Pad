import { describe, expect, it } from 'vitest';
import { detectFile, IngestError, MAX_FILE_BYTES, sniff } from '@/ingest/detect';
import { sample, templateFile } from './helpers';

const bytes = (...parts: (string | number[])[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0)) : p));
  return new Uint8Array(out);
};
const none = new Uint8Array(0);

describe('sniff (magic bytes first)', () => {
  it('recognises every sample file by content', () => {
    expect(sniff(sample('quotation-digital.pdf'), none, 'a.bin', '')).toBe('pdf');
    expect(sniff(sample('quotation-scanned.pdf'), none, 'a.bin', '')).toBe('pdf');
    expect(sniff(sample('quotation.docx'), none, 'a.bin', '')).toBe('docx');
    expect(sniff(sample('quotation-photo.jpg'), none, 'a.bin', '')).toBe('jpg');
    expect(sniff(templateFile('greenleaf-agro', 'original_letterpad.png'), none, 'a.bin', '')).toBe('png');
    expect(sniff(sample('spec-example.json'), none, 'spec.json', '')).toBe('json');
  });

  it('does not trust a wrong extension', () => {
    expect(sniff(sample('quotation-photo.jpg'), none, 'scan.pdf', 'application/pdf')).toBe('jpg');
    expect(sniff(sample('quotation-digital.pdf'), none, 'photo.jpg', 'image/jpeg')).toBe('pdf');
  });

  it('recognises HEIC, WebP and legacy Word / RTF', () => {
    expect(sniff(bytes([0, 0, 0, 24], 'ftypheic', [0, 0, 0, 0], 'mif1heic'), none, 'IMG_1.HEIC', '')).toBe('heic');
    expect(sniff(bytes([0, 0, 0, 24], 'ftypmif1', [0, 0, 0, 0], 'mif1heic'), none, 'x', '')).toBe('heic');
    expect(sniff(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '), none, 'x', '')).toBe('webp');
    expect(sniff(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), none, 'old.doc', 'application/msword')).toBe('doc');
    expect(sniff(bytes('{\\rtf1\\ansi'), none, 'letter.rtf', '')).toBe('doc');
  });

  it('rejects other zip containers and unknown files', () => {
    const xlsx = bytes([0x50, 0x4b, 0x03, 0x04], '....[Content_Types].xml....xl/workbook.xml');
    expect(sniff(xlsx, bytes('xl/worksheets/sheet1.xml'), 'prices.xlsx', '')).toBe('unknown');
    expect(sniff(bytes('MZ', [0x90, 0, 3]), none, 'setup.exe', '')).toBe('unknown');
    expect(sniff(bytes('hello world'), none, 'notes.txt', 'text/plain')).toBe('unknown');
  });
});

describe('detectFile', () => {
  const file = (data: Uint8Array, name: string, type = '') => new File([data as BlobPart], name, { type });

  it('accepts the supported types', async () => {
    await expect(detectFile(file(sample('quotation.docx'), 'q.docx'))).resolves.toBe('docx');
    await expect(detectFile(file(sample('quotation-digital.pdf'), 'q.pdf'))).resolves.toBe('pdf');
  });

  it('asks for .docx or PDF when given a legacy .doc', async () => {
    const doc = file(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'old.doc', 'application/msword');
    await expect(detectFile(doc)).rejects.toThrow('Please save this as .docx, .odt or PDF and upload again.');
    await expect(detectFile(doc)).rejects.toBeInstanceOf(IngestError);
  });

  it('enforces the 20 MB limit', async () => {
    const big = { size: MAX_FILE_BYTES + 1, name: 'huge.pdf', type: 'application/pdf' } as File;
    await expect(detectFile(big)).rejects.toMatchObject({ code: 'too-large' });
  });

  it('rejects empty and unsupported files with a clear message', async () => {
    await expect(detectFile(file(new Uint8Array(0), 'empty.pdf'))).rejects.toMatchObject({ code: 'empty' });
    await expect(detectFile(file(bytes('hello'), 'notes.txt'))).rejects.toMatchObject({ code: 'unsupported' });
  });
});
