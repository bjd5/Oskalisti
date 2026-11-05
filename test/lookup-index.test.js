import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupProduct,
  isAiSearchEnabled,
  looksLikeUrl,
  normalizeUrlInput,
  cleanUrl,
  dedupeResults,
  MAX_RESULTS,
} from '../server/lookup/index.js';
import { duckDuckGoUrl, NOTHING_FOUND_MESSAGE } from '../server/lookup/search.js';
import { fixture, fakeFetch, fakeDns, silentLogger } from './fixtures/lookup-helpers.js';

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_MODEL;

const dnsLookup = fakeDns();
const KOKKA_URL = 'https://kokka.is/vara/le-creuset-pottur-24';
const EPAL_URL = 'https://www.epal.is/vorur/hammershoi-vasi';

function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params) => {
          calls.push(structuredClone(params));
          const r = responses[calls.length - 1];
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  };
}

const report = (products) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'report_products', input: { products } }],
});

const deps = (routes, extra = {}) => ({ fetchImpl: fakeFetch(routes), dnsLookup, logger: silentLogger, ...extra });

test('looksLikeUrl / normalizeUrlInput / isAiSearchEnabled', () => {
  for (const q of ['https://kokka.is/x', 'http://a.is', 'www.elko.is/vara/1', 'kokka.is/vara/x', 'epal.is', 'file:///etc/passwd']) {
    assert.ok(looksLikeUrl(q), q);
  }
  for (const q of ['Le Creuset pottur 24cm', 'KitchenAid hrærivél', 'KitchenAid', '5.5L', '', 'sjá https://kokka.is/x']) {
    assert.ok(!looksLikeUrl(q), q);
  }
  assert.equal(normalizeUrlInput('www.elko.is/a'), 'https://www.elko.is/a');
  assert.equal(normalizeUrlInput('http://a.is'), 'http://a.is');
  assert.equal(isAiSearchEnabled(), false);
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    assert.equal(isAiSearchEnabled(), true);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('empty query', async () => {
  const out = await lookupProduct('   ', deps({}));
  assert.deepEqual(out.results, []);
  assert.equal(out.source, 'none');
  assert.ok(out.message);
});

test('URL query → extractor, source "url"; AI not consulted when a price was found', async () => {
  const client = fakeClient([]);
  const out = await lookupProduct(`  ${KOKKA_URL}?utm_source=fb#reviews `, deps({ [`${KOKKA_URL}?utm_source=fb`]: fixture('kokka-jsonld.html') }, { anthropicClient: client }));
  assert.equal(out.source, 'url');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].price, 54990);
  assert.equal(out.results[0].url, KOKKA_URL); // tracking params stripped
  assert.equal(out.message, undefined);
  assert.equal(client.calls.length, 0);
});

test('URL without a price + AI enabled → AI fills the gap and adds other stores', async () => {
  const url = 'https://nyverslun.is/vara/vasi';
  const client = fakeClient([
    report([
      { name: 'Vasi', store: 'Ný verslun', url, price_isk: 8990, image_url: 'https://nyverslun.is/vasi.jpg' },
      { name: 'Vasi', store: 'Epal', url: EPAL_URL, price_isk: null, image_url: null },
    ]),
  ]);
  const out = await lookupProduct(
    url,
    deps({ [url]: '<title>Vasi | Ný verslun</title><h1>Vasi</h1>', [EPAL_URL]: fixture('epal-meta.html') }, { anthropicClient: client }),
  );
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].messages[0].content, url);
  assert.equal(out.source, 'url');
  assert.deepEqual(
    out.results.map((r) => [r.url, r.price, r.imageUrl]),
    [
      [url, 8990, 'https://nyverslun.is/vasi.jpg'],
      [EPAL_URL, 12990, 'https://www.epal.is/images/products/hammershoi-vasi.jpg'], // enriched from the page
    ],
  );
});

test('URL that cannot be fetched still returns a minimal result with a message', async () => {
  const url = 'https://elko.is/vara/kitchenaid-artisan-hraerivel';
  const out = await lookupProduct(url, deps({ [url]: { status: 403, body: 'blocked' } }));
  assert.equal(out.source, 'url');
  assert.deepEqual(out.results, [
    { name: 'Kitchenaid artisan hraerivel', store: 'ELKO', url, price: null, currency: 'ISK', originalPrice: null, imageUrl: '' },
  ]);
  assert.match(out.message, /403/);
});

test('blocked URLs return no results and no fetch happens', async () => {
  for (const q of ['http://127.0.0.1/admin', 'http://localhost:3000', 'http://10.0.0.5/', 'file:///etc/passwd']) {
    const d = deps({});
    const out = await lookupProduct(q, d);
    assert.deepEqual(out.results, [], q);
    assert.equal(out.source, 'none');
    assert.match(out.message, /ekki leyfð/);
    assert.equal(d.fetchImpl.calls.length, 0);
  }
});

test('free text without AI → keyless search, source "search"', async () => {
  const q = 'Le Creuset pottur 24cm';
  const out = await lookupProduct(q, deps({ [duckDuckGoUrl(q)]: fixture('ddg-results.html'), [KOKKA_URL]: fixture('kokka-jsonld.html') }));
  assert.equal(out.source, 'search');
  assert.equal(out.results[0].store, 'Kokka');
  assert.equal(out.results[0].price, 54990);
});

test('free text without AI and nothing found → source "none" + message', async () => {
  const out = await lookupProduct('eitthvað skrítið', deps({}));
  assert.deepEqual(out, { results: [], source: 'none', message: NOTHING_FOUND_MESSAGE });
});

test('free text with AI → source "ai", results enriched (missing image/price) and never dropped', async () => {
  const client = fakeClient([
    report([
      { name: 'Le Creuset pottur', store: 'Kokka', url: `${KOKKA_URL}?srsltid=abc`, price_isk: 52990, image_url: null },
      { name: 'Pottur', store: 'Erlend búð', url: 'https://www.amazon.de/dp/B000KITCHEN', price_isk: null, image_url: null },
      { name: 'Óaðgengilegt', store: 'HT', url: 'https://ht.is/vara/pottur', price_isk: 49990, image_url: null },
      { name: 'Tvítekið', store: 'Kokka', url: KOKKA_URL, price_isk: 1, image_url: null },
    ]),
  ]);
  const d = deps(
    { [`${KOKKA_URL}?srsltid=abc`]: fixture('kokka-jsonld.html'), 'https://www.amazon.de/dp/B000KITCHEN': fixture('amazon-eur.html') },
    { anthropicClient: client },
  );
  const out = await lookupProduct('Le Creuset pottur 24cm', d);
  assert.equal(out.source, 'ai');
  assert.deepEqual(out.results, [
    {
      name: 'Le Creuset pottur',
      store: 'Kokka',
      url: KOKKA_URL,
      price: 52990, // AI's ISK price kept; only gaps are filled
      currency: 'ISK',
      originalPrice: 52990,
      imageUrl: 'https://kokka.is/media/catalog/le-creuset-24.jpg',
    },
    {
      name: 'Pottur',
      store: 'Amazon',
      url: 'https://www.amazon.de/dp/B000KITCHEN',
      price: 67499,
      currency: 'EUR',
      originalPrice: 449.99,
      imageUrl: 'https://m.media-amazon.com/images/I/kitchenaid.jpg',
    },
    { name: 'Óaðgengilegt', store: 'HT', url: 'https://ht.is/vara/pottur', price: 49990, currency: 'ISK', originalPrice: 49990, imageUrl: '' },
  ]);
  assert.ok(!d.fetchImpl.calls.some(([u]) => u.includes('duckduckgo')));
});

test('AI finds nothing / errors → falls back to keyless search, keeping the AI error message', async () => {
  const q = 'Le Creuset pottur 24cm';
  const routes = { [duckDuckGoUrl(q)]: fixture('ddg-results.html'), [KOKKA_URL]: fixture('kokka-jsonld.html') };

  const empty = await lookupProduct(q, deps(routes, { anthropicClient: fakeClient([report([])]) }));
  assert.equal(empty.source, 'search');
  assert.equal(empty.message, undefined);
  assert.equal(empty.results[0].price, 54990);

  const failing = fakeClient([Object.assign(new Error('nope'), { name: 'Error' })]);
  const errored = await lookupProduct(q, deps(routes, { anthropicClient: failing }));
  assert.equal(errored.source, 'search');
  assert.equal(errored.message, 'Gervigreindarleit mistókst.');

  const both = await lookupProduct('ekkert', deps({}, { anthropicClient: fakeClient([new Error('x')]) }));
  assert.equal(both.source, 'none');
  assert.equal(both.message, `Gervigreindarleit mistókst. ${NOTHING_FOUND_MESSAGE}`);
});

test('dedupeResults merges duplicates by URL and caps at 6', () => {
  const base = { name: 'a', store: 's', price: null, currency: 'ISK', originalPrice: null, imageUrl: '' };
  const list = [
    { ...base, url: 'https://www.kokka.is/a/' },
    { ...base, url: 'http://kokka.is/a?utm_source=x', price: 5, originalPrice: 5, imageUrl: 'https://i/x.jpg' },
    ...Array.from({ length: 8 }, (_, i) => ({ ...base, url: `https://s${i}.is/p` })),
  ];
  const out = dedupeResults(list);
  assert.equal(out.length, MAX_RESULTS);
  assert.equal(out[0].price, 5);
  assert.equal(out[0].imageUrl, 'https://i/x.jpg');
  assert.equal(cleanUrl('https://a.is/x?id=1&utm_medium=y&gclid=z#top'), 'https://a.is/x?id=1');
});
