// URL path: fetch a product page (with the SSRF-guarded fetcher) and extract name, price,
// currency, image and store. The parsing itself lives in parse.js.

import { safeFetch } from './net.js';
import { extractProductWith } from './parse.js';

export * from './parse.js';

/**
 * Fetches `url` and extracts a LookupResult. Throws LookupFetchError (with an
 * Icelandic `userMessage`) when the page can't be fetched or the URL is not allowed.
 * Options: { fetchImpl, dnsLookup, signal, timeoutMs }.
 */
export function extractProduct(url, opts = {}) {
  return extractProductWith(safeFetch, url, opts);
}
