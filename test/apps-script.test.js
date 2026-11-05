// Runs apps-script/Code.gs in a sandbox with small fakes of the Google Apps Script services,
// and checks it against the browser backend (public/sheets-backend.js) end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createSheetsBackend } from '../public/sheets-backend.js';

const code = await readFile(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

function fakeSheet(name) {
  const cells = []; // rows of strings
  const set = (r, c, v) => {
    while (cells.length < r) cells.push([]);
    cells[r - 1][c - 1] = v === null || v === undefined ? '' : String(v);
  };
  const lastRow = () => {
    for (let r = cells.length; r > 0; r--) if (cells[r - 1].some((v) => v !== undefined && v !== '')) return r;
    return 0;
  };
  const lastCol = () => Math.max(0, ...cells.map((row) => row.length));
  const range = (r, c, nr = 1, nc = 1) => ({
    setValues(values) {
      values.forEach((row, i) => row.forEach((v, j) => set(r + i, c + j, v)));
      return this;
    },
    setValue(v) {
      set(r, c, v);
      return this;
    },
    getDisplayValue: () => cells[r - 1]?.[c - 1] ?? '',
    clearContent() {
      for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (cells[r - 1 + i]) cells[r - 1 + i][c - 1 + j] = '';
      return this;
    },
    setNumberFormat() {
      return this;
    },
    setFontWeight() {
      return this;
    },
  });
  const a1 = (ref) => {
    const m = /^([A-Z])(\d+)/.exec(ref);
    return [Number(m[2]), m[1].charCodeAt(0) - 64];
  };
  return {
    name,
    cells,
    getRange: (r, c, nr, nc) => (typeof r === 'string' ? range(...a1(r), 1, 2) : range(r, c, nr, nc)),
    getDataRange: () => ({
      getDisplayValues: () =>
        cells.slice(0, Math.max(lastRow(), 1)).map((row) => Array.from({ length: lastCol() }, (_, i) => row[i] ?? '')),
    }),
    getLastRow: lastRow,
    getLastColumn: lastCol,
    setFrozenRows() {},
  };
}

function loadScript({ pages = {} } = {}) {
  const sheets = new Map();
  const props = new Map();
  const cache = new Map();
  const spreadsheet = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => {
      const s = fakeSheet(n);
      sheets.set(n, s);
      return s;
    },
    getSheets: () => [...sheets.values()],
    deleteSheet: (s) => sheets.delete(s.name),
  };
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }),
    },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    UrlFetchApp: {
      fetch: (url) => {
        if (!(url in pages)) throw new Error('DNS error');
        return { getResponseCode: () => 200, getContentText: () => pages[url] };
      },
    },
  });
  vm.runInContext(code, context);
  return { context, sheets };
}

/** fetch() that routes to the script's doGet/doPost, like the deployed web app. */
function webAppFetch(context) {
  return async (url, init = {}) => {
    const out = init.method === 'POST' ? context.doPost({ postData: { contents: init.body } }) : context.doGet({});
    return new Response(out.text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test('setup creates the tabs with default categories and an empty access code', () => {
  const { context, sheets } = loadScript();
  context.setup();
  assert.deepEqual([...sheets.keys()], ['Gjafir', 'Flokkar', 'Stillingar', 'Aðgangur']);
  const data = JSON.parse(context.doGet({}).text);
  assert.equal(data.categories.length, 5);
  assert.equal(data.settings.title, 'Óskalistinn okkar');
  assert.equal(data.version, 0);
  const res = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ action: 'login', code: 'x' }) } }).text);
  assert.equal(res.status, 401);
  assert.match(res.error, /reit B1/);
});

test('the browser backend works end to end against the Apps Script', async () => {
  const page = await readFile(new URL('./fixtures/kokka-jsonld.html', import.meta.url), 'utf8');
  const productUrl = 'https://kokka.is/vorur/pottur';
  const { context, sheets } = loadScript({ pages: { [productUrl]: page } });
  context.setup();
  sheets.get('Aðgangur').getRange('B1').setValue('leyndó kóði');

  const backend = createSheetsBackend({ url: 'https://script.google.com/macros/s/x/exec' }, { fetchImpl: webAppFetch(context) });
  await assert.rejects(backend.request('/api/admin/login', { method: 'POST', body: { code: 'rangt' } }), { status: 401 });
  await backend.request('/api/admin/login', { method: 'POST', body: { code: 'leyndó kóði' } });

  const found = await backend.request('/api/lookup', { method: 'POST', body: { query: productUrl } });
  assert.equal(found.results[0].store, 'Kokka');

  const item = await backend.request('/api/items', {
    method: 'POST',
    body: {
      name: '=HYPERLINK("x")', // must stay plain text in the sheet
      categoryId: 'eldhusid',
      favorite: true,
      offers: [{ store: 'Kokka', url: productUrl, price: found.results[0].price }],
      imageUrl: found.results[0].imageUrl,
    },
  });
  await backend.request(`/api/items/${item.id}/purchased`, { method: 'POST', body: { purchased: true } });
  await backend.request('/api/categories', { method: 'POST', body: { name: 'Útivist', icon: '⛺' } });
  await backend.request('/api/settings', { method: 'PUT', body: { title: 'Jól 2026', intro: 'Halló!' } });

  // What a guest sees now:
  const guest = createSheetsBackend({ url: 'https://script.google.com/macros/s/x/exec' }, { fetchImpl: webAppFetch(context) });
  const list = await guest.request('/api/list');
  assert.equal(list.settings.title, 'Jól 2026');
  assert.equal(list.settings.intro, 'Halló!');
  assert.ok(list.categories.some((c) => c.id === 'utivist' && c.icon === '⛺'));
  assert.equal(list.categories.at(-1).id, 'annad');
  assert.equal(list.items.length, 1);
  const saved = list.items[0];
  assert.equal(saved.name, '=HYPERLINK("x")');
  assert.equal(saved.price, found.results[0].price);
  assert.equal(saved.purchased, true);
  assert.equal(saved.favorite, true);
  assert.ok(saved.purchasedAt);
  assert.deepEqual(saved.offers, [{ store: 'Kokka', url: productUrl, price: found.results[0].price }]);

  // The sheet is readable for people too.
  const rows = sheets.get('Gjafir').getDataRange().getDisplayValues();
  assert.deepEqual(rows[0].slice(0, 5), ['id', 'Nafn', 'Lýsing', 'Flokkur', 'Verð (kr.)']);
  assert.equal(rows[1][8], 'já');
});

test('hand edits in the sheet show up on the site, and stale saves are rejected', async () => {
  const { context, sheets } = loadScript();
  context.setup();
  sheets.get('Aðgangur').getRange('B1').setValue('kóði123');
  sheets.get('Gjafir').getRange(2, 1, 1, 9).setValues([['abc12345', 'Handskrifuð gjöf', '', 'annad', '4.990 kr.', '', '', 'x', '']]);
  const data = JSON.parse(context.doGet({}).text);
  assert.equal(data.items[0].name, 'Handskrifuð gjöf');
  assert.equal(data.items[0].price, 4990);
  assert.equal(data.items[0].favorite, true);
  assert.deepEqual(data.items[0].offers, []);

  const stale = JSON.parse(
    context.doPost({ postData: { contents: JSON.stringify({ action: 'save', code: 'kóði123', version: 99, data }) } }).text,
  );
  assert.equal(stale.status, 409);
});

test('too many wrong codes are rate limited', () => {
  const { context, sheets } = loadScript();
  context.setup();
  sheets.get('Aðgangur').getRange('B1').setValue('rétt');
  const tryCode = (c) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ action: 'login', code: c }) } }).text);
  for (let i = 0; i < 20; i++) assert.equal(tryCode('rangt').status, 401);
  assert.equal(tryCode('rétt').status, 429);
});
