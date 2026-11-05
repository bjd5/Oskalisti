// Óskalisti – frontend (vanilla ES module, no dependencies, no build step).
//
// SECURITY: data from the server is NEVER inserted with innerHTML. Everything is built with
// createElement/textContent via the h() helper, and URLs are only used for href/src when they
// are http(s) (see safeUrl()).

import './compat.js'; // fallbacks for older Safari (<dialog>, structuredClone, randomUUID)

/* ======================================================================
   Constants & helpers
   ====================================================================== */

// Intl.NumberFormat('is-IS') gives "12.990". Some browsers ship without Icelandic locale data and
// fall back to "12,990", so verify the output and group manually if needed.
const isNumberFormat = (() => {
  try {
    const f = new Intl.NumberFormat('is-IS', { maximumFractionDigits: 0 });
    if (f.format(12990) === '12.990') return f;
  } catch {
    /* fall through */
  }
  return null;
})();
const fmtNumber = {
  format(n) {
    if (isNumberFormat) return isNumberFormat.format(n);
    const sign = n < 0 ? '-' : '';
    return sign + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  },
};
const fmtDecimal = {
  format(n) {
    const [int, dec] = (Math.round(n * 100) / 100).toFixed(2).split('.');
    const d = dec.replace(/0+$/, '');
    return fmtNumber.format(Number(int)) + (d ? `,${d}` : '');
  },
};
const kr = (n) => `${fmtNumber.format(n)} kr.`;

const DEFAULT_SETTINGS = {
  title: 'Óskalistinn okkar',
  subtitle: 'Hugmyndir að gjöfum – jól, afmæli, innflutningur og önnur tilefni',
  intro: '',
};
const FALLBACK_CATEGORY = { id: 'annad', name: 'Annað', icon: '🎁' };

const RANGES = [
  { id: 'all', min: null, max: null },
  { id: '0-5000', min: 0, max: 5000 },
  { id: '5000-10000', min: 5000, max: 10000 },
  { id: '10000-15000', min: 10000, max: 15000 },
  { id: '15000-20000', min: 15000, max: 20000 },
  { id: '20000-30000', min: 20000, max: 30000 },
  { id: '30000-50000', min: 30000, max: 50000 },
  { id: '50000+', min: 50000, max: Infinity },
].map((r) => ({ ...r, label: rangeLabel(r) }));

const SORTS = ['recommended', 'price-asc', 'price-desc', 'newest', 'name'];
const PREFS_KEY = 'oskalisti.prefs.v1';
const LOOKUP_TIMEOUT_MS = 150_000;

function rangeLabel(r) {
  if (r.id === 'all') return 'Allt';
  if (r.max === Infinity) return `${fmtNumber.format(r.min)} kr.+`;
  return `${fmtNumber.format(r.min)}–${fmtNumber.format(r.max)} kr.`;
}
function rangePhrase(r) {
  if (r.max === Infinity) return `sem kosta ${kr(r.min)} eða meira`;
  return `á bilinu ${r.label}`;
}

/** Icelandic singular is used for numbers ending in 1, except 11 (1, 21, 31 … but not 11, 111). */
const isSingular = (n) => n % 10 === 1 && n % 100 !== 11;
const giftsWord = (n) => (isSingular(n) ? 'gjöf' : 'gjafir');

const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny DOM builder. Strings become text nodes; attributes are set with setAttribute. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val == null || val === false) continue;
      if (key.startsWith('on')) {
        if (typeof val === 'function') el.addEventListener(key.slice(2), val);
        continue; // never set string event-handler attributes
      }
      if (key === 'class') el.className = val;
      else el.setAttribute(key, val === true ? '' : String(val));
    }
  }
  appendKids(el, children);
  return el;
}
function appendKids(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) appendKids(el, k);
    else el.append(k instanceof Node ? k : String(k));
  }
}

/** Returns a normalised http(s) URL or '' for anything else (javascript:, data:, relative …). */
function safeUrl(u) {
  if (typeof u !== 'string') return '';
  const s = u.trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const url = new URL(s);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
function toInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}
function toNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Parses Icelandic-style price input: "12.990", "12990", "12.990 kr.", "1.299,50" → int ISK. */
function parsePrice(raw) {
  const s = str(raw).trim();
  if (!s) return { ok: true, value: null };
  let t = s.replace(/kr\.?|isk/gi, '').replace(/[\s .]/g, '');
  if (/^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, ''); // 12,990 written as thousands
  t = t.replace(/,\d*$/, ''); // decimals
  if (!/^\d+$/.test(t)) return { ok: false, value: null };
  const n = parseInt(t, 10);
  if (n > 100_000_000) return { ok: false, value: null };
  return { ok: true, value: n };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* ======================================================================
   State
   ====================================================================== */

const state = {
  settings: { ...DEFAULT_SETTINGS },
  categories: [],
  items: [],
  dataVersion: 0,
  admin: false,
  aiSearch: false,
  loading: true,
  loadError: '',
  // guest preferences
  budget: 'all',
  category: 'all',
  sort: 'recommended',
  sortAuto: true,
  showPurchased: true,
};

const ideas = { key: '', singles: [], pairsAll: [], order: [], offset: 0, pairPick: [] };

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (RANGES.some((r) => r.id === p.budget)) state.budget = p.budget;
    if (typeof p.category === 'string') state.category = p.category;
    if (SORTS.includes(p.sort)) state.sort = p.sort;
    state.sortAuto = p.sortAuto !== false;
    if (typeof p.showPurchased === 'boolean') state.showPurchased = p.showPurchased;
  } catch {
    /* storage unavailable – ignore */
  }
}
function savePrefs() {
  try {
    const { budget, category, sort, sortAuto, showPurchased } = state;
    localStorage.setItem(PREFS_KEY, JSON.stringify({ budget, category, sort, sortAuto, showPurchased }));
  } catch {
    /* ignore */
  }
}

/* ---------- normalisation ---------- */

function normCategory(c) {
  return { id: str(c?.id), name: str(c?.name) || 'Flokkur', icon: str(c?.icon) };
}
function normOffer(o) {
  return { store: str(o?.store), url: str(o?.url), price: toInt(o?.price) };
}
function normItem(it) {
  return {
    id: str(it?.id),
    name: str(it?.name),
    description: str(it?.description),
    categoryId: str(it?.categoryId) || 'annad',
    imageUrl: str(it?.imageUrl),
    price: toInt(it?.price),
    offers: Array.isArray(it?.offers) ? it.offers.map(normOffer) : [],
    favorite: !!it?.favorite,
    purchased: !!it?.purchased,
    purchasedAt: it?.purchasedAt || null,
    createdAt: str(it?.createdAt),
    updatedAt: str(it?.updatedAt),
  };
}
function normResult(r) {
  return {
    name: str(r?.name),
    store: str(r?.store),
    url: str(r?.url),
    price: toInt(r?.price),
    currency: str(r?.currency) || 'ISK',
    originalPrice: toNum(r?.originalPrice),
    imageUrl: str(r?.imageUrl),
  };
}

/* ---------- derived data ---------- */

function categoryOf(item) {
  return (
    state.categories.find((c) => c.id === item.categoryId) ||
    state.categories.find((c) => c.id === 'annad') ||
    FALLBACK_CATEGORY
  );
}
function offerPrices(item) {
  return item.offers.map((o) => o.price).filter((p) => p != null);
}
function effectivePrice(item) {
  if (item.price != null) return item.price;
  const prices = offerPrices(item);
  return prices.length ? Math.min(...prices) : null;
}
/** "frá 12.990 kr." when several stores list a price, otherwise "12.990 kr." or "Verð óþekkt". */
function priceInfo(item) {
  const price = effectivePrice(item);
  if (price == null) return { known: false, from: false, value: null, text: 'Verð óþekkt' };
  const prices = offerPrices(item);
  const from = prices.length > 1;
  const value = from ? Math.min(price, ...prices) : price;
  return { known: true, from, value, text: `${from ? 'frá ' : ''}${kr(value)}` };
}
function bestOffer(item) {
  const withUrl = item.offers.filter((o) => safeUrl(o.url));
  withUrl.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  const o = withUrl[0];
  return o ? { ...o, url: safeUrl(o.url), store: o.store || hostOf(o.url) } : null;
}

const currentRange = () => RANGES.find((r) => r.id === state.budget) || RANGES[0];
function inRange(price, range) {
  if (range.id === 'all') return true;
  if (price == null) return false;
  return price >= range.min && price < range.max;
}
const matchesCategory = (item, catId) => catId === 'all' || categoryOf(item).id === catId;

/** Number of not-yet-purchased items for a range/category combination (chip badges). */
function countAvailable(range, catId) {
  let n = 0;
  for (const it of state.items) {
    if (!it.purchased && matchesCategory(it, catId) && inRange(effectivePrice(it), range)) n++;
  }
  return n;
}

const autoSortFor = (budget) => (budget === 'all' ? 'recommended' : 'price-asc');

function compareItems(mode) {
  const byName = (a, b) => a.name.localeCompare(b.name, 'is', { sensitivity: 'base' });
  const byNewest = (a, b) => str(b.createdAt).localeCompare(str(a.createdAt));
  const priceAsc = (a, b) => {
    const pa = effectivePrice(a);
    const pb = effectivePrice(b);
    if (pa == null && pb == null) return 0;
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pa - pb;
  };
  const priceDesc = (a, b) => {
    const pa = effectivePrice(a);
    const pb = effectivePrice(b);
    if (pa == null && pb == null) return 0;
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pb - pa;
  };
  const primary = {
    recommended: (a, b) => Number(b.favorite) - Number(a.favorite) || byNewest(a, b),
    'price-asc': priceAsc,
    'price-desc': priceDesc,
    newest: byNewest,
    name: byName,
  }[mode] || byNewest;
  return (a, b) =>
    Number(a.purchased) - Number(b.purchased) || primary(a, b) || byName(a, b) || a.id.localeCompare(b.id);
}

function visibleItems() {
  const range = currentRange();
  let list = state.items.filter((it) => matchesCategory(it, state.category) && inRange(effectivePrice(it), range));
  if (!state.showPurchased) list = list.filter((it) => !it.purchased);
  return list.sort(compareItems(state.sort));
}

/* ======================================================================
   API
   ====================================================================== */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function defaultError(status) {
  if (status === 401) return 'Aðgangur ekki leyfður';
  if (status === 404) return 'Þetta fannst ekki – kannski var því eytt.';
  if (status === 429) return 'Of margar tilraunir. Bíddu aðeins og reyndu svo aftur.';
  if (status >= 500) return 'Villa kom upp á vefþjóninum. Reyndu aftur eftir smástund.';
  return 'Eitthvað fór úrskeiðis. Reyndu aftur.';
}

// Which backend answers /api/* – the Node server (default) or, on GitHub Pages, the Google
// Sheets backend (see sheets-backend.js). Decided from config.json at startup.
let backend = null;

async function initBackend() {
  let config = null;
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (res.ok) config = await res.json();
  } catch {
    /* no config → Node server */
  }
  if (config?.backend === 'sheets') {
    const { createSheetsBackend } = await import('./sheets-backend.js');
    backend = createSheetsBackend(config.sheets);
  }
}

async function api(path, opts = {}) {
  // GitHub Pages has no /api: without a backend there, the page and config.json are out of step.
  if (!backend && location.hostname.endsWith('github.io')) {
    throw new ApiError('Síðan var að uppfærast. Endurhlaðaðu hana til að fá nýjustu útgáfuna.', 0);
  }
  if (!backend) return serverApi(path, opts);
  try {
    return await backend.request(path, opts);
  } catch (err) {
    if (opts.signal?.aborted || err?.name === 'AbortError') throw err;
    throw new ApiError(err?.message || defaultError(err?.status ?? 0), err?.status ?? 0);
  }
}

async function serverApi(path, { method = 'GET', body, signal } = {}) {
  let res;
  let text = '';
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') throw err;
    throw new ApiError('Ekki náðist samband við vefþjóninn. Athugaðu nettenginguna og reyndu aftur.', 0);
  }
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
  }
  if (!res.ok) {
    const msg = (data && typeof data.error === 'string' && data.error) || defaultError(res.status);
    throw new ApiError(msg, res.status);
  }
  return data;
}

/** For admin-only endpoints: a 401 means the session expired → drop admin mode and ask to log in. */
async function adminApi(path, opts) {
  try {
    return await api(path, opts);
  } catch (err) {
    if (err?.status === 401 && state.admin) {
      err.handled = true;
      state.admin = false;
      renderAll();
      toast('Innskráningin er útrunnin – skráðu þig inn aftur.', 'error');
      openLogin();
    }
    throw err;
  }
}

function reportError(err) {
  if (!err || err.handled || err.name === 'AbortError') return;
  toast(err.message || defaultError(0), 'error');
}

async function loadList() {
  const data = await api('/api/list');
  state.settings = { ...DEFAULT_SETTINGS, ...(data?.settings || {}) };
  state.categories = Array.isArray(data?.categories) ? data.categories.map(normCategory) : [];
  state.items = Array.isArray(data?.items) ? data.items.map(normItem) : [];
  state.dataVersion++;
  state.loadError = '';
  if (state.category !== 'all' && !state.categories.some((c) => c.id === state.category)) state.category = 'all';
}
async function loadMe() {
  try {
    const me = await api('/api/admin/me');
    state.admin = !!me?.admin;
    state.aiSearch = !!me?.aiSearch;
  } catch {
    state.admin = false;
  }
}
async function refreshAll() {
  const [listRes] = await Promise.allSettled([loadList(), loadMe()]);
  if (listRes.status === 'rejected') state.loadError = listRes.reason?.message || defaultError(0);
  state.loading = false;
  renderAll();
}

function upsertItem(raw) {
  const item = normItem(raw);
  const i = state.items.findIndex((x) => x.id === item.id);
  if (i >= 0) state.items[i] = item;
  else state.items.push(item);
  state.dataVersion++;
  return item;
}

/* ======================================================================
   Toast
   ====================================================================== */

const toastEl = $('#toast');
const supportsPopover = typeof toastEl.showPopover === 'function';
if (supportsPopover) toastEl.hidden = false; // visibility is controlled by the popover state
let toastTimer = 0;

function toast(message, type = 'info') {
  clearTimeout(toastTimer);
  toastEl.classList.toggle('is-error', type === 'error');
  if (supportsPopover) {
    // Re-show so it lands on top of any open modal dialog (top layer order).
    try {
      if (toastEl.matches(':popover-open')) toastEl.hidePopover();
      toastEl.showPopover();
    } catch {
      /* ignore */
    }
  } else {
    toastEl.hidden = false;
  }
  toastEl.textContent = message;
  toastTimer = setTimeout(hideToast, type === 'error' ? 6500 : 3500);
}
// Show unexpected errors instead of failing silently (helps when a browser lacks something).
window.addEventListener('error', (e) => {
  if (e.message) toast(`Villa: ${e.message}`, 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  if (reason?.name === 'AbortError') return;
  toast(`Villa: ${reason?.message || reason || 'óþekkt'}`, 'error');
});

function hideToast() {
  if (supportsPopover) {
    try {
      toastEl.hidePopover();
    } catch {
      /* ignore */
    }
  } else {
    toastEl.hidden = true;
  }
}
toastEl.addEventListener('click', hideToast);

/* ======================================================================
   Rendering – guest view
   ====================================================================== */

function placeholder(icon) {
  return h('div', { class: 'ph', 'aria-hidden': 'true' }, h('span', { class: 'ph-icon' }, icon || '🎁'));
}

/** Image box with lazy loading, no referrer, and a category-icon placeholder on error. */
function mediaEl(imageUrl, alt, icon) {
  const wrap = h('div', { class: 'media' });
  const src = safeUrl(imageUrl);
  if (!src) {
    wrap.append(placeholder(icon));
    return wrap;
  }
  const img = h('img', { alt: alt || '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(placeholder(icon)), { once: true });
  img.src = src; // set last so loading/referrerpolicy apply
  wrap.append(img);
  return wrap;
}

function renderHeader() {
  const s = state.settings;
  const title = s.title || DEFAULT_SETTINGS.title;
  $('#site-title').textContent = title;
  document.title = title;
  const sub = $('#site-subtitle');
  sub.textContent = s.subtitle || '';
  sub.hidden = !s.subtitle;
  const intro = $('#site-intro');
  intro.textContent = s.intro || '';
  intro.hidden = !s.intro;
}

function renderAdminBar() {
  const bar = $('#admin-bar');
  bar.hidden = !state.admin;
  $('#btn-access').hidden = state.admin;
  if (!state.admin) return;
  const total = state.items.length;
  const bought = state.items.filter((i) => i.purchased).length;
  $('#admin-summary').textContent =
    `${bought} af ${total} ${isSingular(total) ? 'gjöf' : 'gjöfum'} ${isSingular(bought) ? 'keypt' : 'keyptar'}`;
}

/* ---------- chips (updated in place so keyboard focus is kept) ---------- */

function createChip() {
  const el = h(
    'button',
    { type: 'button', class: 'chip' },
    h('span', { class: 'chip-icon', 'aria-hidden': 'true' }),
    h('span', { class: 'chip-label' }),
    h('span', { class: 'chip-unit' }),
    h('span', { class: 'chip-count', 'aria-hidden': 'true' }),
    h('span', { class: 'sr-only' }),
  );
  el.addEventListener('click', () => el._onClick?.());
  return el;
}
function syncChips(container, specs) {
  const existing = new Map([...container.children].map((el) => [el.dataset.key, el]));
  const els = specs.map((s) => {
    const el = existing.get(s.key) || createChip();
    el.dataset.key = s.key;
    el._onClick = s.onClick;
    el.setAttribute('aria-pressed', String(!!s.pressed));
    el.classList.toggle('is-empty', !!s.empty);
    const [icon, label, unit, count, sr] = el.children;
    icon.textContent = s.icon || '';
    icon.hidden = !s.icon;
    el.classList.toggle('chip-noicon', !s.icon);
    label.textContent = s.label;
    unit.textContent = s.unit || '';
    unit.hidden = !s.unit;
    count.textContent = String(s.count);
    sr.textContent = `, ${s.count} ${giftsWord(s.count)} í boði`;
    return el;
  });
  const same = els.length === container.children.length && els.every((el, i) => container.children[i] === el);
  if (!same) container.replaceChildren(...els);
}

function renderBudgetChips() {
  syncChips(
    $('#budget-chips'),
    RANGES.map((r) => {
      const n = countAvailable(r, state.category);
      // " kr." is split off so it can be visually dropped on narrow screens (still read aloud)
      const split = r.max !== Infinity && r.label.endsWith(' kr.');
      return {
        key: r.id,
        label: split ? r.label.slice(0, -4) : r.label,
        unit: split ? ' kr.' : '',
        count: n,
        pressed: state.budget === r.id,
        empty: n === 0 && r.id !== 'all',
        onClick: () => setBudget(r.id),
      };
    }),
  );
}

function renderCategoryChips() {
  const range = currentRange();
  const specs = [
    {
      key: 'all',
      label: 'Allt',
      count: countAvailable(range, 'all'),
      pressed: state.category === 'all',
      onClick: () => setCategory('all'),
    },
    ...state.categories.map((c) => {
      const n = countAvailable(range, c.id);
      return {
        key: `c:${c.id}`,
        label: c.name,
        icon: c.icon,
        count: n,
        pressed: state.category === c.id,
        empty: n === 0,
        onClick: () => setCategory(c.id),
      };
    }),
  ];
  syncChips($('#category-chips'), specs);
}

/* ---------- item cards ---------- */

const cardCache = new Map(); // id → { sig, el }

function cardFor(item) {
  const cat = categoryOf(item);
  const sig = JSON.stringify([item, cat.name, cat.icon, state.admin]);
  const hit = cardCache.get(item.id);
  if (hit && hit.sig === sig) return hit.el;
  const el = renderCard(item, cat);
  cardCache.set(item.id, { sig, el });
  return el;
}

function offerEl(o, cheapest = false) {
  const url = safeUrl(o.url);
  const store = o.store || hostOf(url) || 'Verslun';
  const kids = [
    h('span', { class: 'offer-store' }, store),
    h(
      'span',
      { class: 'offer-meta' },
      cheapest ? h('span', { class: 'cheapest-badge' }, 'Ódýrast') : null,
      o.price != null ? kr(o.price) : null,
      url ? h('span', { class: 'offer-arrow', 'aria-hidden': 'true' }, '↗') : null,
    ),
  ];
  if (!url) return h('span', { class: 'offer' }, kids);
  return h(
    'a',
    { class: 'offer', href: url, target: '_blank', rel: 'noopener noreferrer' },
    kids,
    h('span', { class: 'sr-only' }, ' (opnast í nýjum flipa)'),
  );
}

function renderCard(item, cat) {
  const titleId = `card-title-${item.id}`;
  const li = h('li', {
    class: `card${item.purchased ? ' is-purchased' : ''}${item.favorite ? ' is-favorite' : ''}`,
    tabindex: '-1',
    'aria-labelledby': titleId,
  });

  const media = mediaEl(item.imageUrl, item.name, cat.icon);
  if (item.favorite) {
    media.append(h('span', { class: 'badge-fav' }, h('span', { 'aria-hidden': 'true' }, '♥'), 'Efst á óskalistanum'));
  }
  if (item.purchased) media.append(h('span', { class: 'ribbon' }, '✓ Búið að gefa'));

  const p = priceInfo(item);
  const priceEl = p.known
    ? h('p', { class: 'price' }, p.from ? h('span', { class: 'from' }, 'frá') : null, p.from ? ' ' : null, kr(p.value))
    : h('p', { class: 'price unknown' }, 'Verð óþekkt');

  const offers = [...item.offers].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  // Mark the cheapest shop when several shops list a price (price comparison).
  const pricedCount = offers.filter((o) => o.price != null).length;
  const offersEl = offers.length
    ? h(
        'div',
        { class: 'offers' },
        h('p', { class: 'offers-label' }, 'Fáanlegt í:'),
        h('ul', { class: 'offers-list' }, offers.map((o, i) => h('li', null, offerEl(o, i === 0 && pricedCount > 1)))),
      )
    : null;

  li.append(
    media,
    h(
      'div',
      { class: 'card-body' },
      h('p', { class: 'card-cat' }, h('span', { 'aria-hidden': 'true' }, cat.icon || '🎁'), cat.name),
      h('h3', { class: 'card-title', id: titleId }, item.name),
      item.description ? h('p', { class: 'card-desc', title: item.description }, item.description) : null,
      h('div', { class: 'card-bottom' }, priceEl, offersEl),
    ),
  );

  if (state.admin) {
    const id = item.id;
    const toggle = h(
      'button',
      {
        type: 'button',
        class: `btn btn-sm btn-toggle ${item.purchased ? 'btn-outline' : 'btn-done'}`,
        onclick: (e) => togglePurchased(id, e.currentTarget),
      },
      item.purchased ? '↺ Afmerkja' : '✓ Merkja sem keypt',
    );
    li.append(
      h(
        'div',
        { class: 'card-admin' },
        toggle,
        h(
          'div',
          { class: 'card-admin-row' },
          h('button', { type: 'button', class: 'btn btn-quiet btn-sm btn-edit', onclick: () => openItemDialog(id) }, '✎ Breyta'),
          h('button', { type: 'button', class: 'btn btn-danger btn-sm', onclick: () => deleteItem(id) }, 'Eyða'),
        ),
      ),
    );
  }
  return li;
}

function skeletonCard() {
  return h(
    'li',
    { class: 'card skeleton', 'aria-hidden': 'true' },
    h('div', { class: 'media' }),
    h(
      'div',
      { class: 'card-body' },
      h('div', { class: 'sk-line', style: 'width:40%' }),
      h('div', { class: 'sk-line', style: 'width:85%;height:16px' }),
      h('div', { class: 'sk-line', style: 'width:30%;height:18px;margin-top:18px' }),
    ),
  );
}

function renderList() {
  const grid = $('#grid');
  const empty = $('#empty');
  const range = currentRange();
  const cat = state.category === 'all' ? null : state.categories.find((c) => c.id === state.category);
  $('#list-heading').textContent = cat ? `${cat.icon ? `${cat.icon} ` : ''}${cat.name}` : 'Allar gjafir';

  if (state.loading) {
    grid.setAttribute('aria-busy', 'true');
    grid.replaceChildren(...Array.from({ length: 4 }, skeletonCard));
    empty.hidden = true;
    $('#result-count').textContent = 'Sæki óskalistann…';
    return;
  }
  grid.setAttribute('aria-busy', 'false');

  if (state.loadError) {
    grid.replaceChildren();
    $('#result-count').textContent = '';
    empty.hidden = false;
    empty.replaceChildren(
      h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '☁️'),
      h('h3', null, 'Ekki tókst að sækja óskalistann'),
      h('p', null, state.loadError),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: retryLoad }, 'Reyna aftur'),
    );
    return;
  }

  const list = visibleItems();
  // prune cache for deleted items
  const ids = new Set(state.items.map((i) => i.id));
  for (const id of cardCache.keys()) if (!ids.has(id)) cardCache.delete(id);

  const els = list.map(cardFor);
  const same = els.length === grid.children.length && els.every((el, i) => grid.children[i] === el);
  if (!same) grid.replaceChildren(...els);

  const n = list.length;
  let countText = `Sýni ${n} ${giftsWord(n)}`;
  if (range.id !== 'all') countText += ` ${rangePhrase(range)}`;
  if (!state.showPurchased) {
    const hiddenCount = state.items.filter(
      (it) => it.purchased && matchesCategory(it, state.category) && inRange(effectivePrice(it), range),
    ).length;
    if (hiddenCount) countText += ` (${hiddenCount} sem búið er að gefa ${isSingular(hiddenCount) ? 'er falin' : 'eru faldar'})`;
  }
  $('#result-count').textContent = countText;

  if (n > 0) {
    empty.hidden = true;
    return;
  }
  empty.hidden = false;
  if (state.items.length === 0) {
    empty.replaceChildren(
      h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '🎁'),
      h('h3', null, 'Listinn er enn tómur'),
      state.admin
        ? h('p', null, 'Smelltu á „+ Bæta við gjöf“ til að setja fyrstu gjöfina á listann.')
        : h('p', null, 'Við erum að setja saman óskalistann – kíktu aftur fljótlega!'),
      // replaceChildren() would print a literal "null", so only spread the button in when needed.
      ...(state.admin
        ? [h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openItemDialog(null) }, '+ Bæta við gjöf')]
        : []),
    );
  } else {
    empty.replaceChildren(
      h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '🔍'),
      h('h3', null, 'Engar gjafir passa við þetta val'),
      h('p', null, 'Prófaðu annað verðbil eða annan flokk.'),
      h('button', { type: 'button', class: 'btn btn-soft', onclick: resetFilters }, 'Sýna allar gjafir'),
    );
  }
}

/* ---------- ideas ---------- */

function ideaPools(range) {
  const pool = state.items.filter(
    (it) => !it.purchased && matchesCategory(it, state.category) && effectivePrice(it) != null,
  );
  const singles = pool.filter((it) => inRange(effectivePrice(it), range));
  const pairs = [];
  if (singles.length < 3) {
    const small = pool.filter((it) => effectivePrice(it) < range.min);
    for (let i = 0; i < small.length; i++) {
      for (let j = i + 1; j < small.length; j++) {
        const sum = effectivePrice(small[i]) + effectivePrice(small[j]);
        if (sum >= range.min && sum < range.max) pairs.push([small[i], small[j]]);
      }
    }
  }
  return { singles, pairs };
}

function ideaOrder(singles) {
  return [...shuffle(singles.filter((i) => i.favorite)), ...shuffle(singles.filter((i) => !i.favorite))];
}

const pairKey = ([a, b]) => `${a.id}+${b.id}`;
/** Up to 3 pairs: unseen first, then favourites, preferring pairs that don't reuse an item. */
function pickPairs(all, avoid) {
  const favs = (p) => Number(p[0].favorite) + Number(p[1].favorite);
  const sorted = shuffle(all).sort(
    (x, y) => Number(avoid.has(pairKey(x))) - Number(avoid.has(pairKey(y))) || favs(y) - favs(x),
  );
  const picked = [];
  const used = new Set();
  for (const p of sorted) {
    if (picked.length >= 3) break;
    if (used.has(p[0].id) || used.has(p[1].id)) continue;
    picked.push(p);
    used.add(p[0].id).add(p[1].id);
  }
  for (const p of sorted) {
    if (picked.length >= 3) break;
    if (!picked.includes(p)) picked.push(p);
  }
  return picked;
}

function currentIdeaSlice() {
  const { order, offset } = ideas;
  const out = order.slice(offset, offset + 3);
  for (const it of order) {
    if (out.length >= 3) break;
    if (!out.includes(it)) out.push(it);
  }
  return out;
}

function reshuffleIdeas() {
  if (ideas.singles.length > 3) {
    ideas.offset += 3;
    if (ideas.offset >= ideas.order.length) {
      ideas.order = ideaOrder(ideas.singles);
      ideas.offset = 0;
    }
  }
  if (ideas.singles.length < 3 && ideas.pairsAll.length > 0) {
    ideas.pairPick = pickPairs(ideas.pairsAll, new Set(ideas.pairPick.map(pairKey)));
  }
  renderIdeas();
}

function offerLink(item, prefix = 'Skoða hjá') {
  const o = bestOffer(item);
  if (!o) return null;
  return h(
    'a',
    { href: o.url, target: '_blank', rel: 'noopener noreferrer' },
    `${prefix} ${o.store} `,
    h('span', { 'aria-hidden': 'true' }, '↗'),
    h('span', { class: 'sr-only' }, ' (opnast í nýjum flipa)'),
  );
}

function ideaCard(item) {
  const cat = categoryOf(item);
  return h(
    'article',
    { class: 'idea' },
    mediaEl(item.imageUrl, item.name, cat.icon),
    h(
      'div',
      { class: 'idea-body' },
      h('p', { class: 'idea-cat' }, h('span', { 'aria-hidden': 'true' }, `${cat.icon || '🎁'} `), cat.name),
      h(
        'h3',
        { class: 'idea-name' },
        item.favorite ? h('span', { class: 'heart', role: 'img', 'aria-label': 'Efst á óskalistanum:' }, '♥') : null,
        item.name,
      ),
      h('p', { class: 'idea-price' }, priceInfo(item).text),
      h(
        'div',
        { class: 'idea-actions' },
        h('button', { type: 'button', class: 'link-btn', onclick: () => focusItem(item.id) }, 'Sjá nánar'),
        offerLink(item),
      ),
    ),
  );
}

function pairPart(item) {
  const cat = categoryOf(item);
  const link = offerLink(item, 'Hjá');
  return h(
    'div',
    { class: 'pair-part' },
    mediaEl(item.imageUrl, item.name, cat.icon),
    h(
      'div',
      { class: 'pair-part-info' },
      h('p', { class: 'pair-part-name' }, item.name),
      h('p', { class: 'pair-part-price' }, kr(effectivePrice(item)), link ? ' · ' : null, link),
    ),
  );
}

function pairCard([a, b]) {
  return h(
    'article',
    { class: 'pair' },
    pairPart(a),
    h('div', { class: 'pair-plus', 'aria-hidden': 'true' }, '+'),
    pairPart(b),
    h('p', { class: 'pair-total' }, `Samtals ${kr(effectivePrice(a) + effectivePrice(b))}`),
  );
}

function neighbourRange(idx, dir) {
  for (let j = idx + dir; j >= 1 && j < RANGES.length; j += dir) {
    if (countAvailable(RANGES[j], state.category) > 0) return RANGES[j];
  }
  return null;
}

function renderIdeas() {
  const section = $('#ideas');
  const range = currentRange();
  if (range.id === 'all' || state.loading || state.loadError) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const key = `${range.id}|${state.category}|${state.dataVersion}`;
  if (ideas.key !== key) {
    const { singles, pairs } = ideaPools(range);
    Object.assign(ideas, {
      key,
      singles,
      pairsAll: pairs,
      order: ideaOrder(singles),
      offset: 0,
      pairPick: pickPairs(pairs, new Set()),
    });
  }

  const cat = state.category === 'all' ? null : state.categories.find((c) => c.id === state.category);
  $('#ideas-sub').textContent =
    `Gjafir ${rangePhrase(range)}${cat ? ` í flokknum ${cat.name}` : ''} – sem enginn er búinn að gefa enn.`;

  const shown = currentIdeaSlice();
  const list = $('#ideas-list');
  list.replaceChildren(...shown.map(ideaCard));
  list.hidden = shown.length === 0;

  const showPairs = ideas.singles.length < 3 && ideas.pairPick.length > 0;
  $('#pairs').hidden = !showPairs;
  $('#pairs-heading').textContent = ideas.singles.length ? 'Eða tvær minni gjafir saman' : 'Tvær minni gjafir saman';
  $('#pairs-list').replaceChildren(...(showPairs ? ideas.pairPick.map(pairCard) : []));

  const emptyEl = $('#ideas-empty');
  if (ideas.singles.length === 0) {
    emptyEl.hidden = false;
    if (showPairs) {
      emptyEl.replaceChildren(
        h('p', null, 'Engin ein gjöf á listanum er á þessu verðbili – en tvær minni gjafir saman gætu passað vel.'),
      );
    } else {
      const idx = RANGES.indexOf(range);
      const near = [neighbourRange(idx, -1), neighbourRange(idx, 1)].filter(Boolean);
      const allCatsCount = state.category !== 'all' ? countAvailable(range, 'all') : 0;
      emptyEl.replaceChildren(
        h('p', null, h('strong', null, 'Því miður er ekkert á listanum á þessu verðbili eins og er.')),
        near.length ? h('p', { class: 'muted' }, 'Kannski hentar verðbilið hér fyrir ofan eða neðan?') : null,
        near.length || allCatsCount
          ? h(
              'div',
              { class: 'chips' },
              near.map((r) =>
                h(
                  'button',
                  { type: 'button', class: 'btn btn-soft btn-sm', onclick: () => setBudget(r.id) },
                  `${r.label} (${countAvailable(r, state.category)})`,
                ),
              ),
              allCatsCount
                ? h(
                    'button',
                    { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => setCategory('all') },
                    `Skoða alla flokka (${allCatsCount})`,
                  )
                : null,
            )
          : null,
      );
    }
  } else {
    emptyEl.hidden = true;
    emptyEl.replaceChildren();
  }

  const canShuffle =
    ideas.singles.length > 3 || (ideas.singles.length < 3 && ideas.pairsAll.length > ideas.pairPick.length);
  $('#ideas-shuffle').hidden = !canShuffle;
}

function focusItem(id) {
  const el = cardCache.get(id)?.el;
  if (!el || !el.isConnected) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth; // restart animation
  el.classList.add('flash');
}

function focusCardControl(id, selector) {
  const el = cardCache.get(id)?.el;
  const target = el?.isConnected ? el.querySelector(selector) : null;
  target?.focus({ preventScroll: true });
}

function renderAll() {
  renderHeader();
  renderAdminBar();
  renderBudgetChips();
  renderCategoryChips();
  renderIdeas();
  $('#sort').value = state.sort;
  $('#show-purchased').checked = state.showPurchased;
  renderList();
}

/* ---------- guest actions ---------- */

function setBudget(id) {
  state.budget = id;
  if (state.sortAuto) state.sort = autoSortFor(id);
  savePrefs();
  renderAll();
}
function setCategory(id) {
  state.category = id;
  savePrefs();
  renderAll();
}
function resetFilters() {
  state.budget = 'all';
  state.category = 'all';
  state.showPurchased = true;
  if (state.sortAuto) state.sort = autoSortFor('all');
  savePrefs();
  renderAll();
}
async function retryLoad() {
  state.loading = true;
  state.loadError = '';
  renderAll();
  await refreshAll();
}

/* ======================================================================
   Dialogs – generic behaviour
   ====================================================================== */

const dlgLogin = $('#dlg-login');
const dlgItem = $('#dlg-item');
const dlgCats = $('#dlg-categories');
const dlgSettings = $('#dlg-settings');

function closeDialog(dlg) {
  if (dlg === dlgItem && itemForm.dirty && !confirm('Viltu loka án þess að vista breytingarnar?')) return;
  dlg.close();
}

for (const dlg of [dlgLogin, dlgItem, dlgCats, dlgSettings]) {
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeDialog(dlg);
  });
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeDialog(dlg);
  });
  if (dlg !== dlgItem) {
    // click on the backdrop closes small dialogs
    let downOnBackdrop = false;
    dlg.addEventListener('mousedown', (e) => {
      downOnBackdrop = e.target === dlg;
    });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg && downOnBackdrop) dlg.close();
    });
  }
}

function showModal(dlg, focusEl) {
  if (!dlg.open) dlg.showModal();
  focusEl?.focus();
}

/* ---------- login ---------- */

function openLogin() {
  $('#login-form').reset();
  $('#login-error').hidden = true;
  showModal(dlgLogin, $('#login-code'));
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#login-code');
  const errEl = $('#login-error');
  const btn = $('#login-submit');
  const code = input.value.trim();
  if (!code) {
    errEl.textContent = 'Sláðu inn aðgangskóðann.';
    errEl.hidden = false;
    input.focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Skrái inn…';
  try {
    await api('/api/admin/login', { method: 'POST', body: { code } });
    dlgLogin.close();
    if (/[?&]admin\b/.test(location.search) || location.hash === '#admin') {
      try {
        history.replaceState(null, '', location.pathname);
      } catch {
        /* ignore */
      }
    }
    await refreshAll();
    toast('Innskráning tókst – stjórnborðið er opið.');
  } catch (err) {
    errEl.textContent = err?.message || defaultError(0);
    errEl.hidden = false;
    input.select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Skrá inn';
  }
});

$('#btn-access').addEventListener('click', openLogin);

$('#btn-logout').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await api('/api/admin/logout', { method: 'POST' });
    state.admin = false;
    renderAll();
    toast('Þú hefur skráð þig út.');
  } catch (err) {
    reportError(err);
  } finally {
    btn.disabled = false;
  }
});

/* ======================================================================
   Admin – item actions
   ====================================================================== */

async function togglePurchased(id, btn) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const next = !item.purchased;
  if (btn) btn.disabled = true;
  try {
    const updated = await adminApi(`/api/items/${encodeURIComponent(id)}/purchased`, {
      method: 'POST',
      body: { purchased: next },
    });
    upsertItem(updated && updated.id ? updated : { ...item, purchased: next });
    renderAll();
    focusCardControl(id, '.btn-toggle');
    toast(next ? `„${item.name}“ merkt sem keypt ✓` : `Merking tekin af „${item.name}“`);
  } catch (err) {
    reportError(err);
    if (btn) btn.disabled = false;
  }
}

async function deleteItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  if (!confirm(`Viltu eyða „${item.name}“ af óskalistanum?`)) return;
  try {
    await adminApi(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.items = state.items.filter((i) => i.id !== id);
    state.dataVersion++;
    renderAll();
    toast('Gjöfinni var eytt.');
  } catch (err) {
    reportError(err);
  }
}

/* ======================================================================
   Admin – add / edit item dialog
   ====================================================================== */

const itemForm = {
  el: $('#item-form'),
  editingId: null,
  dirty: false,
  lookupCtrl: null,
  lookupTimer: 0,
};
const fName = $('#f-name');
const fDesc = $('#f-desc');
const fCategory = $('#f-category');
const fPrice = $('#f-price');
const fImage = $('#f-image');
const fFavorite = $('#f-favorite');
const fPurchased = $('#f-purchased');
const offersRows = $('#offers-rows');

function fillCategorySelect(selected) {
  fCategory.replaceChildren(
    ...(state.categories.length ? state.categories : [FALLBACK_CATEGORY]).map((c) => {
      const opt = h('option', { value: c.id }, `${c.icon ? `${c.icon} ` : ''}${c.name}`);
      return opt;
    }),
  );
  fCategory.value = selected;
  if (fCategory.value !== selected && fCategory.options.length) fCategory.selectedIndex = 0;
}

function openItemDialog(id) {
  const item = id ? state.items.find((i) => i.id === id) : null;
  if (id && !item) return;
  abortLookup();
  abortCompare();
  $('#compare-results').replaceChildren();
  itemForm.editingId = item ? item.id : null;
  $('#item-title').textContent = item ? 'Breyta gjöf' : 'Ný gjöf';
  $('#item-submit').textContent = item ? 'Vista breytingar' : 'Vista gjöf';
  itemForm.el.reset();
  clearItemError();
  $('#lookup-query').value = '';
  $('#lookup-status').replaceChildren();
  $('#lookup-results').replaceChildren();
  $('#lookup-hint').textContent = state.aiSearch
    ? 'Við leitum að verði, verslunum og mynd á netinu. Hlekkur beint á vöruna gefur nákvæmustu niðurstöðuna.'
    : 'Ábending: það virkar best að líma inn hlekk á vöruna';

  const defaultCat = state.category !== 'all' ? state.category : state.categories[0]?.id || 'annad';
  fillCategorySelect(item ? categoryOf(item).id : defaultCat);
  offersRows.replaceChildren();
  fPrice.dataset.auto = '';

  if (item) {
    fName.value = item.name;
    fDesc.value = item.description;
    fImage.value = item.imageUrl;
    fPrice.value = item.price != null ? fmtNumber.format(item.price) : '';
    const prices = offerPrices(item);
    if (item.price != null && prices.length && item.price === Math.min(...prices)) fPrice.dataset.auto = '1';
    item.offers.forEach((o) => addOfferRow(o));
    fFavorite.checked = item.favorite;
    fPurchased.checked = item.purchased;
  }
  $('#f-purchased-wrap').hidden = !item;
  updatePricePlaceholder();
  updateImagePreview();
  itemForm.dirty = false;
  $('#item-body').scrollTop = 0;
  showModal(dlgItem, item ? fName : $('#lookup-query'));
}

dlgItem.addEventListener('close', () => {
  abortLookup();
  abortCompare();
});
itemForm.el.addEventListener('input', () => {
  itemForm.dirty = true;
});

/* ---------- offers editor ---------- */

function addOfferRow(o = { store: '', url: '', price: null }, focus = false) {
  const store = h('input', { class: 'o-store', type: 'text', maxlength: '100', placeholder: 'Verslun', 'aria-label': 'Verslun' });
  const url = h('input', {
    class: 'o-url',
    type: 'url',
    inputmode: 'url',
    maxlength: '2000',
    placeholder: 'https://… (hlekkur á vöruna)',
    'aria-label': 'Hlekkur á vöruna í versluninni',
  });
  const price = h('input', { class: 'o-price', type: 'text', inputmode: 'numeric', placeholder: 'Verð', 'aria-label': 'Verð í versluninni (kr.)' });
  store.value = o.store || '';
  url.value = o.url || '';
  price.value = o.price != null ? fmtNumber.format(o.price) : '';
  const row = h('div', { class: 'offer-row' }, store, url, price);
  row.append(
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn o-remove',
        'aria-label': 'Fjarlægja verslun',
        title: 'Fjarlægja verslun',
        onclick: () => {
          row.remove();
          itemForm.dirty = true;
          onOffersChanged();
          $('#add-offer').focus();
        },
      },
      '✕',
    ),
  );
  price.addEventListener('input', onOffersChanged);
  offersRows.append(row);
  if (focus) store.focus();
  return row;
}

function readOfferRows() {
  return [...offersRows.querySelectorAll('.offer-row')].map((row) => ({
    row,
    storeEl: $('.o-store', row),
    urlEl: $('.o-url', row),
    priceEl: $('.o-price', row),
  }));
}

function minOfferPriceInForm() {
  const prices = readOfferRows()
    .map((r) => parsePrice(r.priceEl.value))
    .filter((p) => p.ok && p.value != null)
    .map((p) => p.value);
  return prices.length ? Math.min(...prices) : null;
}

function onOffersChanged() {
  if (fPrice.dataset.auto === '1') {
    const min = minOfferPriceInForm();
    if (min != null) fPrice.value = fmtNumber.format(min);
  }
  updatePricePlaceholder();
}
function updatePricePlaceholder() {
  const min = minOfferPriceInForm();
  fPrice.placeholder = min != null ? `Sjálfkrafa: ${kr(min)}` : 't.d. 12.990';
}

fPrice.addEventListener('input', () => {
  fPrice.dataset.auto = '';
});
$('#add-offer').addEventListener('click', () => {
  addOfferRow(undefined, true);
  itemForm.dirty = true;
});

function hasOfferUrl(url) {
  const target = safeUrl(url);
  return !!target && readOfferRows().some((r) => safeUrl(r.urlEl.value) === target);
}
function addOfferFromResult(r) {
  const url = safeUrl(r.url);
  if (!url || hasOfferUrl(url)) return false;
  // reuse an empty row if there is one
  const empty = readOfferRows().find((x) => !x.storeEl.value.trim() && !x.urlEl.value.trim() && !x.priceEl.value.trim());
  if (empty) empty.row.remove();
  addOfferRow({ store: r.store || hostOf(url), url, price: r.price });
  itemForm.dirty = true;
  onOffersChanged();
  return true;
}

/* ---------- image preview ---------- */

let previewTimer = 0;
function updateImagePreview() {
  const box = $('#f-image-preview');
  const src = safeUrl(fImage.value);
  const icon = state.categories.find((c) => c.id === fCategory.value)?.icon || '🎁';
  if (!src) {
    box.replaceChildren(placeholder(icon));
    return;
  }
  const img = h('img', { alt: '', referrerpolicy: 'no-referrer' });
  img.addEventListener(
    'error',
    () => img.replaceWith(h('div', { class: 'ph' }, h('span', { class: 'ph-text' }, 'Mynd fannst ekki'))),
    { once: true },
  );
  img.src = src;
  box.replaceChildren(img);
}
fImage.addEventListener('input', () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updateImagePreview, 300);
});
fCategory.addEventListener('change', () => {
  if (!safeUrl(fImage.value)) updateImagePreview();
});

/* ---------- price comparison: same product in other Icelandic shops ---------- */

function abortCompare() {
  if (itemForm.compareCtrl) {
    itemForm.compareCtrl.abort();
    itemForm.compareCtrl = null;
  }
}

$('#compare-btn').addEventListener('click', () => runCompare({ auto: false }));

async function runCompare({ auto }) {
  const box = $('#compare-results');
  const name = fName.value.trim();
  if (!name) {
    box.replaceChildren(h('p', { class: 'lookup-msg' }, 'Skrifaðu heiti vörunnar fyrst, þá get ég borið saman verð.'));
    fName.focus();
    return;
  }
  abortCompare();
  const ctrl = new AbortController();
  itemForm.compareCtrl = ctrl;
  const url = readOfferRows().map((r) => safeUrl(r.urlEl.value)).find(Boolean) || '';
  const btn = $('#compare-btn');
  btn.disabled = true;
  box.replaceChildren(
    h(
      'div',
      { class: 'loading', role: 'status' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', { class: 'loading-text' }, `Ber saman verð á „${name}“ í íslenskum vefverslunum…`),
      h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => ctrl.abort() }, 'Hætta við'),
    ),
  );
  try {
    const data = await adminApi('/api/compare', { method: 'POST', body: { name, url }, signal: ctrl.signal });
    if (itemForm.compareCtrl !== ctrl) return;
    renderCompare(data || {}, auto);
  } catch (err) {
    if (itemForm.compareCtrl !== ctrl && !ctrl.signal.aborted) return;
    box.replaceChildren(
      ctrl.signal.aborted
        ? h('p', { class: 'lookup-msg' }, 'Hætt við verðsamanburð.')
        : h('p', { class: 'lookup-msg is-error' }, err?.message || defaultError(0)),
    );
  } finally {
    if (itemForm.compareCtrl === ctrl) itemForm.compareCtrl = null;
    btn.disabled = false;
  }
}

function renderCompare(data, auto) {
  const box = $('#compare-results');
  const offers = (Array.isArray(data.offers) ? data.offers : [])
    .map((o) => ({ ...normResult(o), match: o?.match === 'code' ? 'code' : 'name', matchCode: str(o?.matchCode) }))
    .filter((o) => safeUrl(o.url));
  if (!offers.length) {
    const msg = data.message || 'Fann engar aðrar íslenskar verslanir með þessa vöru.';
    box.replaceChildren(h('p', { class: 'lookup-msg' }, auto ? `Verðsamanburður: ${msg}` : msg));
    return;
  }
  offers.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  const current = minOfferPriceInForm();
  const cheapest = Math.min(current ?? Infinity, ...offers.map((o) => o.price ?? Infinity));

  const rows = offers.map((o) => {
    const url = safeUrl(o.url);
    const already = hasOfferUrl(url);
    const addBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, already ? '✓ Á listanum' : '+ Bæta við');
    addBtn.disabled = already;
    addBtn.addEventListener('click', () => {
      addOfferFromResult(o);
      addBtn.textContent = '✓ Á listanum';
      addBtn.disabled = true;
      syncAddAll();
    });
    return {
      addBtn,
      el: h(
        'li',
        { class: `compare-row${o.price === cheapest ? ' is-cheapest' : ''}` },
        h(
          'div',
          { class: 'compare-main' },
          h(
            'a',
            { class: 'compare-store', href: url, target: '_blank', rel: 'noopener noreferrer' },
            o.store || hostOf(url),
            h('span', { 'aria-hidden': 'true' }, ' ↗'),
            h('span', { class: 'sr-only' }, ' (opnast í nýjum flipa)'),
          ),
          o.price === cheapest ? h('span', { class: 'cheapest-badge' }, 'Ódýrast') : null,
          h('span', { class: 'compare-name' }, o.name || ''),
          o.match === 'code'
            ? h('span', { class: 'match-tag is-code' }, `✓ Sama vörunúmer${o.matchCode ? ` (${o.matchCode})` : ''}`)
            : h('span', { class: 'match-tag' }, 'Líklega sama vara – athugið nafnið'),
        ),
        h('span', { class: 'compare-price' }, o.price != null ? kr(o.price) : 'Verð óþekkt'),
        addBtn,
      ),
    };
  });

  const addAll = h('button', { type: 'button', class: 'btn btn-soft btn-sm' }, '+ Bæta öllum við');
  const syncAddAll = () => {
    addAll.hidden = rows.every((r) => r.addBtn.disabled);
  };
  addAll.addEventListener('click', () => {
    for (const r of rows) if (!r.addBtn.disabled) r.addBtn.click();
  });
  syncAddAll();

  box.replaceChildren(
    h(
      'div',
      { class: 'compare-head' },
      h('p', { class: 'compare-title' }, `Verð í öðrum verslunum (${offers.length})`),
      addAll,
    ),
    h('ul', { class: 'compare-list' }, rows.map((r) => r.el)),
    h(
      'p',
      { class: 'muted small' },
      `Leitað í: ${data.shopsSearched || 'Líf og List, Kúnígúnd, Byggt og búið, Kokka'}. Verð eru sótt núna og geta breyst.`,
    ),
  );
}

/* ---------- lookup ---------- */

function abortLookup() {
  if (itemForm.lookupCtrl) {
    itemForm.lookupCtrl.abort();
    itemForm.lookupCtrl = null;
  }
}

function setLookupBusy(busy) {
  $('#lookup-submit').disabled = busy;
  $('#lookup-query').readOnly = busy;
}

$('#lookup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const query = $('#lookup-query').value.trim();
  if (!query) {
    $('#lookup-status').replaceChildren(
      h('p', { class: 'lookup-msg' }, 'Skrifaðu heiti vöru eða límdu inn hlekk til að leita.'),
    );
    $('#lookup-query').focus();
    return;
  }
  runLookup(query);
});

async function runLookup(query) {
  abortLookup();
  const ctrl = new AbortController();
  itemForm.lookupCtrl = ctrl;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, LOOKUP_TIMEOUT_MS);

  const status = $('#lookup-status');
  const results = $('#lookup-results');
  results.replaceChildren();
  const started = Date.now();
  const timeEl = h('span', { class: 'loading-time' }, '0 sek.');
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => ctrl.abort() }, 'Hætta við leit');
  status.replaceChildren(
    h(
      'div',
      { class: 'loading', role: 'status' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', { class: 'loading-text' }, 'Leita að verði og verslunum… þetta getur tekið allt að mínútu', timeEl),
      cancelBtn,
    ),
  );
  const tick = setInterval(() => {
    timeEl.textContent = `${Math.round((Date.now() - started) / 1000)} sek.`;
  }, 1000);
  setLookupBusy(true);

  try {
    const data = await adminApi('/api/lookup', { method: 'POST', body: { query }, signal: ctrl.signal });
    if (itemForm.lookupCtrl !== ctrl) return;
    status.replaceChildren();
    renderLookupResults(data || {});
  } catch (err) {
    if (itemForm.lookupCtrl !== ctrl && !ctrl.signal.aborted) return;
    if (ctrl.signal.aborted) {
      status.replaceChildren(
        timedOut
          ? h('p', { class: 'lookup-msg' }, 'Leitin tók of langan tíma. Prófaðu að líma inn hlekk beint á vöruna, eða fylltu út hér fyrir neðan.')
          : h('p', { class: 'lookup-msg' }, 'Hætt við leit.'),
      );
    } else {
      status.replaceChildren(h('p', { class: 'lookup-msg is-error' }, err?.message || defaultError(0)));
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(tick);
    if (itemForm.lookupCtrl === ctrl) itemForm.lookupCtrl = null;
    if (!itemForm.lookupCtrl) setLookupBusy(false);
  }
}

function renderLookupResults(data) {
  const wrap = $('#lookup-results');
  const results = Array.isArray(data.results) ? data.results.map(normResult) : [];
  const kids = [];
  if (typeof data.message === 'string' && data.message.trim()) {
    kids.push(h('p', { class: 'lookup-msg' }, data.message));
  }
  if (!results.length) {
    if (!kids.length) {
      kids.push(h('p', { class: 'lookup-msg' }, 'Ekkert fannst. Prófaðu annað orðalag eða límdu inn hlekk beint á vöruna.'));
    }
    wrap.replaceChildren(...kids);
    return;
  }
  kids.push(
    h(
      'p',
      { class: 'results-help' },
      results.length === 1
        ? '„Nota þessa“ fyllir út formið hér fyrir neðan.'
        : '„Nota þessa“ fyllir út formið hér fyrir neðan. Með „+ Bæta við sem verslun“ getið þið bætt fleiri verslunum við sömu gjöfina.',
    ),
    h('div', { class: 'results-grid' }, results.map(resultCard)),
  );
  wrap.replaceChildren(...kids);
}

function resultCard(r) {
  const url = safeUrl(r.url);
  const store = r.store || hostOf(url) || 'Óþekkt verslun';
  const converted = r.currency && r.currency.toUpperCase() !== 'ISK';
  const stateEl = h('p', { class: 'result-state', 'aria-live': 'polite' });
  const card = h('article', { class: 'result' });

  const useBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Nota þessa');
  const addBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, '+ Bæta við sem verslun');
  if (!url) {
    addBtn.disabled = true;
    addBtn.title = 'Enginn hlekkur fylgir þessari niðurstöðu';
  }

  useBtn.addEventListener('click', () => {
    if (r.name) fName.value = r.name;
    if (safeUrl(r.imageUrl)) {
      fImage.value = r.imageUrl;
      updateImagePreview();
    }
    if (r.price != null) {
      fPrice.value = fmtNumber.format(r.price);
      fPrice.dataset.auto = '1';
    }
    addOfferFromResult(r);
    onOffersChanged();
    itemForm.dirty = true;
    clearItemError();
    for (const other of card.parentElement?.querySelectorAll('.result.is-used') || []) {
      other.classList.remove('is-used');
      other.classList.add('is-added');
      const st = $('.result-state', other);
      if (st) st.textContent = '✓ Bætt við sem verslun';
    }
    card.classList.add('is-used');
    stateEl.textContent = '✓ Valið – sjá formið hér fyrir neðan';
    addBtn.disabled = true;
    // Look for the same product in other Icelandic shops right away.
    runCompare({ auto: true });
  });
  addBtn.addEventListener('click', () => {
    const added = addOfferFromResult(r);
    card.classList.add('is-added');
    stateEl.textContent = added ? '✓ Bætt við sem verslun' : '✓ Þessi verslun er þegar á listanum';
    addBtn.disabled = true;
  });

  card.append(
    mediaEl(r.imageUrl, r.name, '🎁'),
    h(
      'div',
      { class: 'result-body' },
      h('p', { class: 'result-name' }, r.name || 'Ónefnd vara'),
      h(
        'p',
        { class: 'result-store' },
        url
          ? h(
              'a',
              { href: url, target: '_blank', rel: 'noopener noreferrer' },
              `${store} `,
              h('span', { 'aria-hidden': 'true' }, '↗'),
              h('span', { class: 'sr-only' }, ' (opnast í nýjum flipa)'),
            )
          : store,
      ),
      r.price != null
        ? h(
            'p',
            { class: 'result-price' },
            `${converted ? '≈ ' : ''}${kr(r.price)}`,
            converted && r.originalPrice != null
              ? h('span', { class: 'result-orig' }, ` (${fmtDecimal.format(r.originalPrice)} ${r.currency})`)
              : null,
          )
        : h('p', { class: 'result-price unknown muted' }, 'Verð óþekkt'),
      stateEl,
      h('div', { class: 'result-actions' }, useBtn, addBtn),
    ),
  );
  return card;
}

/* ---------- save item ---------- */

function clearItemError() {
  $('#item-error').hidden = true;
  for (const el of itemForm.el.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
}
function itemError(field, message) {
  const errEl = $('#item-error');
  errEl.textContent = message;
  errEl.hidden = false;
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
  return null;
}

function collectItem() {
  clearItemError();
  const name = fName.value.trim();
  if (!name) return itemError(fName, 'Skrifaðu nafn á gjöfinni.');
  const price = parsePrice(fPrice.value);
  if (!price.ok) return itemError(fPrice, 'Verðið þarf að vera tala, t.d. 12.990.');
  const imageUrl = fImage.value.trim();
  if (imageUrl && !safeUrl(imageUrl)) return itemError(fImage, 'Hlekkur á mynd þarf að byrja á http:// eða https://');

  const offers = [];
  for (const r of readOfferRows()) {
    const store = r.storeEl.value.trim();
    const url = r.urlEl.value.trim();
    const op = parsePrice(r.priceEl.value);
    if (!store && !url) continue; // empty row (maybe just a price) → ignore
    if (url && !safeUrl(url)) return itemError(r.urlEl, 'Hlekkur á verslun þarf að byrja á http:// eða https://');
    if (!op.ok) return itemError(r.priceEl, 'Verð verslunar þarf að vera tala, t.d. 12.990.');
    offers.push({ store: store || hostOf(url), url: url ? safeUrl(url) : '', price: op.value });
  }

  const body = {
    name,
    description: fDesc.value.trim(),
    categoryId: fCategory.value || 'annad',
    imageUrl: imageUrl ? safeUrl(imageUrl) : '',
    price: price.value,
    offers,
    favorite: fFavorite.checked,
  };
  if (itemForm.editingId) body.purchased = fPurchased.checked;
  return body;
}

itemForm.el.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = collectItem();
  if (!body) return;
  const btn = $('#item-submit');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Vista…';
  const editing = itemForm.editingId;
  try {
    const saved = editing
      ? await adminApi(`/api/items/${encodeURIComponent(editing)}`, { method: 'PUT', body })
      : await adminApi('/api/items', { method: 'POST', body });
    const item = upsertItem(saved);
    itemForm.dirty = false;
    dlgItem.close();
    renderAll();
    const card = cardCache.get(item.id)?.el;
    if (card?.isConnected) {
      if (editing) focusCardControl(item.id, '.btn-edit');
      else focusItem(item.id);
      toast(editing ? 'Breytingarnar voru vistaðar.' : `„${item.name}“ er komin á listann ♥`);
    } else {
      toast(
        editing
          ? 'Breytingarnar voru vistaðar (gjöfin sést ekki með núverandi síum).'
          : 'Gjöfin var vistuð – hún sést ekki með núverandi síum.',
      );
    }
  } catch (err) {
    if (!err?.handled) itemError(null, err?.message || defaultError(0));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('#btn-add-item').addEventListener('click', () => openItemDialog(null));

/* ======================================================================
   Admin – categories
   ====================================================================== */

function catRow(c) {
  const n = state.items.filter((it) => categoryOf(it).id === c.id).length;
  const icon = h('input', { type: 'text', class: 'cat-icon-input', maxlength: '8', 'aria-label': `Tákn fyrir flokkinn ${c.name}` });
  const name = h('input', { type: 'text', class: 'cat-name-input', maxlength: '60', 'aria-label': `Heiti flokksins ${c.name}` });
  icon.value = c.icon;
  name.value = c.name;
  const save = h('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: true }, 'Vista');
  const del =
    c.id === 'annad'
      ? null
      : h('button', { type: 'button', class: 'btn btn-danger btn-sm', 'aria-label': `Eyða flokknum ${c.name}` }, 'Eyða');

  const changed = () => {
    save.disabled = !name.value.trim() || (icon.value.trim() === c.icon && name.value.trim() === c.name);
  };
  icon.addEventListener('input', changed);
  name.addEventListener('input', changed);
  for (const input of [icon, name]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!save.disabled) save.click();
      }
    });
  }

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const updated = await adminApi(`/api/categories/${encodeURIComponent(c.id)}`, {
        method: 'PUT',
        body: { name: name.value.trim(), icon: icon.value.trim() },
      });
      const cat = normCategory(updated?.id ? updated : { ...c, name: name.value.trim(), icon: icon.value.trim() });
      state.categories = state.categories.map((x) => (x.id === c.id ? cat : x));
      state.dataVersion++;
      renderAll();
      renderCatsDialog();
      $(`.cats-list li[data-id="${CSS.escape(cat.id)}"] .cat-name-input`)?.focus();
      toast('Flokkurinn var vistaður.');
    } catch (err) {
      reportError(err);
      changed();
    }
  });

  del?.addEventListener('click', async () => {
    if (!confirm(`Eyða flokknum „${c.name}“? Gjafir í honum færast í „Annað“.`)) return;
    del.disabled = true;
    try {
      await adminApi(`/api/categories/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      if (state.category === c.id) state.category = 'all';
      await loadList();
      savePrefs();
      renderAll();
      renderCatsDialog();
      $('#cat-new-name').focus();
      toast('Flokknum var eytt.');
    } catch (err) {
      reportError(err);
      del.disabled = false;
    }
  });

  return h(
    'li',
    { class: 'cat-row', 'data-id': c.id },
    icon,
    name,
    h('span', { class: 'cat-count' }, `${n} ${giftsWord(n)}`),
    h('span', { class: 'cat-actions' }, save, del),
  );
}

function renderCatsDialog() {
  $('#cats-list').replaceChildren(...state.categories.map(catRow));
}

$('#btn-categories').addEventListener('click', () => {
  renderCatsDialog();
  $('#cat-new-form').reset();
  showModal(dlgCats, null);
});

$('#cat-new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nameEl = $('#cat-new-name');
  const iconEl = $('#cat-new-icon');
  const name = nameEl.value.trim();
  if (!name) {
    toast('Flokkurinn þarf að heita eitthvað.', 'error');
    nameEl.focus();
    return;
  }
  const btn = e.submitter || $('#cat-new-form button[type=submit]');
  btn.disabled = true;
  try {
    const created = await adminApi('/api/categories', { method: 'POST', body: { name, icon: iconEl.value.trim() } });
    state.categories.push(normCategory(created));
    state.dataVersion++;
    $('#cat-new-form').reset();
    renderAll();
    renderCatsDialog();
    nameEl.focus();
    toast(`Flokknum „${name}“ var bætt við.`);
  } catch (err) {
    reportError(err);
  } finally {
    btn.disabled = false;
  }
});

/* ======================================================================
   Admin – settings
   ====================================================================== */

$('#btn-settings').addEventListener('click', () => {
  $('#s-title').value = state.settings.title || '';
  $('#s-subtitle').value = state.settings.subtitle || '';
  $('#s-intro').value = state.settings.intro || '';
  showModal(dlgSettings, $('#s-title'));
});

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#s-title').value.trim();
  if (!title) {
    toast('Titillinn má ekki vera tómur.', 'error');
    $('#s-title').focus();
    return;
  }
  const btn = $('#settings-submit');
  btn.disabled = true;
  try {
    const saved = await adminApi('/api/settings', {
      method: 'PUT',
      body: { title, subtitle: $('#s-subtitle').value.trim(), intro: $('#s-intro').value.trim() },
    });
    state.settings = { ...state.settings, ...(saved && typeof saved === 'object' ? saved : {}) };
    dlgSettings.close();
    renderHeader();
    toast('Stillingarnar voru vistaðar.');
  } catch (err) {
    reportError(err);
  } finally {
    btn.disabled = false;
  }
});

/* ======================================================================
   Static controls & boot
   ====================================================================== */

$('#sort').addEventListener('change', (e) => {
  const value = e.target.value;
  if (!SORTS.includes(value)) return;
  state.sort = value;
  state.sortAuto = value === autoSortFor(state.budget);
  savePrefs();
  renderList();
});
$('#show-purchased').addEventListener('change', (e) => {
  state.showPurchased = e.target.checked;
  savePrefs();
  renderAll();
});
$('#ideas-shuffle').addEventListener('click', reshuffleIdeas);

function wantsAdmin() {
  return new URLSearchParams(location.search).has('admin') || location.hash === '#admin';
}
window.addEventListener('hashchange', () => {
  if (location.hash === '#admin' && !state.admin) openLogin();
});

async function init() {
  await initBackend();
  loadPrefs();
  renderAll(); // skeleton
  await refreshAll();
  if (wantsAdmin() && !state.admin) openLogin();
}

init();
