// Product lookup entry point (see CONTRACT.md → "Lookup module contract").
//
//   lookupProduct(query, { fetchImpl, anthropicClient, signal })
//     → { results: LookupResult[], source: "url"|"ai"|"search"|"none", message? }
//
// Routing:
//   URL       → fetch + extract the page (source "url"); if no price was found and AI
//               search is available, ask Claude about the URL to fill the gaps / add stores.
//   free text → Claude web search when ANTHROPIC_API_KEY is set (source "ai"), results
//               enriched from the actual pages; falls back to the keyless DuckDuckGo search
//               (source "search") when AI is unavailable or finds nothing.

import { aiLookup, createAnthropicClient } from './ai.js';
import { extractProduct, nameFromUrlSlug } from './extract.js';
import { LookupFetchError } from './net.js';
import { searchKeyless } from './search.js';
import { storeNameFromUrl } from './stores.js';

export { parsePrice, toIsk, APPROX_ISK_RATES } from './price.js';
export { storeNameFromUrl } from './stores.js';

export const MAX_RESULTS = 6;
const ENRICH_TIMEOUT_MS = 6000;
const EMPTY_QUERY_MESSAGE = 'Sláðu inn vöruheiti eða hlekk á vöru.';

/** True when ANTHROPIC_API_KEY is configured. */
export function isAiSearchEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}

/** "https://…", "www.kokka.is/…", "kokka.is/vara/x" → true; "Le Creuset pottur 24cm" → false. */
export function looksLikeUrl(query) {
  const s = String(query ?? '').trim();
  if (!s || /\s/.test(s)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^www\./i.test(s)) return true;
  return /^[a-z0-9À-ɏ-]+(\.[a-z0-9À-ɏ-]+)*\.[a-z]{2,24}(:\d+)?([/?#].*)?$/i.test(s);
}

export function normalizeUrlInput(query) {
  const s = String(query).trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|srsltid|_ga|ref_src)$/i;

/** Removes common tracking parameters (utm_*, gclid, srsltid …) and the #fragment. */
export function cleanUrl(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

/** Key for duplicate detection: host without www, path without trailing slash, cleaned query. */
export function urlKey(url) {
  try {
    const u = new URL(cleanUrl(url));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path}${u.search}`;
  } catch {
    return String(url);
  }
}

/** Fills empty fields of `target` from `extra` (price, currency and originalPrice travel together). */
function fillGaps(target, extra) {
  if (!extra) return target;
  if (!target.name && extra.name) target.name = extra.name;
  if (!target.imageUrl && extra.imageUrl) target.imageUrl = extra.imageUrl;
  if (target.price === null && extra.price !== null && extra.price !== undefined) {
    target.price = extra.price;
    target.currency = extra.currency;
    target.originalPrice = extra.originalPrice;
  }
  return target;
}

/** Cleans URLs, merges duplicates (first one wins, gaps filled from later ones) and caps the list. */
export function dedupeResults(results, max = MAX_RESULTS) {
  const byKey = new Map();
  for (const r of results) {
    if (!r || !r.url) continue;
    const item = { ...r, url: cleanUrl(r.url) };
    const key = urlKey(item.url);
    if (byKey.has(key)) fillGaps(byKey.get(key), item);
    else byKey.set(key, item);
  }
  return [...byKey.values()].slice(0, max);
}

/** Fills missing imageUrl / price of AI results from the real pages. Never drops a result. */
export async function enrichResults(results, net, timeoutMs = ENRICH_TIMEOUT_MS) {
  return Promise.all(
    results.map(async (r) => {
      if (r.imageUrl && r.price !== null) return r;
      try {
        const page = await extractProduct(r.url, { ...net, timeoutMs });
        const merged = { ...r };
        if (!merged.imageUrl && page.imageUrl) merged.imageUrl = page.imageUrl;
        if (merged.price === null && page.price !== null) {
          merged.price = page.price;
          merged.currency = page.currency;
          merged.originalPrice = page.originalPrice;
        }
        return merged;
      } catch {
        return r;
      }
    }),
  );
}

function minimalResultFromUrl(url) {
  return {
    name: nameFromUrlSlug(url),
    store: storeNameFromUrl(url),
    url,
    price: null,
    currency: 'ISK',
    originalPrice: null,
    imageUrl: '',
  };
}

function withMessage(response, message) {
  return message ? { ...response, message } : response;
}

async function lookupByUrl(url, { net, client, logger }) {
  let primary;
  let message;
  try {
    primary = await extractProduct(url, net);
  } catch (err) {
    const code = err instanceof LookupFetchError ? err.code : 'unknown';
    if (!(err instanceof LookupFetchError)) logger?.warn?.(`[lookup] extraction failed for ${url}:`, err);
    if (['blocked', 'invalid_url', 'dns', 'aborted'].includes(code)) {
      return { results: [], source: 'none', message: err.userMessage };
    }
    message = `${err.userMessage || 'Náði ekki að lesa síðuna.'} Fylltu inn verð og mynd handvirkt.`;
    primary = minimalResultFromUrl(url);
  }

  let extra = [];
  if (primary.price === null && client) {
    const ai = await aiLookup(url, { client, signal: net.signal, logger });
    const key = urlKey(primary.url);
    const same = ai.results.filter((r) => urlKey(r.url) === key || urlKey(r.url) === urlKey(url));
    same.forEach((r) => fillGaps(primary, r));
    if (same.length && primary.price !== null && message) message = undefined; // AI filled what we couldn't read
    extra = await enrichResults(
      ai.results.filter((r) => !same.includes(r)),
      net,
    );
    if (ai.message && !message) message = ai.message;
  }
  return withMessage({ results: dedupeResults([primary, ...extra]), source: 'url' }, message);
}

/**
 * Looks up price (ISK), store + product URL and image for a product description or URL.
 * Never throws for "not found"; network/API failures become an Icelandic `message`.
 * Extra (optional) deps for tests: `dnsLookup` (node:dns/promises lookup signature), `logger`.
 */
export async function lookupProduct(
  query,
  { fetchImpl = globalThis.fetch, anthropicClient = null, signal, dnsLookup, logger = console } = {},
) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return { results: [], source: 'none', message: EMPTY_QUERY_MESSAGE };

  const net = { fetchImpl, dnsLookup, signal };
  const client = anthropicClient ?? (isAiSearchEnabled() ? createAnthropicClient() : null);

  if (looksLikeUrl(q)) return lookupByUrl(normalizeUrlInput(q), { net, client, logger });

  let aiMessage;
  if (client) {
    const ai = await aiLookup(q, { client, signal, logger });
    if (ai.results.length) {
      const enriched = await enrichResults(ai.results, net);
      return withMessage({ results: dedupeResults(enriched), source: 'ai' }, ai.message);
    }
    aiMessage = ai.message;
  }

  const found = await searchKeyless(q, { ...net, logger });
  const response = { ...found, results: dedupeResults(found.results) };
  if (!aiMessage) return response;
  // Tell the admin why AI search didn't help (e.g. invalid API key).
  return { ...response, message: response.message ? `${aiMessage} ${response.message}` : aiMessage };
}
