// Keyless free-text fallback: DuckDuckGo's HTML endpoint + the URL extractor.
// Best effort only – DDG may change its markup or block automated requests.

import { load } from 'cheerio';
import { safeFetch } from './net.js';
import { extractProduct } from './extract.js';
import { hostOf, isIcelandicHost } from './stores.js';

export const NOTHING_FOUND_MESSAGE =
  'Fann ekkert sjálfvirkt. Prófaðu að líma inn hlekk á vöruna eða settu inn upplýsingar handvirkt.';

const DDG_URL = 'https://html.duckduckgo.com/html/';

// Hosts that are never product pages (social, wiki, search engines, Icelandic news/forums).
const SKIP_HOST_PATTERN =
  /(^|\.)(wikipedia|wikimedia|facebook|youtube|instagram|pinterest|reddit|twitter|tiktok|linkedin|google|duckduckgo|bing)\.[a-z.]+$/;
const SKIP_HOSTS = new Set(['x.com', 'youtu.be', 'bland.is', 'mbl.is', 'visir.is', 'ruv.is', 'dv.is', 'vb.is']);

function isSkippedHost(host) {
  return SKIP_HOST_PATTERN.test(host) || SKIP_HOSTS.has(host);
}

export function duckDuckGoUrl(query) {
  const u = new URL(DDG_URL);
  u.searchParams.set('q', query);
  u.searchParams.set('kl', 'is-is');
  return u.href;
}

/** Turns a DDG result href (often "//duckduckgo.com/l/?uddg=<encoded>") into the target URL. */
export function decodeDuckDuckGoHref(href) {
  if (typeof href !== 'string' || !href.trim()) return '';
  try {
    const u = new URL(href.trim(), 'https://duckduckgo.com/');
    const target = u.hostname.endsWith('duckduckgo.com') ? u.searchParams.get('uddg') : u.href;
    if (!target) return '';
    const t = new URL(target);
    return t.protocol === 'http:' || t.protocol === 'https:' ? t.href : '';
  } catch {
    return '';
  }
}

/** Parses DDG HTML results → [{ url, title }] in page order (ads skipped). */
export function parseDuckDuckGoResults(html) {
  const $ = load(html || '');
  const out = [];
  $('a.result__a').each((_, el) => {
    const a = $(el);
    if (a.closest('.result--ad, .result--ads').length) return;
    const url = decodeDuckDuckGoHref(a.attr('href'));
    if (url) out.push({ url, title: a.text().replace(/\s+/g, ' ').trim() });
  });
  return out;
}

/**
 * Picks up to `max` candidate URLs: drops non-product hosts and repeats of the same
 * host, then puts .is domains first (stable order otherwise).
 */
export function pickCandidateUrls(results, max = 5) {
  const seenHosts = new Set();
  const picked = [];
  for (const r of results) {
    const host = hostOf(r.url);
    if (!host || seenHosts.has(host) || isSkippedHost(host)) continue;
    seenHosts.add(host);
    picked.push(r);
  }
  const icelandic = picked.filter((r) => isIcelandicHost(hostOf(r.url)));
  const other = picked.filter((r) => !isIcelandicHost(hostOf(r.url)));
  return [...icelandic, ...other].slice(0, max);
}

function rank(result) {
  const is = isIcelandicHost(hostOf(result.url));
  if (result.price !== null && is) return 0;
  if (result.price !== null) return 1;
  if (is) return 2;
  return 3;
}

/**
 * Free-text search without an API key.
 * Resolves { results, source: "search" } or { results: [], source: "none", message }.
 */
export async function searchKeyless(query, { fetchImpl, dnsLookup, signal, maxCandidates = 5, pageTimeoutMs = 8000, logger = console } = {}) {
  let candidates = [];
  try {
    const page = await safeFetch(duckDuckGoUrl(query), { fetchImpl, dnsLookup, signal, timeoutMs: 10_000 });
    candidates = pickCandidateUrls(parseDuckDuckGoResults(page.text), maxCandidates);
  } catch (err) {
    logger?.warn?.(`[lookup] DuckDuckGo search failed: ${err.message}`);
  }
  if (!candidates.length) return { results: [], source: 'none', message: NOTHING_FOUND_MESSAGE };

  const settled = await Promise.allSettled(
    candidates.map(({ url }) => extractProduct(url, { fetchImpl, dnsLookup, signal, timeoutMs: pageTimeoutMs })),
  );
  const results = [];
  settled.forEach((s, i) => {
    if (s.status !== 'fulfilled') return;
    const r = s.value;
    if (!r.name) r.name = candidates[i].title.slice(0, 200);
    if (r.name && (r.price !== null || r.imageUrl)) results.push(r);
  });
  if (!results.length) return { results: [], source: 'none', message: NOTHING_FOUND_MESSAGE };

  // Stable sort: has price & .is first.
  const ranked = results.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
  return { results: ranked, source: 'search' };
}
