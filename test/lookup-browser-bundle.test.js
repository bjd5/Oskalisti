// The browser bundle (public/vendor/lookup.js, cheerio/slim) must parse product pages the
// same way as the server (cheerio). Rebuild it with `npm run build:vendor` after lookup changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { extractProductWith as serverExtract } from '../server/lookup/parse.js';
import { extractProductWith as browserExtract } from '../public/vendor/lookup.js';

const dir = new URL('./fixtures/', import.meta.url);

test('browser bundle extracts the same product data as the server', async () => {
  const pages = (await readdir(dir)).filter((f) => f.endsWith('.html') && !f.startsWith('ddg'));
  assert.ok(pages.length >= 3);
  for (const file of pages) {
    const html = await readFile(new URL(file, dir), 'utf8');
    const url = `https://example.is/products/${file.replace('.html', '')}`;
    const fetchPage = async (u) => {
      if (u === url) return { url, text: html };
      throw new Error('not found');
    };
    assert.deepEqual(await browserExtract(fetchPage, url), await serverExtract(fetchPage, url), file);
  }
});
