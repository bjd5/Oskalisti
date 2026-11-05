// Wishlist data rules shared by the Node server (server/store.js) and the browser
// (GitHub Pages mode). Pure ESM with no Node or DOM dependencies.

export const DATA_FILE_NAME = 'oskalisti.json';
export const FALLBACK_CATEGORY_ID = 'annad';

export const DEFAULT_SETTINGS = Object.freeze({
  title: 'Óskalistinn okkar',
  subtitle: 'Hugmyndir að gjöfum – jól, afmæli, innflutningur og önnur tilefni',
  intro: '',
});

export const DEFAULT_CATEGORIES = Object.freeze([
  { id: 'eldhusid', name: 'Í eldhúsið', icon: '🍳' },
  { id: 'heimilid', name: 'Fyrir heimilið', icon: '🏡' },
  { id: 'hjonarumid', name: 'Hjónarúmið', icon: '🛏️' },
  { id: 'bordstofan', name: 'Borðstofan', icon: '🍽️' },
  { id: FALLBACK_CATEGORY_ID, name: 'Annað', icon: '🎁' },
]);

const DEFAULT_CATEGORY_ICON = '🎁';

const LIMITS = {
  name: 200,
  description: 1000,
  store: 100,
  url: 2000,
  categoryName: 60,
  categoryIcon: 16,
  title: 100,
  subtitle: 200,
  intro: 2000,
  offers: 20,
};

/** Error caused by invalid input – maps to HTTP 400. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

/** Requested record does not exist – maps to HTTP 404. */
export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

// ---------------------------------------------------------------------------
// Sanitizing helpers
// ---------------------------------------------------------------------------

/** Trim a string and cap it at `max` characters (code points, so emoji stay intact). */
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return Array.from(trimmed).slice(0, max).join('').trim();
}

/** Like cleanText, but collapses newlines/tabs/runs of spaces – for names and titles. */
export function cleanLine(value, max) {
  return typeof value === 'string' ? cleanText(value.replace(/\s+/g, ' '), max) : '';
}

/** Return a normalized http(s) URL, or "" for anything else (javascript:, data:, relative, too long…). */
export function sanitizeUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > LIMITS.url) return '';
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  return url.href.length > LIMITS.url ? '' : url.href;
}

/**
 * Parse an ISK price into a non-negative integer, or null when empty.
 * Accepts numbers and strings such as "12.990", "12 990 kr." or "12990".
 * Throws ValidationError for anything that is not a valid price.
 */
export function parsePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  let number = value;
  if (typeof value === 'string') {
    const compact = value.replace(/\s|kr\.?|isk/gi, '').replace(/\./g, '').replace(',', '.');
    if (!compact) return null;
    number = /^-?\d+(\.\d+)?$/.test(compact) ? Number(compact) : NaN;
  }
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new ValidationError('Ógilt verð.');
  }
  const rounded = Math.round(number);
  if (rounded < 0) throw new ValidationError('Verð má ekki vera neikvætt.');
  if (!Number.isSafeInteger(rounded)) throw new ValidationError('Ógilt verð.');
  return rounded;
}

/** Turn an Icelandic category name into a URL-friendly id: "Í eldhúsið" → "i-eldhusid". */
export function slugify(name) {
  const replacements = { á: 'a', ð: 'd', þ: 'th', æ: 'ae', ö: 'o', é: 'e', í: 'i', ó: 'o', ú: 'u', ý: 'y' };
  return String(name)
    .toLowerCase()
    .replace(/[áðþæöéíóúý]/g, (ch) => replacements[ch])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip remaining accents (e.g. ü, ñ)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function sanitizeOffers(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('Ógildur listi yfir verslanir.');
  return value
    .filter((offer) => offer && typeof offer === 'object')
    .map((offer) => ({
      store: cleanLine(offer.store, LIMITS.store),
      url: sanitizeUrl(offer.url),
      price: parsePrice(offer.price),
    }))
    .filter((offer) => offer.store || offer.url)
    .slice(0, LIMITS.offers);
}

function lowestOfferPrice(offers) {
  const prices = offers.map((offer) => offer.price).filter((price) => price !== null);
  return prices.length ? Math.min(...prices) : null;
}

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// ---------------------------------------------------------------------------
// Data shape
// ---------------------------------------------------------------------------

export function seedData() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
    items: [],
  };
}

/** Make sure data read from disk has the expected shape (tolerates hand edits). */
export function normalizeData(raw) {
  const data = asObject(raw);
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof data.settings?.[key] === 'string') settings[key] = data.settings[key];
  }

  const categories = (Array.isArray(data.categories) ? data.categories : []).filter(
    (category) => category && typeof category.id === 'string' && typeof category.name === 'string',
  );
  if (!categories.some((category) => category.id === FALLBACK_CATEGORY_ID)) {
    categories.push({ ...DEFAULT_CATEGORIES.find((category) => category.id === FALLBACK_CATEGORY_ID) });
  }

  const categoryIds = new Set(categories.map((category) => category.id));
  const items = (Array.isArray(data.items) ? data.items : [])
    .filter((item) => item && typeof item.id === 'string')
    .map((item) => ({
      description: '',
      imageUrl: '',
      price: null,
      favorite: false,
      purchased: false,
      purchasedAt: null,
      ...item,
      offers: Array.isArray(item.offers) ? item.offers : [],
      categoryId: categoryIds.has(item.categoryId) ? item.categoryId : FALLBACK_CATEGORY_ID,
    }));

  return { settings, categories, items };
}

// ---------------------------------------------------------------------------
// Operations – pure mutations of a data object (`draft`).
// Used by the Node JSON-file store and by the browser GitHub backend, so both
// enforce exactly the same rules. Each returns the value the API responds with.
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

function findItem(draft, id) {
  const item = draft.items.find((candidate) => candidate.id === id);
  if (!item) throw new NotFoundError('Hlutur fannst ekki.');
  return item;
}

function findCategory(draft, id) {
  const category = draft.categories.find((candidate) => candidate.id === id);
  if (!category) throw new NotFoundError('Flokkur fannst ekki.');
  return category;
}

function validCategoryId(draft, id) {
  return draft.categories.some((category) => category.id === id) ? id : FALLBACK_CATEGORY_ID;
}

function uniqueItemId(draft) {
  let id;
  do id = globalThis.crypto.randomUUID().slice(0, 8);
  while (draft.items.some((item) => item.id === id));
  return id;
}

function setPurchasedFields(item, purchased, now) {
  if (item.purchased === purchased) return;
  item.purchased = purchased;
  item.purchasedAt = purchased ? now : null;
}

/** Apply sanitized fields from `input` onto `item`. Only keys present in `input` are touched. */
function applyItemFields(draft, item, input, now) {
  if (has(input, 'name')) {
    const name = cleanLine(input.name, LIMITS.name);
    if (!name) throw new ValidationError('Nafn á hlut vantar.');
    item.name = name;
  }
  if (has(input, 'description')) item.description = cleanText(input.description, LIMITS.description);
  if (has(input, 'categoryId')) item.categoryId = validCategoryId(draft, input.categoryId);
  if (has(input, 'imageUrl')) item.imageUrl = sanitizeUrl(input.imageUrl);
  if (has(input, 'offers')) item.offers = sanitizeOffers(input.offers);
  if (has(input, 'price')) item.price = parsePrice(input.price);
  if (has(input, 'favorite')) item.favorite = input.favorite === true;
  if (has(input, 'purchased')) setPurchasedFields(item, input.purchased === true, now);

  // Contract rule: a missing price falls back to the cheapest offer.
  if (item.price === null) item.price = lowestOfferPrice(item.offers);
}

export const operations = {
  createItem(draft, input) {
    const fields = asObject(input);
    if (!has(fields, 'name')) throw new ValidationError('Nafn á hlut vantar.');
    const now = nowIso();
    const item = {
      id: uniqueItemId(draft),
      name: '',
      description: '',
      categoryId: FALLBACK_CATEGORY_ID,
      imageUrl: '',
      price: null,
      offers: [],
      favorite: false,
      purchased: false,
      purchasedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    applyItemFields(draft, item, fields, now);
    draft.items.push(item);
    return item;
  },

  updateItem(draft, id, patch) {
    const item = findItem(draft, id);
    const now = nowIso();
    applyItemFields(draft, item, asObject(patch), now);
    item.updatedAt = now;
    return item;
  },

  deleteItem(draft, id) {
    findItem(draft, id);
    draft.items = draft.items.filter((item) => item.id !== id);
    return { ok: true };
  },

  setPurchased(draft, id, purchased) {
    const item = findItem(draft, id);
    const now = nowIso();
    setPurchasedFields(item, purchased === true, now);
    item.updatedAt = now;
    return item;
  },

  createCategory(draft, input) {
    const fields = asObject(input);
    const name = cleanLine(fields.name, LIMITS.categoryName);
    if (!name) throw new ValidationError('Nafn á flokki vantar.');
    const base = slugify(name) || 'flokkur';
    let id = base;
    for (let n = 2; draft.categories.some((category) => category.id === id); n++) id = `${base}-${n}`;
    const category = { id, name, icon: cleanLine(fields.icon, LIMITS.categoryIcon) || DEFAULT_CATEGORY_ICON };
    // Keep the catch-all "Annað" last.
    const fallbackIndex = draft.categories.findIndex((c) => c.id === FALLBACK_CATEGORY_ID);
    draft.categories.splice(fallbackIndex === -1 ? draft.categories.length : fallbackIndex, 0, category);
    return category;
  },

  updateCategory(draft, id, patch) {
    const category = findCategory(draft, id);
    const fields = asObject(patch);
    if (has(fields, 'name')) {
      const name = cleanLine(fields.name, LIMITS.categoryName);
      if (!name) throw new ValidationError('Nafn á flokki vantar.');
      category.name = name;
    }
    if (has(fields, 'icon')) category.icon = cleanLine(fields.icon, LIMITS.categoryIcon);
    return category;
  },

  deleteCategory(draft, id) {
    if (id === FALLBACK_CATEGORY_ID) throw new ValidationError('Ekki er hægt að eyða flokknum „Annað“.');
    findCategory(draft, id);
    const now = nowIso();
    draft.categories = draft.categories.filter((category) => category.id !== id);
    for (const item of draft.items) {
      if (item.categoryId === id) {
        item.categoryId = FALLBACK_CATEGORY_ID;
        item.updatedAt = now;
      }
    }
    return { ok: true };
  },

  updateSettings(draft, patch) {
    const fields = asObject(patch);
    if (has(fields, 'title')) {
      const title = cleanLine(fields.title, LIMITS.title);
      if (!title) throw new ValidationError('Titill má ekki vera tómur.');
      draft.settings.title = title;
    }
    if (has(fields, 'subtitle')) draft.settings.subtitle = cleanLine(fields.subtitle, LIMITS.subtitle);
    if (has(fields, 'intro')) draft.settings.intro = cleanText(fields.intro, LIMITS.intro);
    return draft.settings;
  },
};
