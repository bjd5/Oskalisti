import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, toIsk, normalizeCurrency, priceFields, APPROX_ISK_RATES } from '../server/lookup/price.js';

test('parsePrice handles numbers and Icelandic/English formats', () => {
  const cases = [
    [12990, 12990],
    ['12990', 12990],
    ['12990.00', 12990],
    ['12.990 kr.', 12990],
    ['12.990,00 kr', 12990],
    ['kr. 12.990', 12990],
    ['1.299.000', 1299000],
    ['12,990', 12990],
    ['54 990 kr', 54990],
    ['54 990 kr', 54990],
    ['54 990 kr.', 54990],
    ['12990.5', 12990.5],
    ['12,5', 12.5],
    ['12990.000', 12990], // 5-digit leading group can't be thousands grouping
    ['0.500', 0.5],
    ['1,234.56', 1234.56],
    ['1.234,56 €', 1234.56],
    ['49,99 €', 49.99],
    ['12.990.-', 12990],
    ['Verð: 1 299 000 kr', 1299000],
    ['ISK 54990', 54990],
  ];
  for (const [input, expected] of cases) assert.equal(parsePrice(input), expected, `parsePrice(${JSON.stringify(input)})`);
});

test('parsePrice returns null for junk', () => {
  for (const input of ['', 'abc', 'kr.', null, undefined, {}, [], -5, NaN, Infinity, '1.2.3']) {
    assert.equal(parsePrice(input), null, `parsePrice(${JSON.stringify(input)})`);
  }
});

test('toIsk converts with the approximate rates and rounds to whole krónur', () => {
  assert.equal(toIsk(5000), 5000);
  assert.equal(toIsk(12.4, 'ISK'), 12);
  assert.equal(toIsk(49.99, 'EUR'), Math.round(49.99 * APPROX_ISK_RATES.EUR));
  assert.equal(toIsk(100, 'usd'), 13800);
  assert.equal(toIsk(10, 'GBP'), 1750);
  assert.equal(toIsk(100, 'DKK'), 2000);
  assert.equal(toIsk(100, 'SEK'), 1300);
  assert.equal(toIsk(100, 'NOK'), 1250);
  assert.equal(toIsk('12.990 kr.', 'kr.'), 12990);
  assert.equal(toIsk(10, 'XYZ'), null);
  assert.equal(toIsk(null, 'ISK'), null);
});

test('normalizeCurrency and priceFields', () => {
  assert.equal(normalizeCurrency(' isk '), 'ISK');
  assert.equal(normalizeCurrency('kr.'), 'ISK');
  assert.equal(normalizeCurrency('€'), 'EUR');
  assert.equal(normalizeCurrency('krónur'), '');
  assert.deepEqual(priceFields('54990', 'ISK'), { price: 54990, currency: 'ISK', originalPrice: 54990 });
  assert.deepEqual(priceFields('449,99', 'EUR'), { price: 67499, currency: 'EUR', originalPrice: 449.99 });
  assert.deepEqual(priceFields(null, 'ISK'), { price: null, currency: 'ISK', originalPrice: null });
  assert.deepEqual(priceFields('0', 'ISK'), { price: null, currency: 'ISK', originalPrice: null });
  assert.deepEqual(priceFields('20', ''), { price: null, currency: '', originalPrice: 20 });
});
