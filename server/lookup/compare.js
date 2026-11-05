// Price comparison: given a product (e.g. "Global Nakiri hnífur 18cm" from Kúnígúnd), find the
// SAME product in other Icelandic shops, with its price there, cheapest first.
//
// How (no API keys, no search engines – those block automated requests):
//  1. Identify the product: brand and model/article numbers (e.g. Global "G-5", Le Creuset
//     "21177240602430"), read from the name and from the product page (SKU, MPN, EAN,
//     Next.js page data). Shops name products differently ("Global Nakiri hnífur 18cm" at
//     Kúnígúnd is "Grænmetishnífur 18cm - G-5" at Líf og List), but the model number is the same.
//  2. Search each known shop with its own search page or brand page (SHOPS below).
//  3. Same product = same model/article number. Without numbers on both sides, fall back to a
//     strict name match (same brand, same sizes, nearly all words) and say it's a likely match.
//
// The page fetcher is passed in, so this runs on the Node server and in the browser (bundled
// into public/vendor/lookup.js, fetching through the Google Apps Script).

import { load } from 'cheerio';
import { nextDataProducts, parseProductHtml, resolveUrl } from './parse.js';
import { parsePrice } from './price.js';
import { hostOf } from './stores.js';

// ---------------------------------------------------------------------------------------
// Product identity: brand + model/article numbers
// ---------------------------------------------------------------------------------------

export const KNOWN_BRANDS = [
  'Le Creuset',
  'Global',
  'Staub',
  'Kähler',
  'Iittala',
  'Fiskars',
  'Wüsthof',
  'Zwilling',
  'KitchenAid',
  'Moomin',
  'Arabia',
  'Georg Jensen',
  'Stelton',
  'Eva Solo',
  'Eva Trio',
  'Bodum',
  'Rosti',
  'Ferm Living',
  'HAY',
  'Mauviel',
  'de Buyer',
  'Lodge',
  'Smeg',
  'Dualit',
  'Opinel',
  'Kyocera',
  'Victorinox',
  'OXO',
  'Joseph Joseph',
  'Scanpan',
  'Emile Henry',
  'Riedel',
  'Spiegelau',
  'Holmegaard',
  'Royal Copenhagen',
  'Rosendahl',
  'Kay Bojesen',
  'Normann Copenhagen',
  'Muuto',
  'Menu',
  'Audo',
  'Södahl',
  'Broste',
  'Bitz',
  'Sabre',
  'Mepal',
  'Chemex',
  'Hario',
  'Moccamaster',
  'Nespresso',
  'Ooni',
  'Weber',
  'Peugeot',
  'Cole & Mason',
  'Microplane',
  'Tojiro',
  'Shun',
  'Kai',
  'Robert Welch',
  'Sambonet',
  'Alessi',
];

const UNIT_PREFIXES = new Set(['CM', 'MM', 'ML', 'L', 'KG', 'G', 'STK', 'NR', 'NO', 'X']);

/** "G-5" → "G5", "GS-108/UT" → "GS108UT", "21177240602430" stays. */
export const normalizeCode = (code) =>
  String(code)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/** How shops usually write a model code in names (and what their search finds): "G5" → "G-5". */
export const displayCode = (norm) => norm.replace(/^([A-Z]{1,4})(\d)/, '$1-$2');

/**
 * Model/article numbers in a text: letter codes like G-5, GS-108/UT, GKB-52 (needs a dash or
 * no space between letters and digits) and long article numbers/EANs (8–14 digits).
 * Returns [{ code: normalized, display: as written }].
 */
export function codesInText(text) {
  const out = [];
  const s = String(text || '');
  for (const m of s.matchAll(/(?<![A-Za-z0-9])([A-Z]{1,4})-?(\d{1,5}[A-Z]{0,3})(?:\/([A-Z]{1,3}))?(?![A-Za-z0-9])/g)) {
    // "G 5"-style (space) is not a code; plain units ("CM24") are not either.
    if (UNIT_PREFIXES.has(m[1]) && !m[0].includes('-')) continue;
    out.push({ code: normalizeCode(m[0]), display: m[0].includes('-') ? m[0] : displayCode(normalizeCode(m[0])) });
  }
  for (const m of s.matchAll(/(?<![\d])(\d{8,14})(?![\d])/g)) out.push({ code: m[1], display: m[1] });
  return out;
}

/** Codes from a SKU/MPN/EAN field: strips a shop's brand prefix ("GLO-G5" → G5, "LEC-2117…" → 2117…). */
export function codesFromIdentifier(id) {
  const raw = String(id || '')
    .trim()
    .toUpperCase();
  if (!raw) return [];
  const stripped = raw.replace(/^[A-Z]{2,4}-(?=[A-Z]{0,4}\d)/, '');
  const norm = normalizeCode(stripped);
  if (/^\d{8,14}$/.test(norm) || /^[A-Z]{1,4}\d{1,5}[A-Z]{0,5}$/.test(norm))
    return [{ code: norm, display: displayCode(norm) }];
  return [];
}

/** Same model when the codes are equal, or one is the other plus a 1–3 letter variant suffix. */
export function codesMatch(a, b) {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return x;
      const [short, long] = x.length < y.length ? [x, y] : [y, x];
      if (/\d$/.test(short) && long.startsWith(short) && /^[A-Z]{1,3}$/.test(long.slice(short.length))) return short;
    }
  }
  return '';
}

export function brandInName(name) {
  const lower = ` ${String(name || '').toLowerCase()} `;
  return KNOWN_BRANDS.find((b) => lower.includes(` ${b.toLowerCase()} `)) || '';
}

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
  const STOP = new Set([
    'og',
    'eda',
    'med',
    'fyrir',
    'fra',
    'til',
    'i',
    'a',
    'the',
    'and',
    'with',
    'for',
    'of',
    'cm',
    'mm',
    'ml',
    'l',
    'stk',
    'sett',
    'set',
    'kr',
    'isk',
    'nytt',
    'new',
  ]);
  return [...new Set(folded.split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w) && (w.length > 1 || /\d/.test(w))))];
}

/**
 * Same word, allowing an Icelandic inflection ending ("hnífur"/"hnífinn", "pottur"/"potturinn")
 * but not a different compound ("steypujárnspottur" ≠ "steypujárnspanna"). Numbers must be equal.
 */
export function wordsMatch(a, b) {
  if (a === b) return true;
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return common >= Math.max(4, Math.min(a.length, b.length) - 3);
}
const hasWord = (words, w) => words.some((x) => wordsMatch(x, w));

/** Strict name match (used only when model numbers are missing): same sizes, nearly all words. */
export function isSameProductByName(base, candidate, brand = '') {
  const brandWords = new Set(productTokens(brand));
  const a = productTokens(base).filter((w) => !brandWords.has(w));
  const b = productTokens(candidate);
  if (!a.length || !b.length) return false;
  const numbers = a.filter((w) => /^\d+$/.test(w));
  const bNumbers = b.filter((w) => /^\d+$/.test(w));
  if (numbers.some((n) => !b.includes(n)) || bNumbers.some((n) => !numbers.includes(n))) return false;
  const words = a.filter((w) => !/^\d+$/.test(w));
  if (!words.length) return numbers.length > 0;
  const matched = words.filter((w) => hasWord(b, w)).length;
  return (
    matched >= Math.max(2, Math.ceil(words.length * 0.8)) || (words.length === 1 && matched === 1 && numbers.length > 0)
  );
}

/** Words in `candidate` that are not in `base` (sizes and brand ignored). */
function extraWords(base, candidate, brand = '') {
  const a = productTokens(`${base} ${brand}`);
  return productTokens(candidate).filter((w) => !/^\d+$/.test(w) && !hasWord(a, w)).length;
}

/** Short search phrase from a name: its longest word (minus brand and codes) plus its numbers. */
export function nameQuery(name, brand = '') {
  let cleaned = String(name || '').replace(/\s[-–|]\s[^-–|]*$/, ''); // colour / shop suffix
  if (brand) cleaned = cleaned.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  for (const c of codesInText(cleaned)) cleaned = cleaned.replace(c.display, ' ');
  const words = cleaned.split(/[\s,/()]+/).filter(Boolean);
  const longest = words.filter((w) => /^\p{L}{4,}$/u.test(w)).sort((x, y) => y.length - x.length)[0] || '';
  const numbers = (cleaned.match(/\d+(?:[.,]\d+)?/g) || []).filter((n) => !/^\d{8,}$/.test(n)).slice(0, 2);
  return [longest, ...numbers].filter(Boolean).join(' ');
}

/** Brand and codes of the product we compare (from its name and, if given, its product page). */
export async function identifyProduct(fetchPage, { name, url = '' }, { signal } = {}) {
  let brand = brandInName(name);
  const codes = new Map(codesInText(name).map((c) => [c.code, c.display]));
  if (url) {
    try {
      const page = await fetchPage(url, { signal, timeoutMs: 8000 });
      const parsed = parseProductHtml(page.text, page.url || url);
      for (const id of parsed.identifiers || []) for (const c of codesFromIdentifier(id)) codes.set(c.code, c.display);
      for (const c of codesInText(parsed.name)) codes.set(c.code, c.display);
      brand = brand || parsed.brandName || brandInName(parsed.name);
    } catch (err) {
      if (signal?.aborted) throw err;
      /* identify from the name alone */
    }
  }
  return { name, brand, codes: [...codes.keys()], displayCodes: [...codes.values()] };
}

// ---------------------------------------------------------------------------------------
// Shop adapters: each returns candidates { name, url, price, imageUrl, brand, codes[] }
// ---------------------------------------------------------------------------------------

const slugifyBrand = (b) =>
  b
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Search phrases: model numbers as written (e.g. "G-5"), then a short name phrase. */
function queriesFor(ident) {
  // The first model code is the one from the name or the manufacturer's number; later ones are
  // usually a shop's own SKU, which other shops don't know.
  const codeQueries = ident.displayCodes.filter((d) => /[A-Za-z]/.test(d)).slice(0, 1);
  const nq = nameQuery(ident.name, ident.brand);
  return [...new Set([...codeQueries, nq].filter(Boolean))];
}

/** Runs `fn(query)` for each query; one failing query doesn't lose the others' results. */
async function eachQuery(queries, fn, signal) {
  const out = [];
  let lastError = null;
  for (const q of queries) {
    try {
      out.push(...(await fn(q)));
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }
  if (!out.length && lastError) throw lastError;
  return out;
}

/** Líf og List (Next.js): /leit?q= has the results with brand and manufacturer SKU in its page data. */
async function searchLifOgList(fetchPage, ident, opts) {
  const base = 'https://www.lifoglist.is';
  return eachQuery(
    queriesFor(ident),
    async (q) => {
      const page = await fetchPage(`${base}/leit?q=${encodeURIComponent(q)}`, opts);
      return nextDataProducts(page.text)
        .filter((p) => p.slug)
        .map((p) => ({
          name: p.name,
          url: `${base}/vorur/${p.slug}`,
          price: p.price,
          imageUrl: p.image,
          brand: p.brand,
          ids: p.ids,
        }));
    },
    opts.signal,
  );
}

// Kúnígúnd's product sitemap lists every product of the Roanuz shops. They share one Magento
// backend and the same product URLs (Byggt og búið's own sitemap is empty), so it is used for both.
const ROANUZ_SITEMAP = 'https://kunigund.is/sitemaps/products.xml';
const SITEMAP_TTL_MS = 6 * 60 * 60 * 1000;
let sitemapCache = null; // { at, paths } once loaded, or { pending: Promise } while loading

async function roanuzSitemapPaths(fetchPage, opts) {
  if (sitemapCache?.pending) return sitemapCache.pending;
  if (sitemapCache && Date.now() - sitemapCache.at < SITEMAP_TTL_MS) return sitemapCache.paths;
  const pending = fetchPage(ROANUZ_SITEMAP, { ...opts, timeoutMs: 25_000 }).then(
    (page) => {
      const paths = [...String(page.text).matchAll(/<loc>\s*https?:\/\/[^/<]+\/([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      sitemapCache = { at: Date.now(), paths };
      return paths;
    },
    (err) => {
      sitemapCache = null;
      throw err;
    },
  );
  sitemapCache = { pending };
  return pending;
}

/** Product pages in the sitemap whose URL has the brand, all the sizes and the main word(s). */
export function sitemapCandidates(paths, ident, max = 3) {
  const brandSlug = slugifyBrand(ident.brand || '');
  const wanted = productTokens(nameQuery(ident.name, ident.brand));
  const numbers = wanted.filter((w) => /^\d+$/.test(w));
  const words = wanted.filter((w) => !/^\d+$/.test(w));
  if (!brandSlug || !wanted.length) return [];
  const scored = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    if (!path.startsWith(`${brandSlug}-`)) continue;
    const tokens = productTokens(path.replace(/\.html?$/, '').replace(/[-_/]+/g, ' '));
    if (numbers.some((n) => !tokens.includes(n))) continue;
    const matched = words.filter((w) => hasWord(tokens, w)).length;
    if (words.length && !matched) continue;
    scored.push({ path, score: matched, length: tokens.length });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.length - b.length)
    .slice(0, max)
    .map((x) => x.path);
}

const roanuzImage = (p) => {
  const [, , stamp] = p.galleryMeta.split(';');
  const sku = p.ids.find((id) => /^[A-Z]{2,4}-/.test(id)) || p.ids[0] || '';
  return p.image || (stamp && sku ? `https://d21glh60bk8ucb.cloudfront.net/product_images_v1/${sku}/${stamp}/web/large2x_0.jpeg` : '');
};

/**
 * Shops on the Roanuz/Magento platform (Kúnígúnd, Byggt og búið). Their search is rendered with
 * JavaScript, so: (1) the brand page, which lists part of the brand's products, and (2) if that
 * doesn't give the same model number, product pages found in the sitemap. A product page lists
 * its variants (e.g. every colour of a pot, each with its own article number); variants have no
 * page of their own, so they link to the product page.
 */
function roanuzShop(base) {
  return async (fetchPage, ident, opts) => {
    if (!ident.brand) return [];
    const out = [];
    let lastError = null;
    try {
      const page = await fetchPage(`${base}/brand/${slugifyBrand(ident.brand)}`, opts);
      for (const p of nextDataProducts(page.text).filter((x) => x.urlKey)) {
        out.push({
          name: p.name,
          url: `${base}/${p.urlKey}${p.urlSuffix || '.html'}`,
          price: p.price,
          imageUrl: roanuzImage(p),
          brand: ident.brand,
          ids: p.ids,
        });
      }
    } catch (err) {
      if (opts?.signal?.aborted) throw err;
      lastError = err;
    }
    if (ident.codes.length && out.some((c) => matchCandidate(ident, c)?.kind === 'code')) return out;

    try {
      const paths = sitemapCandidates(await roanuzSitemapPaths(fetchPage, opts), ident);
      const pages = await Promise.allSettled(paths.map((path) => fetchPage(`${base}/${path}`, opts)));
      pages.forEach((res, i) => {
        if (res.status !== 'fulfilled') return;
        const pageUrl = `${base}/${paths[i]}`;
        const main = parseProductHtml(res.value.text, pageUrl);
        if (!main.name || /^404\b/.test(main.name)) return;
        for (const p of nextDataProducts(res.value.text)) {
          // Variants of this product link to its page; other products shown on it (related
          // items) link to their own page.
          const variant = isSameProductByName(main.name, p.name, ident.brand) || !p.urlKey;
          out.push({
            name: p.name,
            url: variant ? pageUrl : `${base}/${p.urlKey}${p.urlSuffix || '.html'}`,
            price: p.price,
            imageUrl: roanuzImage(p) || (variant ? main.imageUrl : ''),
            brand: ident.brand,
            ids: p.ids,
          });
        }
      });
    } catch (err) {
      if (opts?.signal?.aborted) throw err;
      lastError = lastError || err;
    }
    if (!out.length && lastError) throw lastError;
    return out;
  };
}

/** WooCommerce shops (Kokka): /?s=…&post_type=product, product grid with SKU attributes. */
function wooShop(base) {
  return (fetchPage, ident, opts) =>
    eachQuery(
      queriesFor(ident),
      async (q) => {
        const out = [];
        const page = await fetchPage(`${base}/?s=${encodeURIComponent(q)}&post_type=product`, opts);
        const $ = load(page.text || '');
        $('.wd-product, li.product, .product-grid-item').each((_, el) => {
          const e = $(el);
          const link = e.find('.wd-entities-title a, .woocommerce-loop-product__link, a.product-image-link').first();
          const url = resolveUrl(link.attr('href'), base);
          const name = (e.find('.wd-entities-title, .woocommerce-loop-product__title').first().text() || link.text())
            .replace(/\s+/g, ' ')
            .trim();
          const priceEl = e.find('.price ins .amount').first().length
            ? e.find('.price ins .amount').first()
            : e.find('.price .amount').first();
          const price = parsePrice(priceEl.text());
          if (!url || !name || !price) return;
          const img = e.find('img').first();
          out.push({
            name,
            url,
            price,
            imageUrl: resolveUrl(img.attr('data-src') || img.attr('src'), base),
            brand: brandInName(name),
            ids: [e.find('[data-product_sku]').attr('data-product_sku')].filter(Boolean),
          });
        });
        return out;
      },
      opts.signal,
    );
}

export const SHOPS = [
  { store: 'Líf og List', host: 'lifoglist.is', search: searchLifOgList },
  { store: 'Kúnígúnd', host: 'kunigund.is', search: roanuzShop('https://kunigund.is') },
  { store: 'Byggt og búið', host: 'byggtogbuid.is', search: roanuzShop('https://byggtogbuid.is') },
  { store: 'Kokka', host: 'kokka.is', search: wooShop('https://kokka.is') },
];

// ---------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------

/** How a candidate matches the product: { kind: 'code', code } | { kind: 'name' } | null. */
export function matchCandidate(ident, cand) {
  const candCodes = [
    ...new Set(
      [...(cand.ids || []).flatMap((id) => codesFromIdentifier(id)), ...codesInText(cand.name)].map((c) => c.code),
    ),
  ];
  if (ident.brand && cand.brand && slugifyBrand(ident.brand) !== slugifyBrand(cand.brand)) return null;
  if (ident.codes.length && candCodes.length) {
    const code = codesMatch(ident.codes, candCodes);
    return code ? { kind: 'code', code } : null;
  }
  return isSameProductByName(ident.name, cand.name, ident.brand) ? { kind: 'name' } : null;
}

/**
 * Finds the same product in other Icelandic shops.
 * `fetchPage(url, opts) → { url, text }`; `url` is the product page already known (its shop is skipped).
 * Resolves { offers: [{ ...LookupResult, match: 'code'|'name', matchCode? }] cheapest first,
 *            shops: number searched, identity: { brand, codes }, message? }.
 */
export async function compareWith(fetchPage, { name, url = '' }, { signal, shops = SHOPS, logger = console } = {}) {
  if (!productTokens(name).length) {
    return {
      offers: [],
      shops: 0,
      identity: null,
      message: 'Skrifaðu heiti vörunnar fyrst, þá get ég borið saman verð.',
    };
  }
  const ident = await identifyProduct(fetchPage, { name, url }, { signal });
  const knownHost = hostOf(url);
  const targets = shops.filter((s) => !knownHost || (knownHost !== s.host && !knownHost.endsWith(`.${s.host}`)));

  const settled = await Promise.allSettled(
    targets.map((s) => s.search(fetchPage, ident, { signal, timeoutMs: 12_000 })),
  );
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');

  const offers = [];
  settled.forEach((res, i) => {
    const shop = targets[i];
    if (res.status !== 'fulfilled') {
      logger?.warn?.(`[compare] ${shop.store}: ${res.reason?.message || res.reason}`);
      return;
    }
    let best = null;
    for (const cand of res.value) {
      const m = matchCandidate(ident, cand);
      if (!m || !(cand.price > 0)) continue;
      // Name matches: the closest name wins (fewest extra words, e.g. not "… lágur"), then the price.
      const extra = m.kind === 'name' ? extraWords(ident.name, cand.name, ident.brand) : 0;
      const better =
        !best ||
        (m.kind === 'code' && best.match !== 'code') ||
        (m.kind === best.match && (extra < best.extra || (extra === best.extra && cand.price < best.price)));
      if (better) {
        best = {
          name: cand.name,
          store: shop.store,
          url: cand.url,
          price: Math.round(cand.price),
          currency: 'ISK',
          originalPrice: Math.round(cand.price),
          imageUrl: cand.imageUrl || '',
          match: m.kind,
          extra,
          ...(m.kind === 'code' ? { matchCode: ident.displayCodes[ident.codes.indexOf(m.code)] || m.code } : {}),
        };
      }
    }
    if (best) offers.push(best);
  });
  for (const o of offers) delete o.extra;
  offers.sort((a, b) => a.price - b.price);
  return {
    offers,
    shops: targets.length,
    shopsSearched: targets.map((s) => s.store).join(', '),
    identity: { brand: ident.brand, codes: ident.displayCodes },
    ...(offers.length
      ? {}
      : { message: `Fann ekki sömu vöru í öðrum verslunum (${targets.map((s) => s.store).join(', ')}).` }),
  };
}

/**
 * Free-text search across the known shops (used by "Finna" when no link is given):
 * products whose name (or brand + name) contains most of the query's words, best first.
 * Resolves LookupResult[] (max `limit`).
 */
export async function searchShops(fetchPage, query, { signal, shops = SHOPS, limit = 8, logger = console } = {}) {
  const words = productTokens(query);
  if (!words.length) return [];
  const brand = brandInName(query);
  const codes = codesInText(query);
  const ident = {
    name: query,
    brand,
    codes: codes.map((c) => c.code),
    displayCodes: codes.map((c) => c.display),
  };
  const settled = await Promise.allSettled(shops.map((s) => s.search(fetchPage, ident, { signal, timeoutMs: 12_000 })));
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');

  const scored = [];
  const seen = new Set();
  settled.forEach((res, i) => {
    if (res.status !== 'fulfilled') {
      logger?.warn?.(`[search] ${shops[i].store}: ${res.reason?.message || res.reason}`);
      return;
    }
    for (const cand of res.value) {
      if (!(cand.price > 0) || seen.has(cand.url)) continue;
      seen.add(cand.url);
      const have = productTokens(`${cand.brand || ''} ${cand.name}`);
      const matched = words.filter((w) => hasWord(have, w)).length;
      const byCode = ident.codes.length > 0 && Boolean(match(ident, cand));
      if (!byCode && matched < Math.max(1, Math.ceil(words.length * 0.6))) continue;
      scored.push({
        score: (byCode ? 100 : 0) + matched / words.length,
        result: {
          name: cand.name,
          store: shops[i].store,
          url: cand.url,
          price: Math.round(cand.price),
          currency: 'ISK',
          originalPrice: Math.round(cand.price),
          imageUrl: cand.imageUrl || '',
        },
      });
    }
  });
  // Best first, but take turns between shops so one shop doesn't fill the list.
  scored.sort((a, b) => b.score - a.score || a.result.price - b.result.price);
  const byShop = new Map();
  for (const s of scored) {
    if (!byShop.has(s.result.store)) byShop.set(s.result.store, []);
    byShop.get(s.result.store).push(s.result);
  }
  const out = [];
  while (out.length < limit && [...byShop.values()].some((l) => l.length)) {
    for (const list of byShop.values()) if (list.length && out.length < limit) out.push(list.shift());
  }
  return out;
}

const match = (ident, cand) => matchCandidate(ident, cand);
