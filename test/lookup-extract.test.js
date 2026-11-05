import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProduct,
  parseProductHtml,
  resolveUrl,
  stripSiteSuffix,
  nameFromUrlSlug,
  shopifyJsonUrl,
} from '../server/lookup/extract.js';
import { assertPublicUrl, isPrivateIp, safeFetch, LookupFetchError } from '../server/lookup/net.js';
import { storeNameFromUrl, isIcelandicHost } from '../server/lookup/stores.js';
import { fixture, fakeFetch, fakeDns } from './fixtures/lookup-helpers.js';

const dnsLookup = fakeDns();

// ---- JSON-LD ------------------------------------------------------------------------

test('JSON-LD @graph product with ISK offer wins over meta tags and related products', async () => {
  const url = 'https://kokka.is/vara/le-creuset-pottur-24';
  const fetchImpl = fakeFetch({ [url]: fixture('kokka-jsonld.html') });
  const r = await extractProduct(url, { fetchImpl, dnsLookup });
  assert.deepEqual(r, {
    name: 'Le Creuset steypujárnspottur 24 cm & lok',
    store: 'Kokka',
    url,
    price: 54990,
    currency: 'ISK',
    originalPrice: 54990,
    imageUrl: 'https://kokka.is/media/catalog/le-creuset-24.jpg',
  });
  const [, init] = fetchImpl.calls[0];
  assert.equal(init.headers['Accept-Language'], 'is,en;q=0.8');
  assert.match(init.headers['User-Agent'], /Mozilla\/5\.0/);
  assert.equal(init.redirect, 'manual');
  assert.ok(init.signal instanceof AbortSignal);
});

test('JSON-LD variants: array @type, schema.org URL type, AggregateOffer, ImageObject arrays, raw newlines', () => {
  const html = `<script type="application/ld+json">
    {"@type":"http://schema.org/Product","name":"Hrærivél
    Artisan","image":[{"@type":"ImageObject","contentUrl":"//cdn.example.com/a.jpg"},"https://x/b.jpg"],
     "offers":{"@type":"AggregateOffer","lowPrice":"89.990","highPrice":"99990","priceCurrency":"ISK"}}
  </script>`;
  const p = parseProductHtml(html, 'https://heimkaup.is/hraerivel');
  assert.equal(p.name, 'Hrærivél Artisan');
  assert.equal(p.amount, 89990);
  assert.equal(p.currency, 'ISK');
  assert.equal(p.imageUrl, 'https://cdn.example.com/a.jpg');
});

test('JSON-LD Offer[] takes the lowest price; ProductGroup uses its variants', () => {
  const offers = `<script type="application/ld+json">[{"@type":["Product","Thing"],"name":"Sængurver",
    "offers":[{"@type":"Offer","price":"14990","priceCurrency":"ISK"},{"@type":"Offer","priceSpecification":{"price":12990,"priceCurrency":"ISK"}}]}]</script>`;
  assert.equal(parseProductHtml(offers, 'https://dorma.is/x').amount, 12990);

  const group = `<script type="application/ld+json">{"@type":"ProductGroup","name":"Bolli","hasVariant":[
    {"@type":"Product","name":"Bolli blár","image":"/b.jpg","offers":{"@type":"Offer","price":"3490","priceCurrency":"ISK"}}]}</script>`;
  const p = parseProductHtml(group, 'https://hrim.is/bolli');
  assert.equal(p.name, 'Bolli');
  assert.equal(p.amount, 3490);
  assert.equal(p.imageUrl, 'https://hrim.is/b.jpg');
});

test('foreign currency is converted to ISK and keeps originalPrice/currency', async () => {
  const url = 'https://www.amazon.de/dp/B000KITCHEN';
  const r = await extractProduct(url, { fetchImpl: fakeFetch({ [url]: fixture('amazon-eur.html') }), dnsLookup });
  assert.equal(r.store, 'Amazon');
  assert.equal(r.name, 'KitchenAid Artisan 5KSM175 Küchenmaschine');
  assert.equal(r.currency, 'EUR');
  assert.equal(r.originalPrice, 449.99);
  assert.equal(r.price, 67499);
  assert.equal(r.imageUrl, 'https://m.media-amazon.com/images/I/kitchenaid.jpg');
});

// ---- meta tags / visible price -------------------------------------------------------------

test('meta-only page: og tags + "12.990 kr." in a .price element, skipping the old price', async () => {
  const url = 'https://www.epal.is/vorur/hammershoi-vasi';
  const r = await extractProduct(url, { fetchImpl: fakeFetch({ [url]: fixture('epal-meta.html') }), dnsLookup });
  assert.equal(r.name, 'Kähler Hammershøi vasi');
  assert.equal(r.store, 'Epal');
  assert.equal(r.price, 12990);
  assert.equal(r.currency, 'ISK');
  assert.equal(r.imageUrl, 'https://www.epal.is/images/products/hammershoi-vasi.jpg');
});

test('meta price tags and itemprop microdata', () => {
  const meta = `<meta property="og:title" content="Rúmföt | Rúmfatalagerinn"><meta property="og:site_name" content="Rúmfatalagerinn">
    <meta property="product:price:amount" content="7.990"><meta property="product:price:currency" content="ISK">
    <meta name="twitter:image" content="https://cdn.rl.is/r.jpg">`;
  const a = parseProductHtml(meta, 'https://rumfatalagerinn.is/rumfot');
  assert.equal(a.name, 'Rúmföt');
  assert.equal(a.amount, 7990);
  assert.equal(a.currency, 'ISK');
  assert.equal(a.imageUrl, 'https://cdn.rl.is/r.jpg');

  const micro = `<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Lampi</span>
    <img itemprop="image" src="img/lampi.png"><span itemprop="price" content="24990.00">24.990 kr.</span>
    <meta itemprop="priceCurrency" content="ISK"></div>`;
  const b = parseProductHtml(micro, 'https://modern.is/vara/lampi/');
  assert.equal(b.name, 'Lampi');
  assert.equal(b.amount, 24990);
  assert.equal(b.currency, 'ISK');
  assert.equal(b.imageUrl, 'https://modern.is/vara/lampi/img/lampi.png');
});

test('name falls back to <h1>, then <title> without the store suffix', () => {
  assert.equal(parseProductHtml('<title>X | Búð</title><h1> Kertastjaki  úr messing </h1>', 'https://a.is/').name, 'Kertastjaki úr messing');
  assert.equal(parseProductHtml('<title>Kertastjaki úr messing | Búðin</title>', 'https://a.is/').name, 'Kertastjaki úr messing');
  assert.equal(parseProductHtml('<title>Kertastjaki - stór - Búðin</title>', 'https://a.is/').name, 'Kertastjaki - stór');
  assert.equal(stripSiteSuffix('Pottur – ELKO', ['ELKO']), 'Pottur');
  assert.equal(stripSiteSuffix('Pottur - stór', ['ELKO']), 'Pottur - stór');
});

// ---- Shopify -------------------------------------------------------------------------------

test('Shopify fallback fetches <product>.js and divides the minor-unit price by 100', async () => {
  const url = 'https://www.litlabudin.is/products/ilmkerti-fikja?variant=4242';
  const fetchImpl = fakeFetch({
    [url]: fixture('shopify.html'),
    'https://www.litlabudin.is/products/ilmkerti-fikja.js': {
      body: fixture('shopify-product.json'),
      headers: { 'content-type': 'application/json' },
    },
  });
  const r = await extractProduct(url, { fetchImpl, dnsLookup });
  assert.equal(r.name, 'Ilmkerti – Fíkja');
  assert.equal(r.store, 'Litla búðin'); // from og:site_name
  assert.equal(r.price, 4590);
  assert.equal(r.currency, 'ISK');
  assert.equal(r.imageUrl, 'https://cdn.shopify.com/s/files/1/0000/products/ilmkerti-fikja.jpg');
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(shopifyJsonUrl('https://x.is/collections/a'), '');
});

// ---- helpers -------------------------------------------------------------------------------

test('store names: known Icelandic hosts, Amazon, og:site_name, hostname fallback', () => {
  assert.equal(storeNameFromUrl('https://elko.is/vara/1'), 'ELKO');
  assert.equal(storeNameFromUrl('https://www.husa.is/x'), 'Húsasmiðjan');
  assert.equal(storeNameFromUrl('https://verslun.kokka.is/x'), 'Kokka');
  assert.equal(storeNameFromUrl('https://www.betrabak.is/x'), 'Betra Bak');
  assert.equal(storeNameFromUrl('https://tekk.is/x'), 'Tekk Company');
  assert.equal(storeNameFromUrl('https://heimilistaeki.is/x'), 'Heimilistæki');
  assert.equal(storeNameFromUrl('https://www.amazon.co.uk/dp/1'), 'Amazon');
  assert.equal(storeNameFromUrl('https://www.amazon.com/dp/1'), 'Amazon');
  assert.equal(storeNameFromUrl('https://nyverslun.is/x', 'Ný verslun'), 'Ný verslun');
  assert.equal(storeNameFromUrl('https://www.nyverslun.is/x'), 'Nyverslun.is');
  assert.equal(storeNameFromUrl('https://ht.is/x', 'Something else'), 'HT');
  assert.ok(isIcelandicHost('kokka.is'));
  assert.ok(!isIcelandicHost('amazon.de'));
});

test('resolveUrl: relative, root-relative, protocol-relative and unsafe values', () => {
  const base = 'http://kokka.is/vara/pottur/';
  assert.equal(resolveUrl('img/a.jpg', base), 'http://kokka.is/vara/pottur/img/a.jpg');
  assert.equal(resolveUrl('/media/a.jpg', base), 'http://kokka.is/media/a.jpg');
  assert.equal(resolveUrl('//cdn.kokka.is/a.jpg', base), 'https://cdn.kokka.is/a.jpg');
  assert.equal(resolveUrl('https://cdn.x/a.jpg?w=1&amp;h=2', base), 'https://cdn.x/a.jpg?w=1&h=2');
  assert.equal(resolveUrl('data:image/png;base64,AAA', base), '');
  assert.equal(resolveUrl('javascript:alert(1)', base), '');
  assert.equal(resolveUrl('', base), '');
  assert.equal(resolveUrl(undefined, base), '');
});

test('nameFromUrlSlug', () => {
  assert.equal(nameFromUrlSlug('https://kokka.is/vara/le-creuset-pottur-24cm.html'), 'Le creuset pottur 24cm');
  assert.equal(nameFromUrlSlug('https://x.is/products/ilmkerti_fikja/12345'), 'Ilmkerti fikja');
  assert.equal(nameFromUrlSlug('https://x.is/'), '');
});

// ---- SSRF guard / fetching ---------------------------------------------------------------------

test('SSRF guard rejects non-http(s), localhost, private and link-local addresses', async () => {
  const blocked = [
    'http://127.0.0.1/',
    'http://localhost:3000/api',
    'http://LOCALHOST./',
    'http://10.0.0.5/',
    'http://172.16.3.4/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0/',
    'http://2130706433/', // 127.0.0.1 as an integer
    'http://0x7f.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://printer.local/',
    'http://intranet/',
    'http://user:pw@kokka.is/',
    'file:///etc/passwd',
    'ftp://kokka.is/x',
    'javascript:alert(1)',
  ];
  for (const url of blocked) {
    await assert.rejects(assertPublicUrl(url, { dnsLookup }), (err) => err instanceof LookupFetchError && err.code === 'blocked', url);
  }
  await assert.rejects(assertPublicUrl('not a url', { dnsLookup }), { code: 'invalid_url' });
});

test('SSRF guard checks DNS results and accepts public hosts', async () => {
  await assert.rejects(
    assertPublicUrl('https://evil.example.com/', { dnsLookup: fakeDns({ 'evil.example.com': '10.1.2.3' }) }),
    { code: 'blocked' },
  );
  await assert.rejects(
    assertPublicUrl('https://evil6.example.com/', { dnsLookup: fakeDns({ 'evil6.example.com': '::1' }) }),
    { code: 'blocked' },
  );
  await assert.rejects(
    assertPublicUrl('https://nope.example.com/', { dnsLookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } }),
    { code: 'dns' },
  );
  const ok = await assertPublicUrl('https://kokka.is/vara', { dnsLookup });
  assert.equal(ok.href, 'https://kokka.is/vara');
  assert.ok(isPrivateIp('100.64.0.1'));
  assert.ok(!isPrivateIp('8.8.8.8'));
  assert.ok(!isPrivateIp('2a00:1450:4001::1'));
});

test('safeFetch follows redirects but re-checks every hop', async () => {
  const fetchImpl = fakeFetch({
    'https://kokka.is/stutt': { status: 301, headers: { location: '/vara/le-creuset-pottur-24' } },
    'https://kokka.is/vara/le-creuset-pottur-24': fixture('kokka-jsonld.html'),
    'https://kokka.is/illt': { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } },
  });
  const r = await extractProduct('https://kokka.is/stutt', { fetchImpl, dnsLookup });
  assert.equal(r.url, 'https://kokka.is/vara/le-creuset-pottur-24');
  assert.equal(r.price, 54990);
  await assert.rejects(safeFetch('https://kokka.is/illt', { fetchImpl, dnsLookup }), { code: 'blocked' });
  assert.ok(!fetchImpl.calls.some(([u]) => u.includes('127.0.0.1')));
});

test('safeFetch: HTTP errors, timeouts, size cap and latin-1 pages', async () => {
  const fetchImpl = fakeFetch({
    'https://a.is/403': { status: 403, body: 'nope' },
    // AbortSignal.timeout() timers are unref'd, so keep the event loop alive while waiting.
    'https://a.is/slow': (_url, init) =>
      new Promise((_, reject) => {
        const keepAlive = setTimeout(() => {}, 5000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal.reason);
        });
      }),
    'https://a.is/big': 'x'.repeat(5000),
    'https://a.is/latin': () =>
      new Response(Buffer.from('<title>Hr\xe6riv\xe9l</title>', 'latin1'), {
        headers: { 'content-type': 'text/html; charset=iso-8859-1' },
      }),
  });
  await assert.rejects(safeFetch('https://a.is/403', { fetchImpl, dnsLookup }), (e) => e.code === 'http' && /403/.test(e.userMessage));
  await assert.rejects(safeFetch('https://a.is/slow', { fetchImpl, dnsLookup, timeoutMs: 50 }), { code: 'timeout' });
  const big = await safeFetch('https://a.is/big', { fetchImpl, dnsLookup, maxBytes: 1000 });
  assert.equal(big.text.length, 1000);
  const latin = await safeFetch('https://a.is/latin', { fetchImpl, dnsLookup });
  assert.equal(latin.text, '<title>Hrærivél</title>');
});
