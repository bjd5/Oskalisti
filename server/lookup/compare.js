// Price comparison: given a product (e.g. "Global Nakiri hnífur 18 cm"), find other Icelandic
// web shops that sell the same product, read the price on each product page and return the
// offers cheapest first.
//
// No API keys: it searches with the public HTML pages of DuckDuckGo and Bing restricted to .is
// sites, then reads each product page with the same parser as the link lookup (parse.js).
// Like parse.js it takes the page fetcher as a parameter, so it runs on the Node server and in
// the browser (bundled into public/vendor/lookup.js, fetching through the Google Apps Script).
// Search engines may change their markup or block automated requests – this is best effort.

import { load } from 'cheerio';
import { extractProductWith } from './parse.js';
import { parseDuckDuckGoResults, decodeDuckDuckGoHref } from './ddg.js';
import { hostOf, isIcelandicHost } from './stores.js';

// Words that say nothing about which product it is.
const STOPWORDS = new Set([
  'og', 'eða', 'með', 'fyrir', 'frá', 'til', 'í', 'á', 'the', 'and', 'with', 'for', 'of', 'a',
  'cm', 'mm', 'ml', 'l', 'stk', 'stykki', 'sett', 'set', 'kr', 'isk', 'vara', 'nýtt', 'new',
]);

// Hosts that are not shops (news, forums, social, marketplaces).
const SKIP_HOSTS = /(^|\.)(mbl|visir|ruv|dv|vb|bland|facebook|instagram|youtube|wikipedia|pinterest|reddit|tiktok|google|bing|duckduckgo)\.[a-z.]+$/;

const MAX_PER_HOST = 2;

/** Lower-case, accent-folded words and numbers of a product name ("24cm" → "24", "cm"). */
export function productTokens(name) {
  const folded = String(name || '')
    .toLowerCase()
    .replace(/þ/g, 'th')
    .replace(/ð/g, 'd')
    .replace(/æ/g, 'ae')
    .replace(/ö/g, 'o')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2');
  const words = folded.split(/[^a-z0-9]+/).filter((w) => w && !STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w)));
  return [...new Set(words)];
}

// Icelandic words inflect ("hnífur", "hnífinn"), so compare on a short stem.
const stem = (w) => (/^\d+$/.test(w) ? w : w.slice(0, Math.max(4, Math.min(w.length, 5))));

/**
 * Whether `candidate` (a product name from another shop) is the same product as `base`:
 * every number in the base name (size, model) must appear, and most of the words must match.
 */
export function isSameProduct(base, candidate) {
  const a = productTokens(base);
  const b = productTokens(candidate);
  if (!a.length || !b.length) return false;
  const bStems = new Set(b.map(stem));
  const numbers = a.filter((w) => /^\d+$/.test(w));
  if (numbers.some((n) => !bStems.has(n))) return false;
  const words = a.filter((w) => !/^\d+$/.test(w));
  if (!words.length) return true;
  const matched = words.filter((w) => bStems.has(stem(w))).length;
  return matched >= Math.max(1, Math.ceil(words.length * 0.6));
}

/** Search query for a product name: its distinctive words, shortest-first noise removed. */
export function comparisonQuery(name) {
  const original = String(name || '').replace(/\s+/g, ' ').trim();
  // Keep the original spelling (search engines handle Icelandic), but drop shop suffixes and colours after " - ".
  return original.replace(/\s[-–|]\s.*$/, '').slice(0, 120);
}

export function searchUrls(query) {
  const q = `${query} site:is`;
  const ddg = new URL('https://html.duckduckgo.com/html/');
  ddg.searchParams.set('q', q);
  ddg.searchParams.set('kl', 'is-is');
  const lite = new URL('https://lite.duckduckgo.com/lite/');
  lite.searchParams.set('q', q);
  lite.searchParams.set('kl', 'is-is');
  const bing = new URL('https://www.bing.com/search');
  bing.searchParams.set('q', q);
  bing.searchParams.set('cc', 'IS');
  bing.searchParams.set('setlang', 'is');
  return [
    { engine: 'duckduckgo', url: ddg.href, parse: parseDuckDuckGoResults },
    { engine: 'duckduckgo-lite', url: lite.href, parse: parseDuckDuckGoLite },
    { engine: 'bing', url: bing.href, parse: parseBingResults },
  ];
}

/** DuckDuckGo lite: result links are `a.result-link` (href direct or a //duckduckgo.com/l/ redirect). */
export function parseDuckDuckGoLite(html) {
  const $ = load(html || '');
  const out = [];
  $('a.result-link').each((_, el) => {
    const url = decodeDuckDuckGoHref($(el).attr('href'));
    if (url) out.push({ url, title: $(el).text().replace(/\s+/g, ' ').trim() });
  });
  return out;
}

/** Bing: organic results are `li.b_algo h2 a`; hrefs may be /ck/a?…&u=a1<base64url of the target>. */
export function parseBingResults(html) {
  const $ = load(html || '');
  const out = [];
  $('li.b_algo h2 a').each((_, el) => {
    const url = decodeBingHref($(el).attr('href'));
    if (url) out.push({ url, title: $(el).text().replace(/\s+/g, ' ').trim() });
  });
  return out;
}

export function decodeBingHref(href) {
  if (typeof href !== 'string' || !href.trim()) return '';
  try {
    const u = new URL(href.trim(), 'https://www.bing.com/');
    let target = u.href;
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/')) {
      const encoded = u.searchParams.get('u') || '';
      if (!encoded.startsWith('a1')) return '';
      const b64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      target = new TextDecoder().decode(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0)));
    }
    const t = new URL(target);
    return t.protocol === 'http:' || t.protocol === 'https:' ? t.href : '';
  } catch {
    return '';
  }
}

/** Icelandic shop pages only, at most MAX_PER_HOST per shop, skipping `excludeHosts`. */
export function pickShopCandidates(results, { excludeHosts = [], max = 10 } = {}) {
  const perHost = new Map();
  const seen = new Set();
  const picked = [];
  for (const r of results) {
    const host = hostOf(r.url);
    if (!host || !isIcelandicHost(host) || SKIP_HOSTS.test(host) || excludeHosts.includes(host)) continue;
    const key = r.url.replace(/[?#].*$/, '');
    if (seen.has(key) || (perHost.get(host) || 0) >= MAX_PER_HOST) continue;
    seen.add(key);
    perHost.set(host, (perHost.get(host) || 0) + 1);
    picked.push(r);
    if (picked.length >= max) break;
  }
  return picked;
}

/**
 * Finds other Icelandic shops selling `name`.
 * `fetchPage(url, opts) → { url, text }`; `url` is the product page already known (its shop is skipped).
 * Resolves { offers: LookupResult[] (cheapest first, one per shop), searched: number, message? }.
 */
export async function compareWith(fetchPage, { name, url = '' }, { signal, maxCandidates = 10, pageTimeoutMs = 8000, logger = console } = {}) {
  const query = comparisonQuery(name);
  if (productTokens(query).length === 0) {
    return { offers: [], searched: 0, message: 'Skrifaðu heiti vörunnar fyrst, þá get ég borið saman verð.' };
  }
  const excludeHosts = url ? [hostOf(url)].filter(Boolean) : [];

  // 1) Search: try the engines in turn until one gives enough Icelandic shop results.
  let candidates = [];
  for (const engine of searchUrls(query)) {
    if (signal?.aborted) break;
    try {
      const page = await fetchPage(engine.url, { signal, timeoutMs: 10_000 });
      const found = pickShopCandidates(engine.parse(page.text), { excludeHosts, max: maxCandidates });
      const known = new Set(candidates.map((c) => c.url));
      candidates.push(...found.filter((c) => !known.has(c.url)));
      if (candidates.length >= 4) break;
    } catch (err) {
      if (signal?.aborted) throw err;
      logger?.warn?.(`[compare] ${engine.engine} failed: ${err?.message || err}`);
    }
  }
  candidates = candidates.slice(0, maxCandidates);
  if (!candidates.length) {
    return { offers: [], searched: 0, message: 'Fann engar aðrar íslenskar verslanir með þessa vöru.' };
  }

  // 2) Read each product page; keep pages that are the same product and show a price.
  const settled = await Promise.allSettled(
    candidates.map((c) => extractProductWith(fetchPage, c.url, { signal, timeoutMs: pageTimeoutMs })),
  );
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  const best = new Map(); // host → cheapest matching offer
  settled.forEach((s, i) => {
    if (s.status !== 'fulfilled') return;
    const r = s.value;
    const title = r.name || candidates[i].title;
    if (r.price === null || !isSameProduct(query, title)) return;
    const host = hostOf(r.url);
    const prev = best.get(host);
    if (!prev || r.price < prev.price) best.set(host, { ...r, name: title });
  });
  const offers = [...best.values()].sort((a, b) => a.price - b.price);
  return {
    offers,
    searched: candidates.length,
    ...(offers.length ? {} : { message: 'Fann engar aðrar íslenskar verslanir sem selja sömu vöru með verði.' }),
  };
}
