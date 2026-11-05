// Keyless free-text fallback: DuckDuckGo's HTML endpoint + the URL extractor.
// Best effort only – DDG may change its markup or block automated requests.

import { safeFetch } from './net.js';
import { searchWith } from './ddg.js';

export * from './ddg.js';

/**
 * Free-text search without an API key.
 * Resolves { results, source: "search" } or { results: [], source: "none", message }.
 */
export function searchKeyless(query, opts = {}) {
  return searchWith(safeFetch, query, opts);
}
