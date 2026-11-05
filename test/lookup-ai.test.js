import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import {
  aiLookup,
  buildRequest,
  normalizeAiProducts,
  parseJsonFallback,
  contentForEcho,
  SYSTEM_PROMPT,
  DEFAULT_MODEL,
} from '../server/lookup/ai.js';
import { silentLogger } from './fixtures/lookup-helpers.js';

delete process.env.ANTHROPIC_MODEL;

/** Fake SDK client: `beta.messages.create` returns the scripted responses in order (or throws). */
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params, options) => {
          // Snapshot: the loop mutates its own messages array between calls.
          calls.push({ params: structuredClone(params), options });
          const next = script[calls.length - 1];
          if (next === undefined) throw new Error('unexpected extra call');
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
}

const reportBlock = (products) => ({ type: 'tool_use', id: 'toolu_1', name: 'report_products', input: { products } });

const KOKKA = {
  name: 'Le Creuset pottur 24 cm',
  store: 'kokka.is',
  url: 'https://kokka.is/vara/le-creuset-pottur-24',
  price_isk: 54990,
  image_url: 'https://kokka.is/media/le-creuset.jpg',
};

test('request params: model, fallback beta, effort, server tools, strict report tool, no forced tool_choice', () => {
  const p = buildRequest([{ role: 'user', content: 'hæ' }]);
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(DEFAULT_MODEL, 'claude-opus-5-5');
  assert.equal(p.max_tokens, 16000);
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.output_config, { effort: 'medium' });
  assert.ok(!('thinking' in p) && !('temperature' in p) && !('budget_tokens' in p));
  assert.ok(!p.tool_choice || p.tool_choice.type === 'auto');
  const search = p.tools.find((t) => t.name === 'web_search');
  assert.equal(search.type, 'web_search_20260209');
  assert.equal(search.max_uses, 6);
  assert.deepEqual(search.user_location, { type: 'approximate', country: 'IS', city: 'Reykjavík', timezone: 'Atlantic/Reykjavik' });
  assert.equal(p.tools.find((t) => t.name === 'web_fetch').type, 'web_fetch_20260209');
  const report = p.tools.find((t) => t.name === 'report_products');
  assert.equal(report.strict, true);
  assert.equal(report.input_schema.additionalProperties, false);
  assert.deepEqual(report.input_schema.properties.products.items.required, ['name', 'store', 'url', 'price_isk', 'image_url']);
  assert.equal(p.system, SYSTEM_PROMPT);
  assert.match(SYSTEM_PROMPT, /report_products tool exactly once/);
  assert.match(SYSTEM_PROMPT, /Christmas, birthdays, housewarmings/);
  assert.doesNotMatch(SYSTEM_PROMPT, /wedding/i);

  process.env.ANTHROPIC_MODEL = 'claude-test-model';
  try {
    assert.equal(buildRequest([]).model, 'claude-test-model');
  } finally {
    delete process.env.ANTHROPIC_MODEL;
  }
});

test('pause_turn is continued with the assistant content, then report_products ends the loop', async () => {
  const paused = {
    stop_reason: 'pause_turn',
    content: [
      { type: 'text', text: 'Leita…' },
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'Le Creuset pottur' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
    ],
  };
  const done = {
    stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: '', signature: 'x' },
      { type: 'text', text: 'Hér eru niðurstöður.' },
      reportBlock([
        KOKKA,
        { name: 'Pottur', store: 'ELKO', url: 'https://elko.is/vara/pottur', price_isk: null, image_url: null },
        { name: 'Bad', store: 'X', url: 'javascript:alert(1)', price_isk: 1, image_url: null },
        { name: 'Neg', store: 'Y', url: 'https://y.is/a', price_isk: -5, image_url: 'ftp://y.is/a.jpg' },
      ]),
    ],
  };
  const client = fakeClient([paused, done]);
  const controller = new AbortController();
  const out = await aiLookup('Le Creuset pottur 24cm', { client, signal: controller.signal, logger: silentLogger });

  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[0].params.messages, [{ role: 'user', content: 'Le Creuset pottur 24cm' }]);
  assert.deepEqual(client.calls[1].params.messages, [
    { role: 'user', content: 'Le Creuset pottur 24cm' },
    { role: 'assistant', content: paused.content },
  ]);
  assert.equal(client.calls[0].options.signal, controller.signal);
  for (const { params } of client.calls) {
    assert.equal(params.model, 'claude-opus-5-5');
    assert.equal(params.fallbacks, 'default');
    assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(params.output_config.effort, 'medium');
    assert.ok(params.tools.some((t) => t.type === 'web_search_20260209'));
    assert.ok(!params.tool_choice || !['any', 'tool'].includes(params.tool_choice.type));
  }

  assert.deepEqual(out.results, [
    {
      name: 'Le Creuset pottur 24 cm',
      store: 'Kokka',
      url: 'https://kokka.is/vara/le-creuset-pottur-24',
      price: 54990,
      currency: 'ISK',
      originalPrice: 54990,
      imageUrl: 'https://kokka.is/media/le-creuset.jpg',
    },
    { name: 'Pottur', store: 'ELKO', url: 'https://elko.is/vara/pottur', price: null, currency: 'ISK', originalPrice: null, imageUrl: '' },
    { name: 'Neg', store: 'Y', url: 'https://y.is/a', price: null, currency: 'ISK', originalPrice: null, imageUrl: '' },
  ]);
  assert.equal(out.message, undefined);
});

test('refusal returns no results (even if a partial tool_use is present)', async () => {
  const client = fakeClient([
    { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null }, content: [reportBlock([KOKKA])] },
  ]);
  const out = await aiLookup('eitthvað', { client, logger: silentLogger });
  assert.deepEqual(out, { results: [] });
});

test('end_turn without a tool call falls back to a ```json block in the text', async () => {
  const text = 'Fann þetta:\n```json\n{"products": [' + JSON.stringify(KOKKA) + ']}\n```';
  const client = fakeClient([{ stop_reason: 'end_turn', content: [{ type: 'text', text }] }]);
  const out = await aiLookup('pottur', { client, logger: silentLogger });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].price, 54990);

  const plain = fakeClient([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fann ekkert.' }] }]);
  assert.deepEqual(await aiLookup('pottur', { client: plain, logger: silentLogger }), { results: [] });
});

test('stops after 4 iterations of pause_turn', async () => {
  const paused = { stop_reason: 'pause_turn', content: [{ type: 'text', text: '…' }] };
  const client = fakeClient([paused, paused, paused, paused]);
  const out = await aiLookup('pottur', { client, logger: silentLogger });
  assert.equal(client.calls.length, 4);
  assert.deepEqual(out, { results: [] });
});

test('SDK errors become empty results with an Icelandic message', async () => {
  const cases = [
    [new Anthropic.AuthenticationError(401, { error: { type: 'authentication_error' } }, 'invalid x-api-key', new Headers()), 'Gervigreindarleit: ógildur API-lykill.'],
    [new Anthropic.RateLimitError(429, {}, 'rate limited', new Headers()), /of margar fyrirspurnir/],
    [new Anthropic.APIConnectionTimeoutError(), /tók of langan tíma/],
    [new Anthropic.APIConnectionError({ message: 'down' }), /náði ekki sambandi/],
    [new Anthropic.InternalServerError(529, {}, 'overloaded', new Headers()), /upptekin/],
    [new Anthropic.BadRequestError(400, {}, 'bad', new Headers()), /villa í beiðni/],
    [new TypeError('boom'), 'Gervigreindarleit mistókst.'],
  ];
  for (const [error, expected] of cases) {
    const out = await aiLookup('pottur', { client: fakeClient([error]), logger: silentLogger });
    assert.deepEqual(out.results, []);
    if (expected instanceof RegExp) assert.match(out.message, expected);
    else assert.equal(out.message, expected);
  }
});

test('normalizeAiProducts and parseJsonFallback edge cases', () => {
  assert.deepEqual(normalizeAiProducts(null), []);
  assert.deepEqual(normalizeAiProducts([{ name: '', url: 'https://a.is' }]), []);
  assert.equal(normalizeAiProducts([{ ...KOKKA, price_isk: 12.5 }])[0].price, null);
  assert.equal(normalizeAiProducts([{ ...KOKKA, store: '' }])[0].store, 'Kokka');
  assert.equal(normalizeAiProducts([{ ...KOKKA, url: 'https://nyverslun.is/x', store: 'Ný verslun' }])[0].store, 'Ný verslun');
  assert.deepEqual(parseJsonFallback('```json\n[1,2]\n```'), [1, 2]);
  assert.deepEqual(parseJsonFallback('```json\n{bad\n```'), []);
});

test('contentForEcho drops non-echoable blocks before a mid-output fallback marker', () => {
  const content = [
    { type: 'thinking', thinking: '', signature: 's' },
    { type: 'text', text: 'a' },
    { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
    { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
    { type: 'server_tool_use', id: 'srv_2', name: 'web_fetch', input: {} },
    { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
    { type: 'thinking', thinking: '', signature: 't' },
    { type: 'text', text: 'b' },
  ];
  assert.deepEqual(
    contentForEcho(content).map((b) => b.type),
    ['text', 'server_tool_use', 'web_search_tool_result', 'fallback', 'thinking', 'text'],
  );
  const noFallback = [{ type: 'thinking' }, { type: 'text', text: 'x' }];
  assert.deepEqual(contentForEcho(noFallback), noFallback);
});
