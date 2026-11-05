import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const $ = load(html);

test('index.html has no broken attributes (stray quotes)', () => {
  assert.doesNotMatch(html, /=""[a-z]/i, 'an attribute value like class=""x" lost its quotes');
  $('*').each((_, el) => {
    for (const name of Object.keys(el.attribs || {})) assert.match(name, /^[a-z][a-z0-9-]*$/i, `odd attribute "${name}" on <${el.tagName}>`);
  });
});

test('elements the app relies on exist with their classes', () => {
  assert.ok($('#toast').hasClass('toast'));
  for (const id of ['dlg-login', 'dlg-item', 'dlg-categories', 'dlg-settings', 'admin-sort-hint', 'auto-sort-btn', 'compare-btn', 'f-category-hint']) {
    assert.equal($(`#${id}`).length, 1, `#${id}`);
  }
});
