// Product page parsing: HTML → name, price, currency, image and store.
// No network or Node APIs: the page fetcher is passed in, so this module also runs in the
// browser (bundled into public/vendor/lookup.js for the Google Sheets backend).

import { load } from 'cheerio';
import { parsePrice, priceFields, normalizeCurrency } from './price.js';
import { storeNameFromUrl, isIcelandicHost } from './stores.js';

const MAX_NAME = 200;

// ---- small helpers -------------------------------------------------------------

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

function cleanText(value, max = MAX_NAME) {
  if (typeof value !== 'string') return '';
  return decodeEntities(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** First string out of a JSON-LD value: string | number | {@value|name} | array of those. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    for (const item of v) {
      const t = textOf(item);
      if (t) return t;
    }
    return '';
  }
  if (v && typeof v === 'object') return textOf(v['@value'] ?? v.name ?? '');
  return '';
}

/**
 * Resolves `src` against `baseUrl`. Protocol-relative "//host/x" becomes https.
 * Returns "" for anything that isn't an http(s) URL (data:, javascript:, …).
 */
export function resolveUrl(src, baseUrl) {
  if (typeof src !== 'string') return '';
  const s = decodeEntities(src.trim());
  if (!s || /^(data|javascript|blob):/i.test(s)) return '';
  try {
    const u = s.startsWith('//') ? new URL(`https:${s}`) : new URL(s, baseUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

const TITLE_SEPARATORS = [' | ', ' - ', ' – ', ' — ', ' :: ', ' · '];

/**
 * Removes a trailing " | Store" / " - Store" part. With `force`, strips the last
 * segment whatever it says (used for <title>); otherwise only when it matches one
 * of `storeNames`.
 */
export function stripSiteSuffix(title, storeNames = [], force = false) {
  const t = cleanText(title, 400);
  if (!t) return '';
  for (const name of storeNames.filter(Boolean)) {
    for (const sep of TITLE_SEPARATORS) {
      const suffix = `${sep}${name}`.toLowerCase();
      if (t.toLowerCase().endsWith(suffix) && t.length > suffix.length) return t.slice(0, -suffix.length).trim();
    }
  }
  if (force) {
    // Prefer the pipe (almost always "Product | Store"), else the last dash-like separator.
    const pipe = t.lastIndexOf(' | ');
    if (pipe > 0) return t.slice(0, pipe).trim();
    let cut = -1;
    for (const sep of TITLE_SEPARATORS.slice(1)) cut = Math.max(cut, t.lastIndexOf(sep));
    if (cut > 0) return t.slice(0, cut).trim();
  }
  return t;
}

// ---- JSON-LD ---------------------------------------------------------------------

function parseJsonLoose(raw) {
  const text = raw
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, '')
    .replace(/\/\*\s*\]\]>\s*\*\/$/, '')
    .trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Raw newlines/tabs inside strings are invalid JSON but common in the wild.
    try {
      return JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' '));
    } catch {
      return null;
    }
  }
}

const PRODUCT_TYPES = new Set(['product', 'productgroup', 'individualproduct', 'productmodel']);
const LIST_TYPES = new Set(['itemlist', 'offercatalog', 'collectionpage', 'searchresultspage']);

function typesOf(node) {
  return toArray(node['@type'])
    .filter((t) => typeof t === 'string')
    .map((t) => t.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase());
}

/** Depth-first walk collecting Product-like nodes; marks those found inside lists (related products). */
function collectProducts(root) {
  const found = [];
  const seen = new Set();
  const walk = (node, depth, inList) => {
    if (depth > 12 || node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, depth + 1, inList));
      return;
    }
    const types = typesOf(node);
    if (types.some((t) => PRODUCT_TYPES.has(t))) found.push({ node, inList });
    const listy = inList || types.some((t) => LIST_TYPES.has(t));
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1, listy || key === 'itemListElement');
    }
  };
  walk(root, 0, false);
  return found;
}

function imageFromLd(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) {
    for (const i of img) {
      const s = imageFromLd(i);
      if (s) return s;
    }
    return '';
  }
  if (typeof img === 'object') return imageFromLd(img.url ?? img.contentUrl ?? img.thumbnailUrl ?? '');
  return '';
}

/** Lowest positive price among Offer | Offer[] | AggregateOffer (incl. nested offers / priceSpecification). */
function bestOffer(offers, depth = 0) {
  let best = null;
  const consider = (amount, currency, seller) => {
    const n = parsePrice(amount);
    if (n === null || n <= 0) return;
    if (!best || n < best.amount) best = { amount: n, currency: normalizeCurrency(textOf(currency)), seller };
  };
  for (const offer of toArray(offers)) {
    if (!offer || typeof offer !== 'object' || depth > 4) continue;
    const seller = cleanText(textOf(offer.seller?.name ?? offer.seller ?? ''), 100);
    const currency = offer.priceCurrency;
    consider(textOf(offer.price), currency, seller);
    consider(textOf(offer.lowPrice), currency, seller);
    for (const spec of toArray(offer.priceSpecification)) {
      if (spec && typeof spec === 'object') consider(textOf(spec.price), spec.priceCurrency ?? currency, seller);
    }
    if (offer.offers) {
      const nested = bestOffer(offer.offers, depth + 1);
      if (nested) consider(nested.amount, nested.currency || currency, nested.seller || seller);
    }
  }
  return best;
}

function productFromLd(node) {
  const variants = toArray(node.hasVariant).filter((v) => v && typeof v === 'object');
  let offer = bestOffer(node.offers);
  if (!offer && variants.length) offer = bestOffer(variants.map((v) => v.offers));
  let image = imageFromLd(node.image);
  if (!image) image = variants.map((v) => imageFromLd(v.image)).find(Boolean) || '';
  return {
    name: cleanText(textOf(node.name)),
    image,
    amount: offer?.amount ?? null,
    currency: offer?.currency ?? '',
    seller: offer?.seller ?? '',
    brand: cleanText(textOf(node.brand?.name ?? node.brand ?? ''), 100),
    // Product identifiers (shop SKU, manufacturer part number, EAN/GTIN) – used to match the
    // same product across shops (compare.js).
    ids: ['sku', 'mpn', 'gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'productID']
      .map((k) => textOf(node[k]))
      .filter(Boolean),
  };
}

// ---- Next.js page data (__NEXT_DATA__) ---------------------------------------------------
// Some Icelandic shops (e.g. Líf og List) render product pages with Next.js and have no
// JSON-LD or price meta tags; the product (name, price, brand, manufacturer SKU) is in the
// embedded page data instead.

const priceOfRecord = (o) =>
  typeof o.price === 'number'
    ? o.price
    : o.price_range?.minimum_price?.final_price?.value ?? null;

/** All product-like records in a Next.js page: objects with a name, a price and an identifier. */
export function nextDataProducts(html) {
  const m = /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html || '');
  if (!m) return [];
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 40) return;
    if (Array.isArray(o)) {
      for (const v of o) walk(v, depth + 1);
      return;
    }
    const price = priceOfRecord(o);
    if (typeof o.name === 'string' && typeof price === 'number' && (o.sku || o.foreignSku)) {
      const key = `${o.sku}|${o.foreignSku}|${o.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          name: cleanText(o.name),
          price,
          currency: o.price_range?.minimum_price?.final_price?.currency || '',
          brand: cleanText(typeof o.brand === 'string' ? o.brand : o.brand?.name || '', 100),
          ids: [o.foreignSku, o.sku, o.ean, o.barcode, o.gtin].filter((v) => typeof v === 'string' && v.trim()),
          slug: typeof o.slug === 'string' ? o.slug : '',
          urlKey: typeof o.url_key === 'string' ? o.url_key : '',
          urlSuffix: typeof o.url_suffix === 'string' ? o.url_suffix : '',
          image:
            (Array.isArray(o.images) && typeof o.images[0]?.url === 'string' && o.images[0].url) ||
            (typeof o.image?.url === 'string' && !/placeholder/.test(o.image.url) ? o.image.url : ''),
          galleryMeta: typeof o.rz_gallery_meta === 'string' ? o.rz_gallery_meta : '',
        });
      }
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(data, 0);
  return out;
}


/** Parses every JSON-LD block and returns the main product's fields, or null. */
export function extractJsonLdProduct($) {
  const products = [];
  $('script').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    if (!type.includes('ld+json')) return;
    const data = parseJsonLoose($(el).text() || '');
    if (data) products.push(...collectProducts(data));
  });
  if (!products.length) return null;
  const parsed = products.map(({ node, inList }) => ({ ...productFromLd(node), inList }));
  // The page's own product: first named one outside an ItemList; related products come last.
  const main = parsed.find((p) => p.name && !p.inList) || parsed.find((p) => p.name) || parsed[0];
  return main;
}

// ---- meta tags / microdata -----------------------------------------------------------

function metaContent($, keys) {
  for (const key of keys) {
    const el = $(`meta[property="${key}"], meta[name="${key}"], meta[itemprop="${key}"]`)
      .filter((_, e) => Boolean(($(e).attr('content') || '').trim()))
      .first();
    if (el.length) return el.attr('content').trim();
  }
  return '';
}

function itempropValue($, prop) {
  const el = $(`[itemprop="${prop}"]`).first();
  if (!el.length) return '';
  return (el.attr('content') || el.attr('src') || el.attr('data-src') || el.attr('href') || el.text() || '').trim();
}

// ---- last-resort price from the visible page ----------------------------------------

const PRICE_WITH_KR = /(\d[\d.,\s  ]*\d|\d)\s*(?:kr\b|kr\.|ISK\b|krónur)|(?:kr\.?|ISK)\s*(\d[\d.,\s  ]*\d|\d)/i;
// Class/id words marking a price that is NOT the current one (old/compare-at price, savings, unit price).
// Must start at a word boundary so e.g. "font-bold" doesn't count as "old".
const NOT_CURRENT_PRICE = /(?:^|[^a-z])(?:old|compare|was|before|strike|original|crossed|saving|discount)|unit[-_]?price|per[-_]unit/i;
const NOT_CURRENT_PRICE_WRAPPER = /(?:^|[^a-z])(?:old|compare|was|before|strike|original|crossed)/i;

/** First "12.990 kr." style text in an element whose class/id mentions "price"/"verd". */
export function findPriceInText($) {
  const candidates = $('[class*="price" i], [id*="price" i], [class*="verd" i], [class*="verð" i]');
  for (const el of candidates.toArray().slice(0, 200)) {
    const node = $(el);
    const label = `${node.attr('class') || ''} ${node.attr('id') || ''}`;
    if (NOT_CURRENT_PRICE.test(label)) continue;
    if (node.is('del, s, strike') || node.closest('del, s, strike').length) continue;
    const wrappers = node.parents().toArray().slice(0, 3);
    if (wrappers.some((p) => NOT_CURRENT_PRICE_WRAPPER.test(`${$(p).attr('class') || ''} ${$(p).attr('id') || ''}`))) continue;
    // Ignore struck-out children (e.g. <del>15.990 kr.</del> next to the real price).
    const clone = node.clone();
    clone.find('del, s, strike, script, style').remove();
    clone
      .find('[class], [id]')
      .filter((_, d) => NOT_CURRENT_PRICE.test(`${$(d).attr('class') || ''} ${$(d).attr('id') || ''}`))
      .remove();
    const text = clone.text().replace(/\s+/g, ' ').trim();
    if (!text || text.length > 120) continue;
    const m = text.match(PRICE_WITH_KR);
    if (!m) continue;
    const amount = parsePrice((m[1] ?? m[2]).trim());
    if (amount !== null && amount > 0) return amount;
  }
  return null;
}

// ---- Shopify --------------------------------------------------------------------------

export function looksLikeShopify(html) {
  return /cdn\.shopify\.com|Shopify\.shop\s*=|window\.ShopifyAnalytics|shopify-digital-wallet/i.test(html);
}

function shopifyCurrency(html) {
  const m = /Shopify\.currency\s*=\s*\{[^}]*?"active"\s*:\s*"([A-Za-z]{3})"/.exec(html);
  return m ? m[1].toUpperCase() : '';
}

/** `<product url without query/hash>.js`, or "" when the URL isn't a Shopify product page. */
export function shopifyJsonUrl(pageUrl) {
  try {
    const u = new URL(pageUrl);
    if (!/\/products\/[^/]+/.test(u.pathname)) return '';
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}.js`;
  } catch {
    return '';
  }
}

/** Fetches Shopify's product JSON. Prices there are in minor units (ISK × 100). */
async function fetchShopifyProduct(fetchPage, pageUrl, opts) {
  const jsUrl = shopifyJsonUrl(pageUrl);
  if (!jsUrl) return null;
  const res = await fetchPage(jsUrl, {
    ...opts,
    timeoutMs: Math.min(opts.timeoutMs ?? 5000, 5000),
    maxBytes: 1024 * 1024,
    accept: 'application/json,text/javascript,*/*;q=0.5',
  });
  const data = JSON.parse(res.text);
  const minor = typeof data.price === 'number' ? data.price : parsePrice(String(data.price ?? ''));
  return {
    name: cleanText(data.title || ''),
    amount: minor !== null && minor > 0 ? minor / 100 : null,
    image: typeof data.featured_image === 'string' ? data.featured_image : toArray(data.images).find((i) => typeof i === 'string') || '',
  };
}

// ---- page parsing ----------------------------------------------------------------------

/**
 * Pure HTML → product fields. Priority: JSON-LD, then meta tags/microdata, then a
 * visible "kr." price, then <h1>/<title> for the name.
 * Returns { name, imageUrl, amount, currency, siteName, brand, seller, isShopify }.
 */
export function parseProductHtml(html, pageUrl) {
  const $ = load(html || '');
  const ld = extractJsonLdProduct($);
  const siteName = cleanText(metaContent($, ['og:site_name', 'application-name']), 100);
  const knownStore = storeNameFromUrl(pageUrl);
  const suffixNames = [siteName, knownStore];

  // Name
  let name = ld?.name || '';
  if (!name) name = stripSiteSuffix(metaContent($, ['og:title', 'twitter:title']), suffixNames);
  if (!name) name = cleanText($('[itemscope][itemtype*="Product" i] [itemprop="name"]').first().attr('content') || $('[itemscope][itemtype*="Product" i] [itemprop="name"]').first().text());
  if (!name) name = cleanText($('h1').first().text());
  if (!name) name = stripSiteSuffix($('title').first().text(), suffixNames, true);
  name = stripSiteSuffix(name, suffixNames).slice(0, MAX_NAME);

  // Image
  const imageCandidates = [
    ld?.image,
    metaContent($, ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']),
    itempropValue($, 'image'),
    $('link[rel="image_src"]').attr('href'),
  ];
  const imageUrl = imageCandidates.map((c) => resolveUrl(c, pageUrl)).find(Boolean) || '';

  // Price
  let amount = ld?.amount ?? null;
  let currency = ld?.amount != null ? ld.currency : '';
  if (amount === null) {
    const metaAmount = parsePrice(metaContent($, ['product:price:amount', 'og:price:amount', 'product:sale_price:amount']));
    if (metaAmount !== null && metaAmount > 0) {
      amount = metaAmount;
      currency = normalizeCurrency(metaContent($, ['product:price:currency', 'og:price:currency', 'product:sale_price:currency']));
    }
  }
  if (amount === null) {
    const itemAmount = parsePrice(itempropValue($, 'price') || itempropValue($, 'lowPrice'));
    if (itemAmount !== null && itemAmount > 0) {
      amount = itemAmount;
      currency = normalizeCurrency(itempropValue($, 'priceCurrency'));
    }
  }
  // Next.js page data: the record whose name matches the page (else the first one).
  const nd = nextDataProducts(html);
  const ndMain = nd.find((p) => name && p.name.toLowerCase() === name.toLowerCase()) || (amount === null ? nd[0] : null);
  if (amount === null && ndMain && ndMain.price > 0) {
    amount = ndMain.price;
    currency = ndMain.currency || '';
  }
  const isShopify = looksLikeShopify(html || '');
  if (amount !== null && !currency) {
    currency =
      normalizeCurrency(metaContent($, ['product:price:currency', 'og:price:currency'])) ||
      normalizeCurrency(itempropValue($, 'priceCurrency')) ||
      (isShopify ? shopifyCurrency(html) : '');
  }
  if (amount === null) {
    const textAmount = findPriceInText($);
    if (textAmount !== null) {
      amount = textAmount;
      currency = 'ISK'; // only matched next to "kr." / "ISK"
    }
  }

  return {
    name,
    imageUrl,
    amount,
    currency,
    siteName,
    brand: ld?.brand || '',
    // A real brand name (some shops put a numeric id in JSON-LD brand).
    brandName: [ld?.brand, ndMain?.brand].find((b) => b && !/^\d+$/.test(b)) || '',
    identifiers: [...(ld?.ids || []), ...(ndMain?.ids || [])],
    seller: ld?.seller || '',
    isShopify,
    shopifyCurrency: isShopify ? shopifyCurrency(html) : '',
  };
}

/** Builds a LookupResult from parsed fields. Unknown currency on a .is site is assumed ISK. */
export function toLookupResult(parsed, pageUrl) {
  let currency = parsed.currency;
  if (parsed.amount !== null && !currency && isIcelandicHost(pageUrl)) currency = 'ISK';
  const money = priceFields(parsed.amount, currency);
  return {
    name: parsed.name || nameFromUrlSlug(pageUrl),
    store: storeNameFromUrl(pageUrl, parsed.siteName),
    url: pageUrl,
    price: money.price,
    currency: money.currency,
    originalPrice: money.originalPrice,
    imageUrl: parsed.imageUrl || '',
  };
}

const GENERIC_SEGMENTS = new Set(['products', 'product', 'vara', 'vorur', 'p', 'item', 'shop', 'is', 'en', 'collections']);

/** "https://x.is/vorur/le-creuset-pottur-24cm.html" → "Le creuset pottur 24cm". */
export function nameFromUrlSlug(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean).reverse();
    for (const seg of segments) {
      let s = seg;
      try {
        s = decodeURIComponent(seg);
      } catch {
        /* keep raw */
      }
      s = s.replace(/\.(html?|aspx?|php)$/i, '').replace(/[-_+]+/g, ' ').trim();
      if (!/[a-zà-ÿ]/i.test(s) || GENERIC_SEGMENTS.has(s.toLowerCase()) || /^[a-z]?\d+$/i.test(s)) continue;
      return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, MAX_NAME);
    }
  } catch {
    /* fall through */
  }
  return '';
}

/**
 * Fetches `url` with `fetchPage(url, opts) → { url, text }` and extracts a LookupResult.
 * Errors thrown by `fetchPage` propagate.
 */
export async function extractProductWith(fetchPage, url, opts = {}) {
  const page = await fetchPage(url, opts);
  const parsed = parseProductHtml(page.text, page.url);

  if (parsed.isShopify && (parsed.amount === null || !parsed.imageUrl || !parsed.name)) {
    try {
      const shop = await fetchShopifyProduct(fetchPage, page.url, opts);
      if (shop) {
        if (!parsed.name && shop.name) parsed.name = shop.name;
        if (!parsed.imageUrl && shop.image) parsed.imageUrl = resolveUrl(shop.image, page.url);
        if (parsed.amount === null && shop.amount !== null) {
          parsed.amount = shop.amount;
          parsed.currency = parsed.shopifyCurrency || '';
        }
      }
    } catch {
      // Best effort only.
    }
  }
  return toLookupResult(parsed, page.url);
}
