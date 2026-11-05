import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createStore,
  DATA_FILE_NAME,
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
  NotFoundError,
  parsePrice,
  sanitizeUrl,
  slugify,
  ValidationError,
} from '../server/store.js';

let rootDir;
let counter = 0;

before(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), 'oskalisti-store-'));
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

/** Fresh store in its own (not yet existing) sub directory. */
async function freshStore() {
  const dataDir = path.join(rootDir, `case-${++counter}`, 'data');
  const store = createStore({ dataDir });
  await store.load();
  return { store, dataDir, file: path.join(dataDir, DATA_FILE_NAME) };
}

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('first load creates the data dir and seeds defaults', async () => {
  const { store, file } = await freshStore();
  const all = await store.getAll();
  assert.deepEqual(all.settings, { ...DEFAULT_SETTINGS });
  assert.deepEqual(all.categories, DEFAULT_CATEGORIES);
  assert.deepEqual(all.items, []);
  assert.deepEqual(await readJson(file), all);
});

test('getAll returns a copy that cannot mutate the store', async () => {
  const { store } = await freshStore();
  const all = await store.getAll();
  all.settings.title = 'Breytt';
  all.categories.length = 0;
  const again = await store.getAll();
  assert.equal(again.settings.title, DEFAULT_SETTINGS.title);
  assert.equal(again.categories.length, DEFAULT_CATEGORIES.length);
});

test('createItem fills defaults and sanitizes input', async () => {
  const { store } = await freshStore();
  const item = await store.createItem({
    id: 'hacked',
    name: '  Le Creuset\n  pottur  ',
    description: 'x'.repeat(1500),
    categoryId: 'eldhusid',
    imageUrl: 'javascript:alert(1)',
    offers: [
      { store: ' Kokka ', url: 'https://kokka.is/pottur', price: '54.990 kr.' },
      { store: 'Vont', url: 'javascript:alert(1)', price: 100 },
      { store: '', url: '' },
      'not an offer',
    ],
    favorite: true,
    createdAt: '1999-01-01T00:00:00.000Z',
  });

  assert.notEqual(item.id, 'hacked');
  assert.match(item.id, /^[0-9a-f]{8}$/);
  assert.equal(item.name, 'Le Creuset pottur');
  assert.equal(item.description.length, 1000);
  assert.equal(item.categoryId, 'eldhusid');
  assert.equal(item.imageUrl, '');
  assert.deepEqual(item.offers, [
    { store: 'Kokka', url: 'https://kokka.is/pottur', price: 54990 },
    { store: 'Vont', url: '', price: 100 },
  ]);
  assert.equal(item.price, 100, 'price falls back to the cheapest offer');
  assert.equal(item.favorite, true);
  assert.equal(item.purchased, false);
  assert.equal(item.purchasedAt, null);
  assert.notEqual(item.createdAt, '1999-01-01T00:00:00.000Z');
  assert.equal(item.createdAt, item.updatedAt);
});

test('createItem validation', async () => {
  const { store } = await freshStore();
  await assert.rejects(store.createItem({}), ValidationError);
  await assert.rejects(store.createItem({ name: '   ' }), ValidationError);
  await assert.rejects(store.createItem({ name: 'A', price: -5 }), ValidationError);
  await assert.rejects(store.createItem({ name: 'A', price: 'ekki tala' }), ValidationError);
  await assert.rejects(store.createItem({ name: 'A', offers: 'nope' }), ValidationError);
  assert.equal((await store.getAll()).items.length, 0, 'failed creates leave no trace');

  const item = await store.createItem({ name: 'A', categoryId: 'er-ekki-til', price: 1234.6 });
  assert.equal(item.categoryId, 'annad');
  assert.equal(item.price, 1235);
  assert.equal(item.name, 'A');
});

test('explicit price wins over offers; null price uses min(offers)', async () => {
  const { store } = await freshStore();
  const offers = [
    { store: 'A', url: 'https://a.is', price: 9000 },
    { store: 'B', url: 'https://b.is', price: 7000 },
    { store: 'C', url: 'https://c.is', price: null },
  ];
  assert.equal((await store.createItem({ name: 'X', price: 8000, offers })).price, 8000);
  assert.equal((await store.createItem({ name: 'Y', price: null, offers })).price, 7000);
  assert.equal((await store.createItem({ name: 'Z', offers: [{ store: 'C', price: null }] })).price, null);
});

test('updateItem patches only given fields', async () => {
  const { store } = await freshStore();
  const created = await store.createItem({ name: 'Bolli', description: 'Hvítur', price: 1500 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = await store.updateItem(created.id, { description: 'Svartur', id: 'nytt', imageUrl: 'http://x.is/a.png' });
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, 'Bolli');
  assert.equal(updated.description, 'Svartur');
  assert.equal(updated.price, 1500);
  assert.equal(updated.imageUrl, 'http://x.is/a.png');
  assert.equal(updated.createdAt, created.createdAt);
  assert.ok(updated.updatedAt > created.updatedAt);

  await assert.rejects(store.updateItem(created.id, { name: '' }), ValidationError);
  await assert.rejects(store.updateItem('nope', { name: 'X' }), NotFoundError);
});

test('setPurchased sets and clears purchasedAt', async () => {
  const { store } = await freshStore();
  const { id } = await store.createItem({ name: 'Rúmföt' });
  const bought = await store.setPurchased(id, true);
  assert.equal(bought.purchased, true);
  assert.ok(!Number.isNaN(Date.parse(bought.purchasedAt)));

  const again = await store.setPurchased(id, true);
  assert.equal(again.purchasedAt, bought.purchasedAt, 'ticking twice keeps the original time');

  const unbought = await store.setPurchased(id, false);
  assert.equal(unbought.purchased, false);
  assert.equal(unbought.purchasedAt, null);
  await assert.rejects(store.setPurchased('nope', true), NotFoundError);
});

test('deleteItem removes the item', async () => {
  const { store } = await freshStore();
  const { id } = await store.createItem({ name: 'Vasi' });
  assert.deepEqual(await store.deleteItem(id), { ok: true });
  assert.equal((await store.getAll()).items.length, 0);
  await assert.rejects(store.deleteItem(id), NotFoundError);
});

test('categories: create with unique slug ids, rename, delete moves items to annad', async () => {
  const { store } = await freshStore();
  const garden = await store.createCategory({ name: 'Þvottahúsið og garðurinn', icon: '🌱' });
  assert.deepEqual(garden, { id: 'thvottahusid-og-gardurinn', name: 'Þvottahúsið og garðurinn', icon: '🌱' });

  const dup = await store.createCategory({ name: 'Þvottahúsið og garðurinn' });
  assert.equal(dup.id, 'thvottahusid-og-gardurinn-2');
  assert.equal(dup.icon, '🎁');

  const kitchen = await store.createCategory({ name: 'Í eldhúsið' });
  assert.equal(kitchen.id, 'i-eldhusid');

  const symbols = await store.createCategory({ name: '!!!' });
  assert.equal(symbols.id, 'flokkur');

  const categories = (await store.getAll()).categories;
  assert.equal(categories.at(-1).id, 'annad', '"Annað" stays last');

  const renamed = await store.updateCategory(garden.id, { name: 'Garðurinn' });
  assert.equal(renamed.id, garden.id, 'renaming keeps the id');
  assert.equal(renamed.name, 'Garðurinn');
  assert.equal(renamed.icon, '🌱');
  await assert.rejects(store.updateCategory(garden.id, { name: ' ' }), ValidationError);
  await assert.rejects(store.updateCategory('nope', { name: 'X' }), NotFoundError);

  const item = await store.createItem({ name: 'Garðslanga', categoryId: garden.id });
  assert.equal(item.categoryId, garden.id);
  assert.deepEqual(await store.deleteCategory(garden.id), { ok: true });
  const all = await store.getAll();
  assert.ok(!all.categories.some((c) => c.id === garden.id));
  assert.equal(all.items.find((i) => i.id === item.id).categoryId, 'annad');

  await assert.rejects(store.deleteCategory('annad'), ValidationError);
  await assert.rejects(store.deleteCategory('nope'), NotFoundError);
  await assert.rejects(store.createCategory({ name: '' }), ValidationError);
});

test('updateSettings', async () => {
  const { store } = await freshStore();
  const settings = await store.updateSettings({ title: '  Afmælið  ', intro: 'Halló', unknown: 'x' });
  assert.deepEqual(settings, { title: 'Afmælið', subtitle: DEFAULT_SETTINGS.subtitle, intro: 'Halló' });
  await assert.rejects(store.updateSettings({ title: '' }), ValidationError);
  assert.equal((await store.getAll()).settings.title, 'Afmælið');
});

test('data persists across store instances', async () => {
  const { store, dataDir } = await freshStore();
  const item = await store.createItem({ name: 'Diskar', price: 12990 });
  await store.setPurchased(item.id, true);
  await store.createCategory({ name: 'Útilegan' });
  await store.updateSettings({ subtitle: 'Takk!' });

  const reloaded = createStore({ dataDir });
  const all = await reloaded.getAll(); // lazily loads
  assert.deepEqual(all, await store.getAll());
  assert.equal(all.items[0].purchased, true);
  assert.equal(all.settings.subtitle, 'Takk!');
});

test('concurrent writes are serialized and never corrupt the file', async () => {
  const { store, dataDir, file } = await freshStore();
  const creates = Array.from({ length: 50 }, (_, i) => store.createItem({ name: `Hlutur ${i}`, price: i }));
  const settings = Array.from({ length: 10 }, (_, i) => store.updateSettings({ intro: `útgáfa ${i}` }));
  const created = await Promise.all(creates);
  await Promise.all(settings);

  // Concurrent updates of the same item: none may be lost.
  const target = created[0];
  await Promise.all([
    store.updateItem(target.id, { description: 'lýsing' }),
    store.updateItem(target.id, { favorite: true }),
    store.setPurchased(target.id, true),
  ]);

  const onDisk = await readJson(file);
  assert.equal(onDisk.items.length, 50);
  assert.equal(new Set(onDisk.items.map((i) => i.id)).size, 50);
  assert.equal(onDisk.settings.intro, 'útgáfa 9');
  const saved = onDisk.items.find((i) => i.id === target.id);
  assert.equal(saved.description, 'lýsing');
  assert.equal(saved.favorite, true);
  assert.equal(saved.purchased, true);
  assert.deepEqual(onDisk, await store.getAll());

  const leftovers = (await readdir(dataDir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no temp files left behind');
});

test('a failed mutation does not block later writes', async () => {
  const { store } = await freshStore();
  await assert.rejects(store.createItem({ name: '' }), ValidationError);
  const item = await store.createItem({ name: 'Í lagi' });
  assert.equal(item.name, 'Í lagi');
});

test('load tolerates hand-edited data and restores the annad category', async () => {
  const dataDir = path.join(rootDir, 'hand-edited');
  await createStore({ dataDir }).load();
  await writeFile(
    path.join(dataDir, DATA_FILE_NAME),
    JSON.stringify({ categories: [{ id: 'eldhusid', name: 'Eldhús', icon: '🍳' }], items: [{ id: 'abc', name: 'Gamalt', categoryId: 'horfinn' }] }),
  );
  const all = await createStore({ dataDir }).getAll();
  assert.deepEqual(all.settings, { ...DEFAULT_SETTINGS });
  assert.deepEqual(all.categories.map((c) => c.id), ['eldhusid', 'annad']);
  assert.equal(all.items[0].categoryId, 'annad');
  assert.deepEqual(all.items[0].offers, []);
});

test('load refuses to overwrite a corrupt data file', async () => {
  const dataDir = path.join(rootDir, 'corrupt');
  await createStore({ dataDir }).load();
  await writeFile(path.join(dataDir, DATA_FILE_NAME), '{ not json');
  await assert.rejects(createStore({ dataDir }).load(), SyntaxError);
  assert.equal(await readFile(path.join(dataDir, DATA_FILE_NAME), 'utf8'), '{ not json');
});

test('helpers: sanitizeUrl, parsePrice, slugify', () => {
  assert.equal(sanitizeUrl('https://kokka.is/vara?id=1'), 'https://kokka.is/vara?id=1');
  assert.equal(sanitizeUrl('  http://a.is  '), 'http://a.is/');
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,hi', 'ftp://a.is', '/relative', 'www.a.is', 42, null]) {
    assert.equal(sanitizeUrl(bad), '', String(bad));
  }
  assert.equal(sanitizeUrl('https://a.is/' + 'x'.repeat(2000)), '');

  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(0), 0);
  assert.equal(parsePrice('12.990 kr.'), 12990);
  assert.equal(parsePrice('12 990'), 12990);
  assert.equal(parsePrice('4990 ISK'), 4990);
  assert.throws(() => parsePrice(-1), ValidationError);
  assert.throws(() => parsePrice('abc'), ValidationError);
  assert.throws(() => parsePrice(Infinity), ValidationError);
  assert.throws(() => parsePrice(true), ValidationError);

  assert.equal(slugify('Hjónarúmið'), 'hjonarumid');
  assert.equal(slugify('Æðardúnn & Þæfð ull'), 'aedardunn-thaefd-ull');
  assert.equal(slugify('Ýmislegt fyrir börnin!'), 'ymislegt-fyrir-bornin');
  assert.equal(slugify('Crème brûlée'), 'creme-brulee');
});
