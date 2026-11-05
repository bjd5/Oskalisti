// Claude product search (optional, Node server only): prompt, tools and the request loop.
// No SDK import here: the caller passes in an Anthropic client and an error-message function.

import { storeNameFromUrl } from './stores.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const MAX_ITERATIONS = 4;
const MAX_QUERY_LENGTH = 500;

export const REPORT_PRODUCTS_TOOL = Object.freeze({
  name: 'report_products',
  description:
    'Report the product offers you found. Call this exactly once, at the very end, with every offer (an empty list if nothing was found).',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['products'],
    properties: {
      products: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'store', 'url', 'price_isk', 'image_url'],
          properties: {
            name: { type: 'string' },
            store: { type: 'string' },
            url: { type: 'string' },
            price_isk: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            image_url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
      },
    },
  },
});

export const TOOLS = Object.freeze([
  {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: 6,
    user_location: { type: 'approximate', country: 'IS', city: 'Reykjavík', timezone: 'Atlantic/Reykjavik' },
  },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 },
  REPORT_PRODUCTS_TOOL,
]);

// Price policy (documented decision): the model reports price_isk ONLY when the store
// lists the price in ISK. Foreign-currency prices are reported as null rather than
// converted by the model; the orchestrator then fetches the page itself and converts
// with our explicit approximate rates (price.js), keeping currency + originalPrice so
// the UI can show that it is an estimate.
export const SYSTEM_PROMPT = `You help an Icelandic couple keep a gift wishlist that friends and family use when choosing presents for Christmas, birthdays, housewarmings and other occasions. The user message is what they typed when adding an item to the list: usually a short description of a product, often in Icelandic (for example "Le Creuset pottur 24cm" or "KitchenAid hrærivél"), or sometimes a link to a product page.

Your job is to find specific product pages where this item can be bought and report them.

How to search:
- Strongly prefer Icelandic online stores (.is domains) that list prices in ISK (krónur), for example Kokka, Epal, ELKO, Heimkaup, Hagkaup, BYKO, Húsasmiðjan, IKEA (ikea.is), Hrím, Kúnígúnd, Módern, Tekk Company, Línan, Ormsson, HT, Eirvík, Heimilistæki, Rúmfatalagerinn, Dorma, Betra Bak, Snúran, ILVA. Search in Icelandic and in English.
- Use web_fetch on promising product pages to confirm the price and find the main product image when the search results don't show them. Be efficient.
- If the user message is a URL, fetch that page first and report it as the first product; you may then add other stores selling the same product.
- If no Icelandic store sells it, include reputable international stores that ship to Iceland (for example the manufacturer's own shop or Amazon).

What to report (up to 5 distinct offers, best match first, at most one per store):
- url: a specific product page you actually saw in search results or fetched. Never a search page, category page or home page, and never a URL you constructed or guessed.
- price_isk: the current price in ISK exactly as listed on that page, as an integer (for example "54.990 kr." becomes 54990). If the store lists the price in another currency, or you could not see the price, use null. Do not convert currencies and do not estimate.
- image_url: the product's main image URL if you saw it (for example the page's og:image or main product photo), otherwise null. Never invent one.
- name: a short product name, in Icelandic or as the store writes it.
- store: the store's name, for example "Kokka" or "ELKO".

Finish by calling the report_products tool exactly once with all offers (an empty list if you found nothing). The tool call is your answer; do not write a long text reply.`;

/** Request body for one iteration of the loop. */
export function buildRequest(messages, model = DEFAULT_MODEL) {
  return {
    model,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages: [...messages],
  };
}

// ---- output validation ------------------------------------------------------------

function httpUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) return '';
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function cleanString(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Validates the model's products → LookupResult[] (invalid entries dropped/fields nulled). */
export function normalizeAiProducts(products) {
  if (!Array.isArray(products)) return [];
  const out = [];
  for (const p of products) {
    if (!p || typeof p !== 'object') continue;
    const url = httpUrl(p.url);
    const name = cleanString(p.name, 200);
    if (!url || !name) continue;
    const price =
      Number.isInteger(p.price_isk) && p.price_isk > 0 && p.price_isk < 100_000_000 ? p.price_isk : null;
    out.push({
      name,
      store: storeNameFromUrl(url, cleanString(p.store, 100)),
      url,
      price,
      currency: 'ISK',
      originalPrice: price,
      imageUrl: httpUrl(p.image_url),
    });
  }
  return out;
}

/** Fallback when the model answered in text: the last ```json block holding an array or {products}. */
export function parseJsonFallback(text) {
  if (typeof text !== 'string') return [];
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]).reverse();
  for (const block of blocks) {
    try {
      const data = JSON.parse(block);
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.products)) return data.products;
    } catch {
      /* try the next block */
    }
  }
  return [];
}

/**
 * Content to send back after `pause_turn`. Normally the content unchanged; after a
 * mid-output server-side fallback, blocks before the last `fallback` marker that the
 * API says not to echo (thinking, tool_use, unpaired server_tool_use, unknown) are dropped.
 */
export function contentForEcho(content) {
  const blocks = Array.isArray(content) ? content : [];
  const boundary = blocks.map((b) => b?.type).lastIndexOf('fallback');
  if (boundary <= 0) return blocks;
  const before = blocks.slice(0, boundary);
  const resultIds = new Set(before.filter((b) => typeof b?.tool_use_id === 'string').map((b) => b.tool_use_id));
  const keptServerUses = new Set(
    before.filter((b) => b?.type === 'server_tool_use' && resultIds.has(b.id)).map((b) => b.id),
  );
  const kept = before.filter((b) => {
    if (b?.type === 'text') return true;
    if (b?.type === 'server_tool_use') return keptServerUses.has(b.id);
    if (typeof b?.type === 'string' && b.type.endsWith('_tool_result')) return keptServerUses.has(b.tool_use_id);
    return false;
  });
  return [...kept, ...blocks.slice(boundary)];
}

function textOf(content) {
  return (Array.isArray(content) ? content : [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Asks Claude to find offers for `query`.
 * Resolves { results: LookupResult[], message?: string }; never throws for API errors.
 */
export async function runAiLookup(
  query,
  { client, signal, logger = console, model = DEFAULT_MODEL, errorMessage = () => 'Gervigreindarleit mistókst.', maxIterations = MAX_ITERATIONS } = {},
) {
  if (!client) throw new TypeError('aiLookup requires an Anthropic client');
  const messages = [{ role: 'user', content: String(query).slice(0, MAX_QUERY_LENGTH) }];

  try {
    for (let i = 0; i < maxIterations; i++) {
      const response = await client.beta.messages.create(buildRequest(messages, model), signal ? { signal } : undefined);
      const content = Array.isArray(response?.content) ? response.content : [];

      if (response?.stop_reason === 'refusal') {
        logger?.warn?.('[lookup] AI search refused', response.stop_details ?? null);
        return { results: [] };
      }

      const report = content.find((b) => b?.type === 'tool_use' && b.name === 'report_products');
      if (report) return { results: normalizeAiProducts(report.input?.products) };

      if (response?.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: contentForEcho(content) });
        continue;
      }

      // end_turn (or max_tokens) without the tool call: accept a ```json block if present.
      return { results: normalizeAiProducts(parseJsonFallback(textOf(content))) };
    }
    logger?.warn?.('[lookup] AI search gave no answer within the iteration limit');
    return { results: [] };
  } catch (err) {
    logger?.warn?.(`[lookup] AI search failed: ${err?.name || 'Error'}: ${err?.message || err}`);
    return { results: [], message: errorMessage(err) };
  }
}
