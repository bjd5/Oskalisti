import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubBackend } from '../public/github-backend.js';
import { seedData } from '../public/shared/listdata.js';

const CONFIG = { owner: 'bjd5', repo: 'Oskalisti', branch: 'main', dataPath: 'public/data/oskalisti.json' };
const CONTENTS = 'https://api.github.com/repos/bjd5/Oskalisti/contents/public/data/oskalisti.json';

/** Minimal fake of the GitHub API + the published Pages copy. */
function fakeGitHub({ conflictsBeforeSuccess = 0 } = {}) {
  const state = { file: JSON.stringify(seedData()), sha: 's1', commits: [], conflicts: conflictsBeforeSuccess };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function fetchImpl(url, init = {}) {
    const auth = init.headers?.Authorization;
    if (url.startsWith('data/oskalisti.json')) return json(200, JSON.parse(state.file));
    if (auth !== 'Bearer good') return json(401, { message: 'Bad credentials' });
    if (url === 'https://api.github.com/repos/bjd5/Oskalisti') return json(200, { permissions: { push: true } });
    if (url.startsWith(CONTENTS) && (init.method || 'GET') === 'GET') {
      return json(200, { sha: state.sha, content: Buffer.from(state.file).toString('base64') });
    }
    if (url === CONTENTS && init.method === 'PUT') {
      const body = JSON.parse(init.body);
      if (state.conflicts > 0) {
        state.conflicts--;
        state.sha += 'x'; // someone else committed in between
        return json(409, {});
      }
      if (body.sha !== state.sha) return json(409, {});
      state.file = Buffer.from(body.content, 'base64').toString('utf8');
      state.sha += '+';
      state.commits.push(body.message);
      return json(200, {});
    }
    return json(404, {});
  }
  return { state, fetchImpl };
}

test('guests read the published copy; admin actions need a valid token', async () => {
  const gh = fakeGitHub();
  const backend = createGitHubBackend(CONFIG, { fetchImpl: gh.fetchImpl });
  const list = await backend.request('/api/list');
  assert.equal(list.categories.length, 5);
  assert.deepEqual(await backend.request('/api/admin/me'), { admin: false, aiSearch: false, backend: 'github' });
  await assert.rejects(backend.request('/api/items', { method: 'POST', body: { name: 'X' } }), { status: 401 });
  await assert.rejects(backend.request('/api/admin/login', { method: 'POST', body: { code: 'bad' } }), { status: 401 });
});

test('admin changes are committed with the shared data rules', async () => {
  const gh = fakeGitHub();
  const backend = createGitHubBackend(CONFIG, { fetchImpl: gh.fetchImpl });
  await backend.request('/api/admin/login', { method: 'POST', body: { code: 'good' } });

  const item = await backend.request('/api/items', {
    method: 'POST',
    body: {
      name: 'Pottur',
      categoryId: 'eldhusid',
      imageUrl: 'javascript:alert(1)',
      offers: [{ store: 'Kokka', url: 'https://kokka.is/p', price: '12.990 kr.' }],
    },
  });
  assert.equal(item.price, 12990); // price = cheapest offer
  assert.equal(item.imageUrl, ''); // unsafe URL stripped

  const bought = await backend.request(`/api/items/${item.id}/purchased`, { method: 'POST', body: { purchased: true } });
  assert.equal(bought.purchased, true);
  assert.ok(bought.purchasedAt);

  await backend.request('/api/categories/eldhusid', { method: 'DELETE' });
  await backend.request(`/api/items/${item.id}`, { method: 'DELETE' });

  assert.deepEqual(gh.state.commits, [
    'Óskalisti: ný gjöf – Pottur',
    'Óskalisti: keypt – Pottur',
    'Óskalisti: eyddi flokki',
    'Óskalisti: eyddi gjöf – Pottur',
  ]);
  const saved = JSON.parse(gh.state.file);
  assert.equal(saved.items.length, 0);
  assert.ok(!saved.categories.some((c) => c.id === 'eldhusid'));
  // Icelandic letters and emoji survive the base64 round trip.
  assert.ok(saved.categories.some((c) => c.name === 'Fyrir heimilið' && c.icon === '🏡'));
});

test('a save that races with another commit is retried', async () => {
  const gh = fakeGitHub({ conflictsBeforeSuccess: 1 });
  const backend = createGitHubBackend(CONFIG, { fetchImpl: gh.fetchImpl });
  await backend.request('/api/admin/login', { method: 'POST', body: { code: 'good' } });
  await backend.request('/api/settings', { method: 'PUT', body: { title: 'Jólagjafir' } });
  assert.equal(JSON.parse(gh.state.file).settings.title, 'Jólagjafir');
  assert.equal(gh.state.commits.length, 1);
});

test('validation errors come back as 400 and lookup without a Claude key explains why', async () => {
  const gh = fakeGitHub();
  const backend = createGitHubBackend(CONFIG, { fetchImpl: gh.fetchImpl });
  await backend.request('/api/admin/login', { method: 'POST', body: { code: 'good' } });
  await assert.rejects(backend.request('/api/items', { method: 'POST', body: { name: '  ' } }), { status: 400 });
  const res = await backend.request('/api/lookup', { method: 'POST', body: { query: 'pottur' } });
  assert.equal(res.source, 'none');
  assert.match(res.message, /Claude API-lykil/);
});

test('lookup uses the shared Claude prompt with the admin key', async () => {
  const gh = fakeGitHub();
  const calls = [];
  class FakeAnthropic {
    constructor(opts) {
      calls.push({ opts });
      this.beta = {
        messages: {
          create: async (params) => {
            calls.push({ params });
            return {
              stop_reason: 'tool_use',
              content: [
                {
                  type: 'tool_use',
                  name: 'report_products',
                  input: { products: [{ name: 'Pottur', store: 'Kokka', url: 'https://kokka.is/p', price_isk: 9990, image_url: null }] },
                },
              ],
            };
          },
        },
      };
    }
  }
  const backend = createGitHubBackend(CONFIG, { fetchImpl: gh.fetchImpl, loadSdk: async () => ({ default: FakeAnthropic }) });
  await backend.request('/api/admin/login', { method: 'POST', body: { code: 'good', claudeKey: 'sk-ant-x' } });
  assert.equal((await backend.request('/api/admin/me')).aiSearch, true);
  const res = await backend.request('/api/lookup', { method: 'POST', body: { query: 'pottur' } });
  assert.equal(res.source, 'ai');
  assert.equal(res.results[0].store, 'Kokka');
  assert.equal(res.results[0].price, 9990);
  assert.equal(calls[0].opts.apiKey, 'sk-ant-x');
  assert.equal(calls[0].opts.dangerouslyAllowBrowser, true);
  assert.equal(calls[1].params.model, 'claude-opus-5-5');
  assert.equal(calls[1].params.fallbacks, 'default');
});
