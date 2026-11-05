import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSheetsBackend } from '../public/sheets-backend.js';
import { seedData } from '../public/shared/listdata.js';

const URL_ = 'https://script.google.com/macros/s/abc/exec';
const CODE = 'grænn kaffibolli';
const kokka = await readFile(new URL('./fixtures/kokka-jsonld.html', import.meta.url), 'utf8');

/** Fake of apps-script/Code.gs: GET = data, POST = { action, code, ... }. */
function fakeAppsScript({ conflictsBeforeSuccess = 0, pages = {} } = {}) {
  const state = { data: seedData(), version: 0, saves: 0, conflicts: conflictsBeforeSuccess, fetched: [] };
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  async function fetchImpl(url, init = {}) {
    assert.ok(url.startsWith(URL_));
    if (!init.method) return json({ ...structuredClone(state.data), version: state.version });
    assert.equal(init.headers['Content-Type'], 'text/plain;charset=utf-8'); // no CORS preflight
    const req = JSON.parse(init.body);
    if (req.code !== CODE) return json({ error: 'Rangur aðgangskóði.', status: 401 });
    if (req.action === 'login') return json({ ok: true });
    if (req.action === 'save') {
      if (state.conflicts > 0) {
        state.conflicts--;
        state.version++;
        return json({ error: 'Einhver annar var að vista á sama tíma.', status: 409 });
      }
      if (req.version !== state.version) return json({ error: 'conflict', status: 409 });
      state.data = req.data;
      state.version++;
      state.saves++;
      return json({ ok: true, version: state.version });
    }
    if (req.action === 'fetch') {
      state.fetched.push(req.url);
      return pages[req.url] ? json({ status: 200, text: pages[req.url] }) : json({ status: 404, text: '' });
    }
    return json({ error: 'Óþekkt aðgerð.', status: 400 });
  }
  return { state, fetchImpl };
}

test('guests can read; admin actions need the access code from the sheet', async () => {
  const gs = fakeAppsScript();
  const backend = createSheetsBackend({ url: URL_ }, { fetchImpl: gs.fetchImpl });
  const list = await backend.request('/api/list');
  assert.equal(list.categories.length, 5);
  assert.deepEqual(await backend.request('/api/admin/me'), { admin: false, aiSearch: false, backend: 'sheets' });
  await assert.rejects(backend.request('/api/items', { method: 'POST', body: { name: 'X' } }), { status: 401 });
  await assert.rejects(backend.request('/api/admin/login', { method: 'POST', body: { code: 'rangt' } }), {
    status: 401,
    message: 'Rangur aðgangskóði.',
  });
  await backend.request('/api/admin/login', { method: 'POST', body: { code: CODE } });
  assert.equal((await backend.request('/api/admin/me')).admin, true);
});

test('changes are saved with the shared data rules', async () => {
  const gs = fakeAppsScript();
  const backend = createSheetsBackend({ url: URL_ }, { fetchImpl: gs.fetchImpl });
  await backend.request('/api/admin/login', { method: 'POST', body: { code: CODE } });
  const item = await backend.request('/api/items', {
    method: 'POST',
    body: { name: 'Pottur', imageUrl: 'javascript:alert(1)', offers: [{ store: 'Kokka', url: 'https://kokka.is/p', price: '12.990 kr.' }] },
  });
  assert.equal(item.price, 12990);
  assert.equal(item.imageUrl, '');
  const bought = await backend.request(`/api/items/${item.id}/purchased`, { method: 'POST', body: { purchased: true } });
  assert.equal(bought.purchased, true);
  await backend.request('/api/settings', { method: 'PUT', body: { title: 'Jólagjafir' } });
  await backend.request('/api/categories/eldhusid', { method: 'DELETE' });
  assert.equal(gs.state.saves, 4);
  assert.equal(gs.state.data.settings.title, 'Jólagjafir');
  assert.ok(!gs.state.data.categories.some((c) => c.id === 'eldhusid'));
  await assert.rejects(backend.request('/api/items', { method: 'POST', body: { name: ' ' } }), { status: 400 });
});

test('a save that races with another save is retried on fresh data', async () => {
  const gs = fakeAppsScript({ conflictsBeforeSuccess: 2 });
  const backend = createSheetsBackend({ url: URL_ }, { fetchImpl: gs.fetchImpl });
  await backend.request('/api/admin/login', { method: 'POST', body: { code: CODE } });
  await backend.request('/api/items', { method: 'POST', body: { name: 'Kerti' } });
  assert.equal(gs.state.data.items.length, 1);
});

test('lookup by link goes through the Apps Script and parses the page here', async () => {
  const productUrl = 'https://kokka.is/vorur/le-creuset-pottur';
  const gs = fakeAppsScript({ pages: { [productUrl]: kokka } });
  const backend = createSheetsBackend({ url: URL_ }, { fetchImpl: gs.fetchImpl });
  await backend.request('/api/admin/login', { method: 'POST', body: { code: CODE } });
  const res = await backend.request('/api/lookup', { method: 'POST', body: { query: productUrl } });
  assert.equal(res.source, 'url');
  assert.equal(res.results[0].store, 'Kokka');
  assert.ok(res.results[0].price > 0);
  assert.ok(res.results[0].imageUrl.startsWith('https://'));
  assert.deepEqual(gs.state.fetched, [productUrl]);

  const missing = await backend.request('/api/lookup', { method: 'POST', body: { query: 'https://kokka.is/ekki-til' } });
  assert.equal(missing.source, 'none');
  assert.match(missing.message, /handvirkt/);
});

test('without a configured Apps Script URL the site explains what is missing', async () => {
  const backend = createSheetsBackend({ url: '' });
  await assert.rejects(backend.request('/api/list'), { status: 503, message: /ekki enn tengd við Google Sheet/ });
});

test('price comparison searches the shops through the Apps Script', async () => {
  const { lifoglistSearch, roanuzBrand, roanuzProduct, kokkaSearch } = await import('./fixtures/shop-pages.js');
  const known = 'https://kunigund.is/global-granmetishnifur-18cm.html';
  const pages = {
    [known]: roanuzProduct({ name: 'Global Nakiri hnífur 18cm', sku: 'GLO-G5', price: 24995 }),
    'https://www.lifoglist.is/leit?q=G-5': lifoglistSearch([
      { name: 'Grænmetishnífur 18cm - G-5', slug: 'graenmetishnifur-18cm-g-5', price: 25980, sku: 'rod1', foreignSku: 'G-5', brand: 'Global' },
    ]),
    'https://byggtogbuid.is/brand/global': roanuzBrand([
      { name: 'Global Nakiri 18cm', sku: 'GLO-G5', urlKey: 'global-nakiri-18cm', price: 23995 },
    ]),
    'https://kokka.is/?s=G-5&post_type=product': kokkaSearch([]),
  };
  const gs = fakeAppsScript({ pages });
  const backend = createSheetsBackend({ url: URL_ }, { fetchImpl: gs.fetchImpl });
  await assert.rejects(backend.request('/api/compare', { method: 'POST', body: { name: 'Global Nakiri' } }), { status: 401 });
  await backend.request('/api/admin/login', { method: 'POST', body: { code: CODE } });
  const res = await backend.request('/api/compare', { method: 'POST', body: { name: 'Global Nakiri hnífur 18cm', url: known } });
  assert.deepEqual(res.offers.map((o) => [o.store, o.price, o.matchCode]), [['Byggt og búið', 23995, 'G-5'], ['Líf og List', 25980, 'G-5']]);
  assert.ok(!gs.state.fetched.includes('https://kunigund.is/brand/global'), 'the shop we already have is skipped');
});

test('"Finna" by name searches the shops first', async () => {
  const { lifoglistSearch } = await import('./fixtures/shop-pages.js');
  const pages = {
    ['https://www.lifoglist.is/leit?q=' + encodeURIComponent('grænmetishnífur 18')]: lifoglistSearch([
      { name: 'Grænmetishnífur 18cm - G-5', slug: 'graenmetishnifur-18cm-g-5', price: 25980, sku: 'rod1', foreignSku: 'G-5', brand: 'Global' },
    ]),
  };
  const gs = fakeAppsScript({ pages });
  const backend = createSheetsBackend({ url: URL_ }, { fetchImpl: gs.fetchImpl });
  await backend.request('/api/admin/login', { method: 'POST', body: { code: CODE } });
  const res = await backend.request('/api/lookup', { method: 'POST', body: { query: 'Global grænmetishnífur 18' } });
  assert.equal(res.source, 'search');
  assert.deepEqual(res.results.map((r) => [r.store, r.price]), [['Líf og List', 25980]]);
});
