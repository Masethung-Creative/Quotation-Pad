/** Indian number, currency, date and amount-in-words helpers. */

export const RUPEE = '₹';

const NUMERIC_RE = /^[\s₹]*(?:rs\.?|inr)?[\s₹]*\(?[-+\u2212]?\s*\d[\d,]*(?:\.\d+)?\)?\s*(?:\/-|\/=|cr|dr)?\.?\s*$/i;

/**
 * Parses an amount written the Indian way ("₹ 1,25,000.00", "Rs. 1,500/-", "(250.00)").
 * Returns null when the text is not a plain amount (e.g. "18%", "2 Nos", "").
 */
export function parseAmount(text: string | undefined | null): number | null {
  if (text == null) return null;
  const s = text.trim();
  if (!s || !NUMERIC_RE.test(s)) return null;
  const negative = /^\s*[₹]?\s*(?:rs\.?|inr)?\s*[₹]?\s*(\(|-|\u2212)/i.test(s) || /\)\s*$/.test(s);
  const m = s.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Parses a quantity that may carry a unit: "2", "2 Nos", "10.5 kg", "1,000 pcs". */
export function parseQuantity(text: string | undefined | null): number | null {
  if (text == null) return null;
  const m = text.trim().match(/^(\d[\d,]*(?:\.\d+)?)\s*([a-zA-Z.஀-௿ऀ-ॿ]{0,8})\.?$/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Finds a percentage inside a label such as "CGST @ 9%" or "IGST 18 %". */
export function parsePercent(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
}

export function looksNumeric(text: string): boolean {
  return parseAmount(text) !== null;
}

/** How many decimal places an amount string was written with. */
export function decimalsOf(text: string): number {
  const m = text.replace(/,/g, '').match(/\d+\.(\d+)/);
  return m ? m[1].length : 0;
}

/** Indian digit grouping: 125000 -> "1,25,000.00". */
export function formatIndian(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '';
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart, frac] = fixed.split('.');
  let grouped: string;
  if (intPart.length <= 3) {
    grouped = intPart;
  } else {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${last3}`;
  }
  return `${negative ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

export function formatRupees(value: number, decimals = 2): string {
  return `${RUPEE} ${formatIndian(value, decimals)}`;
}

const ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${TENS[t]} ${ONES[o]}` : TENS[t];
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(below100(r));
  return parts.join(' ');
}

/** Whole number in words, Indian system (thousand, lakh, crore). */
export function numberToWordsIndian(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${numberToWordsIndian(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}

/** 3540 -> "Rupees Three Thousand Five Hundred Forty Only". */
export function amountInWords(value: number): string {
  const abs = Math.abs(value);
  let rupees = Math.floor(abs);
  let paise = Math.round((abs - rupees) * 100);
  if (paise === 100) {
    rupees += 1;
    paise = 0;
  }
  const r = `Rupees ${numberToWordsIndian(rupees)}`;
  return paise ? `${r} and Paise ${below100(paise)} Only` : `${r} Only`;
}

/** Loose comparison key for two "amount in words" strings. */
export function wordsKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[₹]/g, ' ')
    .replace(/\b(rupees?|rs|inr|only|and|amount|in|words|total|paise|paisa)\b/g, ' ')
    .replace(/lakhs?|lacs?/g, 'lakh')
    .replace(/crores?/g, 'crore')
    .replace(/fourty/g, 'forty')
    .replace(/[^a-z]+/g, '');
}

/** DD-MM-YYYY, the date format used on Indian quotations. */
export function formatDateDMY(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${date.getFullYear()}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
