// Price parsing and currency conversion helpers for the product lookup.

/**
 * APPROXIMATE exchange rates: how many ISK one unit of the currency is worth.
 * These are static, rounded figures only meant to give the couple a rough idea of
 * what an item from a foreign store costs. They are NOT live rates; update them
 * now and then if they drift too far.
 */
export const APPROX_ISK_RATES = Object.freeze({
  ISK: 1,
  EUR: 150,
  USD: 138,
  GBP: 175,
  DKK: 20,
  SEK: 13,
  NOK: 12.5,
});

const CURRENCY_ALIASES = {
  KR: 'ISK',
  'KR.': 'ISK',
  IKR: 'ISK',
  '€': 'EUR',
  $: 'USD',
  US$: 'USD',
  '£': 'GBP',
};

/** Normalises "isk", "kr.", "€" … to an ISO 4217 code; returns "" when unknown/empty. */
export function normalizeCurrency(currency) {
  if (typeof currency !== 'string') return '';
  const c = currency.trim().toUpperCase();
  if (!c) return '';
  if (CURRENCY_ALIASES[c]) return CURRENCY_ALIASES[c];
  return /^[A-Z]{3}$/.test(c) ? c : '';
}

// A number, possibly with thousands/decimal separators. Spaces (incl. nbsp, narrow
// nbsp, thin space) only count as a separator when followed by exactly 3 digits,
// so "3 stk 12.990" does not glue "3" and "12.990" together.
const NUMBER_TOKEN = /\d+(?:[.,'’]\d+|[    ]\d{3}(?!\d))*/;

function isThousandsGrouping(parts) {
  return (
    parts.length > 1 &&
    /^\d{1,3}$/.test(parts[0]) &&
    !/^0\d/.test(parts[0]) &&
    parts[0] !== '0' &&
    parts.slice(1).every((p) => /^\d{3}$/.test(p))
  );
}

/**
 * Parses a price from a number or a human formatted string.
 *   12990, "12990", "12990.00", "12.990 kr.", "12.990,00 kr", "kr. 12.990",
 *   "1.299.000", "12,990", "54 990 kr", "12990.5"
 * Rules: if both "." and "," occur, the later one is the decimal separator.
 * With a single kind of separator, groups of exactly 3 digits after a 1–3 digit
 * leading group are thousands; otherwise the (last) separator is a decimal point.
 * Returns a non-negative number, or null when nothing sensible is found.
 */
export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;

  const match = value.match(NUMBER_TOKEN);
  if (!match) return null;
  const token = match[0].replace(/[    '’]/g, '');

  const lastDot = token.lastIndexOf('.');
  const lastComma = token.lastIndexOf(',');
  let normalized;

  if (lastDot !== -1 && lastComma !== -1) {
    const decimalSep = lastDot > lastComma ? '.' : ',';
    const thousandsSep = decimalSep === '.' ? ',' : '.';
    const [intPart, fracPart] = splitAtLast(token.split(thousandsSep).join(''), decimalSep);
    if (intPart.includes(decimalSep)) return null; // e.g. "1,2,3.4" after removing dots
    normalized = `${intPart}.${fracPart}`;
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? '.' : ',';
    const parts = token.split(sep);
    if (isThousandsGrouping(parts)) {
      normalized = parts.join('');
    } else if (parts.length === 2) {
      normalized = `${parts[0]}.${parts[1]}`; // single separator → decimal point
    } else {
      return null; // e.g. "1.2.3" – not a price
    }
  } else {
    normalized = token;
  }

  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function splitAtLast(str, sep) {
  const i = str.lastIndexOf(sep);
  return [str.slice(0, i), str.slice(i + 1)];
}

/**
 * Converts an amount in `currency` to whole ISK using APPROX_ISK_RATES.
 * Missing/empty currency is treated as ISK. Unknown currency or amount → null.
 */
export function toIsk(amount, currency = 'ISK') {
  const n = typeof amount === 'number' ? amount : parsePrice(amount);
  if (n === null || !Number.isFinite(n) || n < 0) return null;
  const code = normalizeCurrency(currency) || (currency ? null : 'ISK');
  const rate = code ? APPROX_ISK_RATES[code] : undefined;
  if (rate === undefined) return null;
  return Math.round(n * rate);
}

/**
 * Builds the { price, currency, originalPrice } triple of a LookupResult.
 * `price` is whole ISK (null when unknown or not convertible), `originalPrice` the
 * amount as listed in `currency`.
 */
export function priceFields(amount, currency) {
  const original = parsePrice(amount);
  if (original === null || original <= 0) return { price: null, currency: normalizeCurrency(currency) || 'ISK', originalPrice: null };
  const code = normalizeCurrency(currency);
  if (!code) return { price: null, currency: '', originalPrice: original };
  return { price: toIsk(original, code), currency: code, originalPrice: original };
}
