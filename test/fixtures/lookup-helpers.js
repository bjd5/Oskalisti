// Shared test helpers for the lookup tests (no network: fake fetch + fake DNS).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name) {
  return readFileSync(join(here, name), 'utf8');
}

/**
 * fetch() stand-in serving `routes` keyed by exact URL. A route is a string (HTML body),
 * { status, body, headers }, or a function (url, init) → one of those / a Response.
 * Unknown URLs get 404. `fetch.calls` records [url, init] pairs.
 */
export function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push([String(url), init]);
    if (init.signal?.aborted) throw init.signal.reason;
    let route = routes[String(url)];
    if (typeof route === 'function') route = await route(String(url), init);
    if (route instanceof Response) return route;
    if (route === undefined) return new Response('Not found', { status: 404 });
    if (typeof route === 'string') route = { body: route };
    return new Response(route.body ?? '', {
      status: route.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...(route.headers || {}) },
    });
  };
  impl.calls = calls;
  return impl;
}

/** DNS stand-in: every host resolves to a public address unless listed in `overrides`. */
export function fakeDns(overrides = {}) {
  return async (host) => [{ address: overrides[host] ?? '93.184.216.34', family: 4 }];
}

export const silentLogger = { warn() {}, info() {}, error() {}, log() {} };
