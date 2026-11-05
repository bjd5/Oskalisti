// Outbound HTTP for the lookup: browser-like headers, timeouts, size cap, and a
// basic SSRF guard (only public http(s) hosts; every redirect hop is re-checked).

import { lookup as dnsLookupDefault } from 'node:dns/promises';
import { isIP } from 'node:net';

export const BROWSER_HEADERS = Object.freeze({
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'is,en;q=0.8',
});

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** A fetch/validation failure with an Icelandic message suitable for the admin UI. */
export class LookupFetchError extends Error {
  constructor(code, message, userMessage) {
    super(message);
    this.name = 'LookupFetchError';
    this.code = code; // 'invalid_url' | 'blocked' | 'dns' | 'timeout' | 'http' | 'network' | 'aborted'
    this.userMessage = userMessage;
  }
}

const BLOCKED_MSG = 'Þessi slóð er ekki leyfð (aðeins opinberar http/https vefsíður).';

// ---- IP classification ------------------------------------------------------

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const PRIVATE_V4_CIDRS = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function isPrivateIpv4(ip) {
  const n = ipv4ToInt(ip);
  return PRIVATE_V4_CIDRS.some(([base, mask]) => ((n & mask) >>> 0) === base);
}

/** Expands an IPv6 address to 8 16-bit groups (handles "::" and embedded IPv4). */
function ipv6Groups(ip) {
  let addr = ip.toLowerCase().split('%')[0];
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    addr = addr.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  return [...h, ...Array(Math.max(fill, 0)).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
}

function isPrivateIpv6(ip) {
  const g = ipv6Groups(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return true; // unparsable → be safe
  const allZeroPrefix = (count) => g.slice(0, count).every((x) => x === 0);
  if (allZeroPrefix(7) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d → check the IPv4 part.
  if (allZeroPrefix(5) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    return isPrivateIpv4(v4);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64 (could reach internal v4)
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/** True for loopback, private, link-local, multicast, reserved … addresses. */
export function isPrivateIp(ip) {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true; // not an IP at all → treat as unsafe
}

// ---- URL guard ----------------------------------------------------------------

/**
 * Validates that `input` is an http(s) URL pointing at a public host. Resolves
 * the hostname via DNS and rejects private results. Returns the parsed URL.
 * Note: this is a basic guard – DNS could in theory change between this check
 * and the actual connection (rebinding); acceptable for this app.
 */
export async function assertPublicUrl(input, { dnsLookup = dnsLookupDefault } = {}) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    throw new LookupFetchError('invalid_url', `Invalid URL: ${input}`, 'Ógild slóð.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LookupFetchError('blocked', `Protocol not allowed: ${url.protocol}`, BLOCKED_MSG);
  }
  if (url.username || url.password) {
    throw new LookupFetchError('blocked', 'Credentials in URL not allowed', BLOCKED_MSG);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new LookupFetchError('invalid_url', 'Missing host', 'Ógild slóð.');

  if (isIP(host)) {
    if (isPrivateIp(host)) throw new LookupFetchError('blocked', `Private address: ${host}`, BLOCKED_MSG);
    return url;
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    !host.includes('.')
  ) {
    throw new LookupFetchError('blocked', `Host not allowed: ${host}`, BLOCKED_MSG);
  }

  let addresses;
  try {
    addresses = await dnsLookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new LookupFetchError('dns', `DNS lookup failed for ${host}: ${err.code || err.message}`, 'Fann ekki vefþjóninn – er slóðin rétt?');
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (list.length === 0 || list.some((a) => isPrivateIp(typeof a === 'string' ? a : a?.address))) {
    throw new LookupFetchError('blocked', `Host resolves to a private address: ${host}`, BLOCKED_MSG);
  }
  return url;
}

// ---- fetching -------------------------------------------------------------------

function combineSignals(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function charsetFrom(contentType, headBytes) {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1];
  const head = new TextDecoder('latin1').decode(headBytes.subarray(0, 2048));
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1] : 'utf-8';
}

async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.subarray(0, maxBytes);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (total >= maxBytes) reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= out.length) break;
  }
  return out;
}

function decode(bytes, contentType) {
  const charset = charsetFrom(contentType, bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * GETs `url` with browser-like headers. Follows up to 5 redirects manually so
 * each hop passes the SSRF guard. Bodies are truncated at `maxBytes`.
 * Resolves to { url (final), status, contentType, text }; throws LookupFetchError.
 */
export async function safeFetch(
  url,
  {
    fetchImpl = globalThis.fetch,
    dnsLookup,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    accept,
  } = {},
) {
  const combined = combineSignals(timeoutMs, signal);
  const headers = { ...BROWSER_HEADERS, ...(accept ? { Accept: accept } : {}) };
  let current = String(url);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const checked = new URL(await assertPublicUrl(current, { dnsLookup }));
      checked.hash = ''; // fragments are never sent to the server
      combined.throwIfAborted();
      const res = await fetchImpl(checked.href, { headers, redirect: 'manual', signal: combined });

      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const location = res.headers.get('location');
        res.body?.cancel?.().catch(() => {});
        if (!location) throw new LookupFetchError('http', `Redirect without location (${res.status})`, 'Síðan vísaði áfram á ógilda slóð.');
        current = new URL(location, checked).href;
        continue;
      }
      if (!res.ok) {
        res.body?.cancel?.().catch(() => {});
        throw new LookupFetchError('http', `HTTP ${res.status} for ${checked.href}`, `Vefsíðan svaraði með villu (${res.status}).`);
      }
      const contentType = res.headers.get('content-type') || '';
      const bytes = await readCapped(res, maxBytes);
      return { url: checked.href, status: res.status, contentType, text: decode(bytes, contentType) };
    }
    throw new LookupFetchError('http', 'Too many redirects', 'Síðan vísaði of oft áfram.');
  } catch (err) {
    if (err instanceof LookupFetchError) throw err;
    if (signal?.aborted) throw new LookupFetchError('aborted', 'Aborted', 'Leit hætt.');
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || combined.aborted) {
      throw new LookupFetchError('timeout', `Timed out fetching ${current}`, 'Það tók of langan tíma að sækja síðuna.');
    }
    throw new LookupFetchError('network', `Fetch failed for ${current}: ${err?.message || err}`, 'Náði ekki sambandi við vefsíðuna.');
  }
}
