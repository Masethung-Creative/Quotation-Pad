import { describe, expect, it } from 'vitest';
import { amountInWords, decimalsOf, formatDateDMY, formatIndian, formatRupees, numberToWordsIndian, parseAmount, parsePercent, parseQuantity, wordsKey } from '@/lib/format';

describe('parseAmount', () => {
  it.each([
    ['3,000.00', 3000],
    ['1,25,000.00', 125000],
    ['₹ 1,25,000.00', 125000],
    ['Rs. 1,500/-', 1500],
    ['Rs 7500', 7500],
    ['INR 42.50', 42.5],
    ['(250.00)', -250],
    ['-0.40', -0.4],
    ['0', 0],
  ])('reads %s', (text, value) => {
    expect(parseAmount(text)).toBeCloseTo(value, 6);
  });

  it.each(['', '  ', '18%', '2 Nos', 'Item description', 'Q/2026-27/045', '17-11-2026', undefined, null])('rejects %s', (text) => {
    expect(parseAmount(text as string)).toBeNull();
  });
});

describe('parseQuantity / parsePercent', () => {
  it('reads quantities with units', () => {
    expect(parseQuantity('2')).toBe(2);
    expect(parseQuantity('2 Nos')).toBe(2);
    expect(parseQuantity('10.5 kg')).toBe(10.5);
    expect(parseQuantity('1,000 pcs')).toBe(1000);
    expect(parseQuantity('two')).toBeNull();
  });
  it('finds the percentage in a tax label', () => {
    expect(parsePercent('CGST 9%')).toBe(9);
    expect(parsePercent('IGST @ 18 %')).toBe(18);
    expect(parsePercent('GST 2.5%')).toBe(2.5);
    expect(parsePercent('Sub Total')).toBeNull();
  });
  it('counts decimals as written', () => {
    expect(decimalsOf('3,000.00')).toBe(2);
    expect(decimalsOf('3,000')).toBe(0);
    expect(decimalsOf('12.5')).toBe(1);
  });
});

describe('Indian number formatting', () => {
  it.each([
    [0, '0.00'],
    [999, '999.00'],
    [1000, '1,000.00'],
    [125000, '1,25,000.00'],
    [12345678.9, '1,23,45,678.90'],
    [-2500.5, '-2,500.50'],
  ])('groups %d as %s', (value, text) => {
    expect(formatIndian(value)).toBe(text);
  });
  it('supports whole numbers and the rupee sign', () => {
    expect(formatIndian(125000, 0)).toBe('1,25,000');
    expect(formatRupees(3540)).toBe('₹ 3,540.00');
  });
});

describe('amount in words (lakh / crore)', () => {
  it.each([
    [3540, 'Rupees Three Thousand Five Hundred Forty Only'],
    [0, 'Rupees Zero Only'],
    [19, 'Rupees Nineteen Only'],
    [100000, 'Rupees One Lakh Only'],
    [125000, 'Rupees One Lakh Twenty Five Thousand Only'],
    [10000000, 'Rupees One Crore Only'],
    [123456789, 'Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Only'],
    [75614.4, 'Rupees Seventy Five Thousand Six Hundred Fourteen and Paise Forty Only'],
    [99.999, 'Rupees One Hundred Only'],
  ])('%d', (value, words) => {
    expect(amountInWords(value)).toBe(words);
  });
  it('handles very large numbers', () => {
    expect(numberToWordsIndian(1234567890123)).toBe('One Lakh Twenty Three Thousand Four Hundred Fifty Six Crore Seventy Eight Lakh Ninety Thousand One Hundred Twenty Three');
  });
  it('compares wording loosely', () => {
    expect(wordsKey('Rupees Three Thousand Five Hundred and Forty Only')).toBe(wordsKey('(Rs. three thousand five hundred forty only)'));
    expect(wordsKey('Rupees One Lac Only')).toBe(wordsKey('Rupees One Lakh Only'));
    expect(wordsKey('Rupees Three Thousand Only')).not.toBe(wordsKey('Rupees Four Thousand Only'));
  });
});

describe('dates', () => {
  it('uses DD-MM-YYYY', () => {
    expect(formatDateDMY(new Date(2026, 10, 17))).toBe('17-11-2026');
    expect(formatDateDMY(new Date(2027, 0, 5))).toBe('05-01-2027');
  });
});
