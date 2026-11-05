import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codesInText,
  codesFromIdentifier,
  codesMatch,
  displayCode,
  wordsMatch,
  isSameProductByName,
  nameQuery,
  identifyProduct,
  compareWith,
  searchShops,
} from '../server/lookup/compare.js';
import { lifoglistSearch, lifoglistProduct, roanuzBrand, roanuzProduct, kokkaSearch } from './fixtures/shop-pages.js';

const codes = (text) => codesInText(text).map((c) => c.code);

test('model and article numbers: letter codes with a dash, long article numbers, no units', () => {
  assert.deepEqual(codes('GRÆNMETISHNÍFUR 18CM - G-81'), ['G81']);
  assert.deepEqual(codes('Alhliðahnífur 11,5 cm - GS-108/UT'), ['GS108UT']);
  assert.deepEqual(codes('Hnífasett 2 hlutir G-2 & GS-1'), ['G2', 'GS1']);
  assert.deepEqual(codes('Diskur 27 CM - Cerise'), []);
  assert.deepEqual(codes('Pottur 24cm 21177240602430'), ['21177240602430']);
  assert.deepEqual(codesFromIdentifier('GLO-G5').map((c) => [c.code, c.display]), [['G5', 'G-5']]);
  assert.deepEqual(codesFromIdentifier('LEC-21177240602430').map((c) => c.code), ['21177240602430']);
  assert.deepEqual(codesFromIdentifier('G-5').map((c) => c.code), ['G5']);
  assert.deepEqual(codesFromIdentifier('Blár bolli'), []);
  assert.equal(displayCode('GS108'), 'GS-108');
});

test('codes match exactly or with a letter variant suffix, never another number', () => {
  assert.equal(codesMatch(['G5'], ['G5']), 'G5');
  assert.equal(codesMatch(['GS108'], ['GS108UT']), 'GS108');
  assert.equal(codesMatch(['G5'], ['G55']), '');
  assert.equal(codesMatch(['G2'], ['G2220GB']), '');
});

test('Icelandic words: inflections match, different compounds do not', () => {
  assert.ok(wordsMatch('hnifur', 'hnifinn'));
  assert.ok(wordsMatch('steypujarnspottur', 'steypujarnspotturinn'));
  assert.ok(!wordsMatch('steypujarnspottur', 'steypujarnspanna'));
  assert.ok(!wordsMatch('24', '26'));
  assert.ok(isSameProductByName('Le Creuset Steypujárnspottur 26cm Djúpur Black', 'Steypujárnspottur 26cm djúpur black', 'Le Creuset'));
  assert.ok(!isSameProductByName('Le Creuset Steypujárnspottur 26cm', 'Le Creuset Steypujárnspanna 26cm', 'Le Creuset'));
  assert.ok(!isSameProductByName('Le Creuset Steypujárnspottur 26cm', 'Le Creuset Steypujárnspottur 24cm', 'Le Creuset'));
});

test('search phrase: longest word plus sizes, without brand, codes and colour', () => {
  assert.equal(nameQuery('SIGNATURE STEYPUJÁRNSPOTTUR 24 CM - CERISE'), 'STEYPUJÁRNSPOTTUR 24');
  assert.equal(nameQuery('Le Creuset Steypujárnspottur 26cm Djúpur', 'Le Creuset'), 'Steypujárnspottur 26');
  assert.equal(nameQuery('Global Nakiri hnífur 18cm G-5', 'Global'), 'Nakiri 18');
});

// ---- a small fake "internet" with the four shops -----------------------------------------

const PAGES = {
  'https://kunigund.is/global-granmetishnifur-18cm.html': roanuzProduct({ name: 'Global Nakiri hnífur 18cm', sku: 'GLO-G5', price: 24995 }),
  'https://kunigund.is/brand/global': roanuzBrand([
    { name: 'Global Nakiri hnífur 18cm', sku: 'GLO-G5', urlKey: 'global-granmetishnifur-18cm', price: 24995 },
    { name: 'Global Kokkahnífur 18cm', sku: 'GLO-G55', urlKey: 'global-kokkahnifur-18cm', price: 22995 },
  ]),
  'https://byggtogbuid.is/brand/global': roanuzBrand([
    { name: 'Global Grænmetishnífur 18cm', sku: 'GLO-G81', urlKey: 'global-graenmetishnifur-18cm', price: 27995 },
    { name: 'Global Nakiri 18cm', sku: 'GLO-G5', urlKey: 'global-nakiri-18cm', price: 23995 },
  ]),
  'https://www.lifoglist.is/leit?q=G-5': lifoglistSearch([
    { name: 'SANTOKUHNÍFUR 16CM - G-57', slug: 'santoku-g-57', price: 23630, sku: 'glo34905', foreignSku: 'G-57', brand: 'Global' },
    { name: 'Grænmetishnífur 18cm - G-5', slug: 'graenmetishnifur-18cm-g-5', price: 25980, sku: 'rod34904', foreignSku: 'G-5', brand: 'Global' },
  ]),
  'https://kokka.is/?s=G-5&post_type=product': kokkaSearch([
    { name: 'Global G-5 nakiri', url: 'https://kokka.is/vara/global-g-5/', price: '26.990 kr.', oldPrice: '29.990 kr.', sku: 'G-5' },
    { name: 'Global G-81 grænmetishnífur', url: 'https://kokka.is/vara/global-g-81/', price: '24.990 kr.', sku: 'G-81' },
  ]),
};

function fakeFetch(extra = {}) {
  const pages = { ...PAGES, ...extra };
  const fetched = [];
  const fetchPage = async (url) => {
    fetched.push(url);
    if (pages[url] === undefined) throw new Error(`404 ${url}`);
    return { url, text: pages[url] };
  };
  return { fetchPage, fetched };
}

test('identifies brand and model number from the product page (shop SKU with brand prefix)', async () => {
  const { fetchPage } = fakeFetch();
  const ident = await identifyProduct(fetchPage, { name: 'Global Nakiri hnífur 18cm', url: 'https://kunigund.is/global-granmetishnifur-18cm.html' });
  assert.equal(ident.brand, 'Global');
  assert.deepEqual(ident.displayCodes, ['G-5']);
});

test('finds the SAME product (same model number) in the other shops, even under another name', async () => {
  const { fetchPage, fetched } = fakeFetch();
  const res = await compareWith(fetchPage, { name: 'Global Nakiri hnífur 18cm', url: 'https://kunigund.is/global-granmetishnifur-18cm.html' }, { logger: null });
  assert.deepEqual(
    res.offers.map((o) => [o.store, o.price, o.match, o.matchCode]),
    [
      ['Byggt og búið', 23995, 'code', 'G-5'],
      ['Líf og List', 25980, 'code', 'G-5'], // "Grænmetishnífur 18cm - G-5"
      ['Kokka', 26990, 'code', 'G-5'], // the sale price, not the old one
    ],
  );
  // G-81 and G-57 (similar knives) are not offered; Kúnígúnd (the known shop) is not searched.
  assert.ok(!res.offers.some((o) => /G-81|G-57/.test(o.name)));
  assert.ok(!fetched.includes('https://kunigund.is/brand/global'));
  assert.equal(res.offers[0].url, 'https://byggtogbuid.is/global-nakiri-18cm.html');
  assert.match(res.offers[0].imageUrl, /product_images_v1\/GLO-G5\//);
});

test('starting from Líf og List (product data only in Next.js page data) finds it at Kúnígúnd', async () => {
  const lolUrl = 'https://www.lifoglist.is/vorur/graenmetishnifur-18cm-g-5';
  const { fetchPage } = fakeFetch({
    [lolUrl]: lifoglistProduct({ name: 'Grænmetishnífur 18cm - G-5', slug: 'graenmetishnifur-18cm-g-5', price: 25980, sku: 'rod34904', foreignSku: 'G-5', brand: 'Global' }),
  });
  const res = await compareWith(fetchPage, { name: 'Grænmetishnífur 18cm - G-5', url: lolUrl }, { logger: null });
  assert.equal(res.identity.brand, 'Global');
  assert.deepEqual(res.offers.map((o) => o.store).sort(), ['Byggt og búið', 'Kokka', 'Kúnígúnd']);
});

test('without model numbers it falls back to a strict name match (same brand, size and words)', async () => {
  const { fetchPage } = fakeFetch({
    'https://kunigund.is/brand/le-creuset': roanuzBrand([
      { name: 'Le Creuset Steypujárnspottur 26cm Djúpur Black', sku: 'LEC-POTTUR-26-DJUPUR', urlKey: 'lc-pottur-26', price: 69995 },
      { name: 'Le Creuset Steypujárnspanna 26cm djúp Cerise', sku: 'LEC-PANNA-26', urlKey: 'lc-panna-26', price: 39995 },
      { name: 'Le Creuset Steypujárnspottur 24cm', sku: 'LEC-POTTUR-24', urlKey: 'lc-pottur-24', price: 59995 },
    ]),
  });
  const res = await compareWith(fetchPage, { name: 'Le Creuset Steypujárnspottur 26cm Djúpur Black' }, { logger: null });
  assert.deepEqual(res.offers.map((o) => [o.store, o.price, o.match]), [['Kúnígúnd', 69995, 'name']]);
});

test('a shop that fails or blocks does not stop the others; nothing found gives a message', async () => {
  const { fetchPage } = fakeFetch({ 'https://kokka.is/?s=G-5&post_type=product': undefined });
  const res = await compareWith(fetchPage, { name: 'Global Nakiri hnífur 18cm', url: 'https://kunigund.is/global-granmetishnifur-18cm.html' }, { logger: null });
  assert.deepEqual(res.offers.map((o) => o.store), ['Byggt og búið', 'Líf og List']);

  const none = await compareWith(async () => ({ url: '', text: '<html></html>' }), { name: 'Óþekkt vara 12' }, { logger: null });
  assert.equal(none.offers.length, 0);
  assert.match(none.message, /Fann ekki sömu vöru/);
  const empty = await compareWith(fetchPage, { name: '  ' }, { logger: null });
  assert.match(empty.message, /heiti vörunnar/);
});

test('free-text search across shops ("Finna" without a link)', async () => {
  const { fetchPage } = fakeFetch();
  const results = await searchShops(fetchPage, 'Global G-5', { logger: null });
  const stores = results.map((r) => r.store);
  assert.ok(stores.includes('Líf og List') && stores.includes('Kúnígúnd') && stores.includes('Kokka'));
  // Model-number matches come first; G-81 and G-57 are not returned for "G-5".
  assert.ok(results.every((r) => !/G-81|G-57|GLO-G81/.test(r.name)));
  assert.equal(await searchShops(fetchPage, '   ', { logger: null }).then((r) => r.length), 0);
});
