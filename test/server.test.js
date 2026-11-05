import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { COOKIE_NAME, createAuth, resolveAdminCode } from '../server/auth.js';
import { createStore, DATA_FILE_NAME } from '../server/store.js';

const ADMIN_CODE = 'leynikodi-123';

let dataDir;
let baseUrl;
let adminCookie;
const lookupCalls = [];

/** Fake lookup: "villa" makes it throw, anything else returns one result. */
async function fakeLookup(query, options) {
  lookupCalls.push({ query, options });
  if (query === 'villa') throw new Error('upstream down');
  return {
    results: [{ name: `Niðurstaða: ${query}`, store: 'Kokka', url: 'https://kokka.is/x', price: 4990, currency: 'ISK', originalPrice: null, imageUrl: '' }],
    source: 'search',
  };
}

async function startApp({ code = ADMIN_CODE, aiSearchEnabled = () => true, now } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'oskalisti-server-'));
  const store = createStore({ dataDir: dir });
  await store.load();
  const auth = createAuth({ adminCode: code, now });
  const app = createApp({ store, auth, lookup: fakeLookup, aiSearchEnabled });
  const listening = await new Promise((resolve, reject) => {
    const srv = app.listen(0, '127.0.0.1', (error) => (error ? reject(error) : resolve(srv)));
  });
  return { dir, server: listening, baseUrl: `http://127.0.0.1:${listening.address().port}` };
}

async function stopApp(app) {
  await new Promise((resolve) => app.server.close(resolve));
  await rm(app.dir, { recursive: true, force: true });
}

/** fetch wrapper: JSON body in, `{ status, body, headers }` out. */
async function api(method, url, { body, cookie, headers = {}, base = baseUrl } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(cookie && { Cookie: cookie }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

const admin = (method, url, options = {}) => api(method, url, { ...options, cookie: adminCookie });

function sessionCookieFrom(headers) {
  const setCookie = headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return setCookie?.split(';')[0];
}

let mainApp;

before(async () => {
  mainApp = await startApp();
  ({ dir: dataDir, baseUrl } = mainApp);
  const res = await api('POST', '/api/admin/login', { body: { code: ADMIN_CODE } });
  assert.equal(res.status, 200);
  adminCookie = sessionCookieFrom(res.headers);
  assert.ok(adminCookie);
});

after(async () => {
  await stopApp(mainApp);
});

test('GET /api/list returns seeded settings and categories', async () => {
  const res = await api('GET', '/api/list');
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.title, 'Óskalistinn okkar');
  assert.deepEqual(res.body.categories.map((c) => c.id), ['eldhusid', 'heimilid', 'hjonarumid', 'bordstofan', 'annad']);
  assert.deepEqual(res.body.items, []);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('login sets a secure-by-default session cookie', async () => {
  const res = await api('POST', '/api/admin/login', { body: { code: `  ${ADMIN_CODE} ` } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { admin: true });
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Max-Age=2592000/);
  assert.match(setCookie, /Path=\//);
  assert.doesNotMatch(setCookie, /Secure/i, 'plain http → no Secure flag');
  assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=\\d+\\.[0-9a-f]{64};`));

  const https = await api('POST', '/api/admin/login', { body: { code: ADMIN_CODE }, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(https.headers.getSetCookie()[0], /; Secure/i, 'behind an https proxy → Secure flag');
});

test('GET /api/admin/me reflects login state and aiSearch', async () => {
  assert.deepEqual((await api('GET', '/api/admin/me')).body, { admin: false, aiSearch: true });
  assert.deepEqual((await admin('GET', '/api/admin/me')).body, { admin: true, aiSearch: true });
  const forged = `${COOKIE_NAME}=${Date.now()}.${'0'.repeat(64)}`;
  assert.deepEqual((await api('GET', '/api/admin/me', { cookie: forged })).body, { admin: false, aiSearch: true });
  assert.deepEqual((await api('GET', '/api/admin/me', { cookie: `${COOKIE_NAME}=rusl` })).body.admin, false);
});

test('wrong or missing code is rejected', async () => {
  const wrong = await api('POST', '/api/admin/login', { body: { code: 'rangt' }, headers: { 'X-Forwarded-For': '198.51.100.1' } });
  assert.equal(wrong.status, 401);
  assert.equal(typeof wrong.body.error, 'string');
  assert.equal(sessionCookieFrom(wrong.headers), undefined);

  const empty = await api('POST', '/api/admin/login', { body: {} });
  assert.equal(empty.status, 400);
});

test('logout clears the cookie', async () => {
  const res = await admin('POST', '/api/admin/logout');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { admin: false });
  const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`));
  assert.match(cleared, /^oskalisti_admin=;/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
});

test('login is rate limited per IP after 10 failures', async () => {
  const attacker = { 'X-Forwarded-For': '203.0.113.7' };
  for (let i = 0; i < 10; i++) {
    const res = await api('POST', '/api/admin/login', { body: { code: `rangt-${i}` }, headers: attacker });
    assert.equal(res.status, 401, `attempt ${i + 1}`);
  }
  const blocked = await api('POST', '/api/admin/login', { body: { code: ADMIN_CODE }, headers: attacker });
  assert.equal(blocked.status, 429, 'even the right code is refused while blocked');
  assert.deepEqual(blocked.body, { error: 'Of margar tilraunir. Reyndu aftur eftir smá stund.' });

  const otherIp = await api('POST', '/api/admin/login', { body: { code: ADMIN_CODE }, headers: { 'X-Forwarded-For': '203.0.113.8' } });
  assert.equal(otherIp.status, 200, 'other IPs are not affected');
});

test('rate limit window expires after 15 minutes', async () => {
  let clock = Date.now();
  const app = await startApp({ now: () => clock });
  try {
    for (let i = 0; i < 10; i++) await api('POST', '/api/admin/login', { body: { code: 'x' }, base: app.baseUrl });
    assert.equal((await api('POST', '/api/admin/login', { body: { code: ADMIN_CODE }, base: app.baseUrl })).status, 429);
    clock += 15 * 60 * 1000 + 1;
    assert.equal((await api('POST', '/api/admin/login', { body: { code: ADMIN_CODE }, base: app.baseUrl })).status, 200);
  } finally {
    await stopApp(app);
  }
});

test('sessions expire after 30 days and die when the code changes', async () => {
  let clock = Date.now();
  const app = await startApp({ now: () => clock });
  try {
    const login = await api('POST', '/api/admin/login', { body: { code: ADMIN_CODE }, base: app.baseUrl });
    const cookie = sessionCookieFrom(login.headers);
    assert.equal((await api('GET', '/api/admin/me', { cookie, base: app.baseUrl })).body.admin, true);
    clock += 31 * 24 * 60 * 60 * 1000;
    assert.equal((await api('GET', '/api/admin/me', { cookie, base: app.baseUrl })).body.admin, false);
  } finally {
    await stopApp(app);
  }

  const otherCode = await startApp({ code: 'annar-kodi' });
  try {
    assert.equal((await api('GET', '/api/admin/me', { cookie: adminCookie, base: otherCode.baseUrl })).body.admin, false);
  } finally {
    await stopApp(otherCode);
  }
});

test('admin-only endpoints return 401 without a session', async () => {
  const endpoints = [
    ['POST', '/api/items'],
    ['PUT', '/api/items/abc'],
    ['DELETE', '/api/items/abc'],
    ['POST', '/api/items/abc/purchased'],
    ['POST', '/api/categories'],
    ['PUT', '/api/categories/eldhusid'],
    ['DELETE', '/api/categories/eldhusid'],
    ['PUT', '/api/settings'],
    ['POST', '/api/lookup'],
  ];
  for (const [method, url] of endpoints) {
    const res = await api(method, url, { body: { name: 'x', purchased: true, query: 'x' } });
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.deepEqual(res.body, { error: 'Aðgangur ekki leyfður' });
  }
  const list = await api('GET', '/api/list');
  assert.equal(list.body.categories.length, 5, 'nothing was changed');
});

test('item CRUD', async () => {
  const created = await admin('POST', '/api/items', {
    body: {
      name: 'Le Creuset pottur 24 cm',
      description: 'Helst í dökkbláu',
      categoryId: 'eldhusid',
      imageUrl: 'https://kokka.is/pottur.jpg',
      offers: [
        { store: 'Kokka', url: 'https://kokka.is/pottur', price: 54990 },
        { store: 'Byggt og búið', url: 'https://byggtogbuid.is/pottur', price: 52990 },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'Le Creuset pottur 24 cm');
  assert.equal(created.body.price, 52990, 'price = min(offer prices)');
  assert.equal(created.body.purchased, false);
  assert.equal(created.body.purchasedAt, null);

  const { id } = created.body;
  const updated = await admin('PUT', `/api/items/${id}`, { body: { favorite: true, price: 50000 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.favorite, true);
  assert.equal(updated.body.price, 50000);
  assert.equal(updated.body.description, 'Helst í dökkbláu');

  const list = await api('GET', '/api/list');
  assert.deepEqual(list.body.items.find((item) => item.id === id), updated.body);

  assert.deepEqual((await admin('DELETE', `/api/items/${id}`)).body, { ok: true });
  assert.equal((await admin('DELETE', `/api/items/${id}`)).status, 404);
  assert.equal((await admin('PUT', `/api/items/${id}`, { body: { name: 'x' } })).status, 404);
  assert.ok(!(await api('GET', '/api/list')).body.items.some((item) => item.id === id));
});

test('item validation errors are 400 with an Icelandic message', async () => {
  const noName = await admin('POST', '/api/items', { body: { description: 'ekkert nafn' } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error, 'Nafn á hlut vantar.');

  const badPrice = await admin('POST', '/api/items', { body: { name: 'X', price: -1 } });
  assert.equal(badPrice.status, 400);

  const badJson = await admin('POST', '/api/items', { body: '{ "name": ' });
  assert.equal(badJson.status, 400);
  assert.equal(typeof badJson.body.error, 'string');

  const tooLarge = await admin('POST', '/api/items', { body: { name: 'x'.repeat(200 * 1024) } });
  assert.equal(tooLarge.status, 413);
});

test('unsafe URLs are stripped', async () => {
  const res = await admin('POST', '/api/items', {
    body: {
      name: 'Hættulegt',
      imageUrl: 'javascript:alert(document.cookie)',
      offers: [{ store: 'Vond búð', url: 'javascript:alert(1)', price: 1000 }, { store: 'Góð', url: 'https://good.is/', price: null }],
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.imageUrl, '');
  assert.deepEqual(res.body.offers, [
    { store: 'Vond búð', url: '', price: 1000 },
    { store: 'Góð', url: 'https://good.is/', price: null },
  ]);
  const updated = await admin('PUT', `/api/items/${res.body.id}`, { body: { imageUrl: 'data:image/svg+xml,<svg onload=alert(1)>' } });
  assert.equal(updated.body.imageUrl, '');
});

test('purchased toggle sets and clears purchasedAt', async () => {
  const { body: item } = await admin('POST', '/api/items', { body: { name: 'Sængurver' } });
  const bought = await admin('POST', `/api/items/${item.id}/purchased`, { body: { purchased: true } });
  assert.equal(bought.status, 200);
  assert.equal(bought.body.purchased, true);
  assert.ok(Date.parse(bought.body.purchasedAt) > 0);

  const unbought = await admin('POST', `/api/items/${item.id}/purchased`, { body: { purchased: false } });
  assert.equal(unbought.body.purchased, false);
  assert.equal(unbought.body.purchasedAt, null);

  assert.equal((await admin('POST', `/api/items/${item.id}/purchased`, { body: { purchased: 'já' } })).status, 400);
  assert.equal((await admin('POST', `/api/items/${item.id}/purchased`)).status, 400);
  assert.equal((await admin('POST', '/api/items/er-ekki-til/purchased', { body: { purchased: true } })).status, 404);
});

test('categories: create, rename, delete moves items to annad', async () => {
  const created = await admin('POST', '/api/categories', { body: { name: 'Útivist og ferðalög', icon: '⛺' } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { id: 'utivist-og-ferdalog', name: 'Útivist og ferðalög', icon: '⛺' });

  const dup = await admin('POST', '/api/categories', { body: { name: 'Útivist og ferðalög' } });
  assert.equal(dup.body.id, 'utivist-og-ferdalog-2');

  const renamed = await admin('PUT', '/api/categories/utivist-og-ferdalog', { body: { name: 'Útivist', icon: '🏕️' } });
  assert.deepEqual(renamed.body, { id: 'utivist-og-ferdalog', name: 'Útivist', icon: '🏕️' });

  const { body: tent } = await admin('POST', '/api/items', { body: { name: 'Tjald', categoryId: 'utivist-og-ferdalog' } });
  assert.equal(tent.categoryId, 'utivist-og-ferdalog');

  assert.deepEqual((await admin('DELETE', '/api/categories/utivist-og-ferdalog')).body, { ok: true });
  const list = (await api('GET', '/api/list')).body;
  assert.ok(!list.categories.some((c) => c.id === 'utivist-og-ferdalog'));
  assert.equal(list.items.find((item) => item.id === tent.id).categoryId, 'annad');

  const annad = await admin('DELETE', '/api/categories/annad');
  assert.equal(annad.status, 400);
  assert.equal(typeof annad.body.error, 'string');
  assert.equal((await admin('DELETE', '/api/categories/er-ekki-til')).status, 404);
  assert.equal((await admin('PUT', '/api/categories/er-ekki-til', { body: { name: 'x' } })).status, 404);
  assert.equal((await admin('POST', '/api/categories', { body: { name: '  ' } })).status, 400);
});

test('settings update', async () => {
  const res = await admin('PUT', '/api/settings', { body: { title: 'Jólagjafalistinn', intro: 'Velkomin!' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { title: 'Jólagjafalistinn', subtitle: 'Hugmyndir að gjöfum – jól, afmæli, innflutningur og önnur tilefni', intro: 'Velkomin!' });
  assert.deepEqual((await api('GET', '/api/list')).body.settings, res.body);
  assert.equal((await admin('PUT', '/api/settings', { body: { title: '' } })).status, 400);
});

test('lookup route passes the query to the injected lookup', async () => {
  const res = await admin('POST', '/api/lookup', { body: { query: '  Le Creuset pottur  ' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'search');
  assert.equal(res.body.results[0].name, 'Niðurstaða: Le Creuset pottur');
  const call = lookupCalls.at(-1);
  assert.equal(call.query, 'Le Creuset pottur');
  assert.ok(call.options.signal instanceof AbortSignal);
});

test('lookup route validates the query and maps failures to 502', async () => {
  assert.equal((await admin('POST', '/api/lookup', { body: { query: '   ' } })).status, 400);
  assert.equal((await admin('POST', '/api/lookup', { body: {} })).status, 400);
  assert.equal((await admin('POST', '/api/lookup', { body: { query: 'x'.repeat(501) } })).status, 400);

  const failed = await admin('POST', '/api/lookup', { body: { query: 'villa' } });
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.body, { error: 'Leit mistókst. Prófaðu aftur eða settu inn upplýsingar handvirkt.' });
});

test('unknown /api routes give a JSON 404', async () => {
  const res = await api('GET', '/api/er-ekki-til');
  assert.equal(res.status, 404);
  assert.equal(typeof res.body.error, 'string');
  assert.equal((await api('GET', '/api/items')).status, 404);
});

test('changes are persisted to the data file', async () => {
  const { body: item } = await admin('POST', '/api/items', { body: { name: 'Vistað á disk' } });
  const onDisk = JSON.parse(await readFile(path.join(dataDir, DATA_FILE_NAME), 'utf8'));
  assert.ok(onDisk.items.some((saved) => saved.id === item.id));

  const reloaded = await createStore({ dataDir }).getAll();
  assert.deepEqual(reloaded, (await api('GET', '/api/list')).body);
});

test('concurrent API writes do not corrupt the data file', async () => {
  const responses = await Promise.all(
    Array.from({ length: 30 }, (_, i) => admin('POST', '/api/items', { body: { name: `Samtímis ${i}`, price: i * 100 } })),
  );
  assert.ok(responses.every((res) => res.status === 201));
  const onDisk = JSON.parse(await readFile(path.join(dataDir, DATA_FILE_NAME), 'utf8'));
  const names = new Set(onDisk.items.map((item) => item.name));
  for (let i = 0; i < 30; i++) assert.ok(names.has(`Samtímis ${i}`));
});

test('resolveAdminCode: env wins, otherwise generated once and persisted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oskalisti-code-'));
  try {
    assert.deepEqual(
      await resolveAdminCode({ dataDir: dir, env: { ADMIN_CODE: ' kodi ' } }),
      { code: 'kodi', source: 'env', file: path.join(dir, 'admin-code.txt') },
    );

    const first = await resolveAdminCode({ dataDir: dir, env: {} });
    assert.equal(first.source, 'generated');
    assert.match(first.code, /^[a-z2-9]{8}$/);
    assert.equal((await readFile(first.file, 'utf8')).trim(), first.code);

    const second = await resolveAdminCode({ dataDir: dir, env: {} });
    assert.deepEqual(second, { ...first, source: 'file' });

    await writeFile(first.file, 'handvalinn\n');
    assert.equal((await resolveAdminCode({ dataDir: dir, env: {} })).code, 'handvalinn');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
