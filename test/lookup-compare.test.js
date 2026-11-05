import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareWith,
  isSameProduct,
  productTokens,
  comparisonQuery,
  parseBingResults,
  parseDuckDuckGoLite,
  decodeBingHref,
  pickShopCandidates,
} from '../server/lookup/compare.js';

const productPage = (name, price, image = 'https://cdn.example/img.jpg') => `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Product', name, image,
  offers: { '@type': 'Offer', price: String(price), priceCurrency: 'ISK' },
})}</script></head><body><h1>${name}</h1></body></html>`;

const ddgPage = (links) => `<div class="results">${links
  .map(([url, title]) => `<div class="result web-result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=x">${title}</a></h2></div>`)
  .join('')}</div>`;

const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bingPage = (links) => `<ol id="b_results">${links
  .map(([url, title]) => `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${b64url(url)}&amp;ntb=1">${title}</a></h2></li>`)
  .join('')}</ol>`;

test('tokens fold Icelandic letters and split sizes', () => {
  assert.deepEqual(productTokens('Global Nakiri hnífur 18cm'), ['global', 'nakiri', 'hnifur', '18']);
  assert.deepEqual(productTokens('Þvottapoki – Æðardúnn'), ['thvottapoki', 'aedardunn']);
});

test('same product: numbers must match, most words must match, inflection tolerated', () => {
  assert.ok(isSameProduct('Global Nakiri hnífur 18 cm', 'Global G-81 Nakiri 18cm'));
  assert.ok(isSameProduct('Global Nakiri hnífur 18 cm', 'GLOBAL nakiri hnífinn 18 cm'));
  assert.ok(!isSameProduct('Global Nakiri hnífur 18 cm', 'Global Nakiri hnífur 14 cm'));
  assert.ok(!isSameProduct('Global Nakiri hnífur 18 cm', 'Wüsthof brauðhnífur 18 cm'));
  assert.ok(isSameProduct('Signature steypujárnspottur 24 cm', 'Le Creuset Signature steypujárnspottur 24cm rauður'));
});

test('query drops a colour or shop suffix after " - "', () => {
  assert.equal(comparisonQuery('SIGNATURE STEYPUJÁRNSPOTTUR 24 CM - CERISE'), 'SIGNATURE STEYPUJÁRNSPOTTUR 24 CM');
});

test('parses Bing (base64 redirect) and DuckDuckGo lite results', () => {
  assert.deepEqual(parseBingResults(bingPage([['https://elko.is/vara/global-nakiri', 'Global Nakiri | ELKO']])), [
    { url: 'https://elko.is/vara/global-nakiri', title: 'Global Nakiri | ELKO' },
  ]);
  assert.equal(decodeBingHref('https://kokka.is/x'), 'https://kokka.is/x');
  assert.equal(decodeBingHref('https://www.bing.com/ck/a?u=zzz'), '');
  const lite = `<table><tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://kokka.is/global')}" class='result-link'>Global hnífur</a></td></tr></table>`;
  assert.deepEqual(parseDuckDuckGoLite(lite), [{ url: 'https://kokka.is/global', title: 'Global hnífur' }]);
});

test('candidates: Icelandic shops only, max two per shop, known shop skipped', () => {
  const picked = pickShopCandidates(
    [
      { url: 'https://kokka.is/a' }, { url: 'https://kokka.is/b' }, { url: 'https://kokka.is/c' },
      { url: 'https://www.amazon.de/x' }, { url: 'https://www.mbl.is/frett' }, { url: 'https://elko.is/x' },
      { url: 'https://epal.is/x' },
    ],
    { excludeHosts: ['epal.is'] },
  );
  assert.deepEqual(picked.map((p) => p.url), ['https://kokka.is/a', 'https://kokka.is/b', 'https://elko.is/x']);
});

test('compares prices across Icelandic shops, cheapest first, one per shop', async () => {
  const pages = {
    'https://kokka.is/vara/global-nakiri-18': productPage('Global G-81 Nakiri 18 cm', 32990),
    'https://kokka.is/vara/global-nakiri-14': productPage('Global Nakiri 14 cm', 24990),
    'https://hrim.is/global-nakiri': productPage('Global Nakiri hnífur 18cm', 29990),
    'https://elko.is/global-nakiri': productPage('Global Nakiri 18cm', 0), // no price → skipped
    'https://epal.is/global-nakiri': productPage('Global Nakiri 18 cm', 31990), // the shop we already have
    'https://brokin.is/x': null,
  };
  const fetched = [];
  const fetchPage = async (url) => {
    fetched.push(url);
    if (url.startsWith('https://html.duckduckgo.com/')) {
      assert.equal(new URL(url).searchParams.get('q'), 'Global Nakiri hnífur 18 cm site:is');
      return {
        url,
        text: ddgPage([
          ['https://kokka.is/vara/global-nakiri-14', 'Global Nakiri 14 cm'],
          ['https://kokka.is/vara/global-nakiri-18', 'Global Nakiri 18 cm'],
          ['https://hrim.is/global-nakiri', 'Global Nakiri – Hrím'],
          ['https://elko.is/global-nakiri', 'Global Nakiri – ELKO'],
          ['https://epal.is/global-nakiri', 'Global Nakiri – Epal'],
          ['https://brokin.is/x', 'Global'],
          ['https://www.facebook.com/x', 'Global'],
        ]),
      };
    }
    if (pages[url]) return { url, text: pages[url] };
    throw new Error('404');
  };
  const res = await compareWith(fetchPage, { name: 'Global Nakiri hnífur 18 cm', url: 'https://epal.is/global-nakiri' }, { logger: null });
  assert.deepEqual(
    res.offers.map((o) => [o.store, o.price]),
    [['Hrím', 29990], ['Kokka', 32990]],
  );
  assert.ok(!fetched.includes('https://epal.is/global-nakiri'));
  assert.ok(!fetched.some((u) => u.includes('bing.com')), 'stops after the first engine found enough');
});

test('falls back to the next search engine when one fails', async () => {
  const fetchPage = async (url) => {
    if (url.includes('duckduckgo.com')) throw new Error('blocked');
    if (url.includes('bing.com')) return { url, text: bingPage([['https://kokka.is/nakiri', 'Global Nakiri 18 cm']]) };
    if (url === 'https://kokka.is/nakiri') return { url, text: productPage('Global Nakiri 18 cm', 30990) };
    throw new Error('404');
  };
  const res = await compareWith(fetchPage, { name: 'Global Nakiri 18 cm' }, { logger: null });
  assert.deepEqual(res.offers.map((o) => o.price), [30990]);
});

test('explains when nothing is found', async () => {
  const res = await compareWith(async (url) => ({ url, text: '<html></html>' }), { name: 'Global Nakiri' }, { logger: null });
  assert.equal(res.offers.length, 0);
  assert.match(res.message, /Fann engar/);
  const empty = await compareWith(async () => ({ text: '' }), { name: '  ' }, { logger: null });
  assert.match(empty.message, /heiti vörunnar/);
});
