import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDuckDuckGoResults,
  decodeDuckDuckGoHref,
  pickCandidateUrls,
  duckDuckGoUrl,
  searchKeyless,
  NOTHING_FOUND_MESSAGE,
} from '../server/lookup/search.js';
import { fixture, fakeFetch, fakeDns, silentLogger } from './fixtures/lookup-helpers.js';

const dnsLookup = fakeDns();
const QUERY = 'Le Creuset pottur 24cm';

test('decodeDuckDuckGoHref unwraps uddg redirect links', () => {
  assert.equal(
    decodeDuckDuckGoHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fkokka.is%2Fvara%2Fx%3Fa%3D1&rut=abc'),
    'https://kokka.is/vara/x?a=1',
  );
  assert.equal(decodeDuckDuckGoHref('https://epal.is/a'), 'https://epal.is/a');
  assert.equal(decodeDuckDuckGoHref('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)'), '');
  assert.equal(decodeDuckDuckGoHref(''), '');
});

test('parseDuckDuckGoResults skips ads; pickCandidateUrls filters, dedupes hosts and prefers .is', () => {
  const parsed = parseDuckDuckGoResults(fixture('ddg-results.html'));
  assert.equal(parsed.length, 7);
  assert.equal(parsed[0].url, 'https://en.wikipedia.org/wiki/Le_Creuset');
  const picked = pickCandidateUrls(parsed).map((r) => r.url);
  assert.deepEqual(picked, [
    'https://kokka.is/vara/le-creuset-pottur-24',
    'https://www.epal.is/vorur/hammershoi-vasi',
    'https://deadstore.is/vara/pottur',
    'https://www.amazon.de/dp/B000KITCHEN',
  ]);
  assert.equal(pickCandidateUrls(parsed, 2).length, 2);
});

test('duckDuckGoUrl uses the HTML endpoint with the Icelandic region', () => {
  const u = new URL(duckDuckGoUrl(QUERY));
  assert.equal(u.origin + u.pathname, 'https://html.duckduckgo.com/html/');
  assert.equal(u.searchParams.get('q'), QUERY);
  assert.equal(u.searchParams.get('kl'), 'is-is');
});

test('searchKeyless extracts candidate pages and ranks priced .is results first', async () => {
  const fetchImpl = fakeFetch({
    [duckDuckGoUrl(QUERY)]: fixture('ddg-results.html'),
    'https://kokka.is/vara/le-creuset-pottur-24': fixture('kokka-jsonld.html'),
    'https://www.epal.is/vorur/hammershoi-vasi': fixture('epal-meta.html'),
    'https://www.amazon.de/dp/B000KITCHEN': fixture('amazon-eur.html'),
    'https://deadstore.is/vara/pottur': { status: 500, body: 'error' },
  });
  const out = await searchKeyless(QUERY, { fetchImpl, dnsLookup, logger: silentLogger });
  assert.equal(out.source, 'search');
  assert.deepEqual(
    out.results.map((r) => [r.store, r.price]),
    [
      ['Kokka', 54990],
      ['Epal', 12990],
      ['Amazon', 67499],
    ],
  );
  assert.ok(!fetchImpl.calls.some(([u]) => /wikipedia|facebook|adshop/.test(u)));
});

test('searchKeyless returns source "none" with a message when DDG fails or finds nothing usable', async () => {
  const blocked = await searchKeyless(QUERY, { fetchImpl: fakeFetch({}), dnsLookup, logger: silentLogger });
  assert.deepEqual(blocked, { results: [], source: 'none', message: NOTHING_FOUND_MESSAGE });

  const empty = await searchKeyless(QUERY, {
    fetchImpl: fakeFetch({ [duckDuckGoUrl(QUERY)]: '<html><body>No results</body></html>' }),
    dnsLookup,
    logger: silentLogger,
  });
  assert.equal(empty.source, 'none');

  const unusable = await searchKeyless(QUERY, {
    fetchImpl: fakeFetch({
      [duckDuckGoUrl(QUERY)]: fixture('ddg-results.html'),
      'https://kokka.is/vara/le-creuset-pottur-24': '<html><body>Ekkert hér</body></html>',
    }),
    dnsLookup,
    logger: silentLogger,
  });
  assert.equal(unusable.source, 'none');
  assert.equal(unusable.message, NOTHING_FOUND_MESSAGE);
});
