// Google Sheets backend for GitHub Pages.
//
// The wishlist lives in a Google Sheet, behind a small Apps Script web app
// (apps-script/Code.gs). This module answers the same /api/* requests as the Node server:
//   • Guests read the list with a plain GET.
//   • Admins log in with the private access code that is written in the sheet (tab
//     "Aðgangur", cell B1). No API keys or tokens anywhere.
//   • Changes are applied in the browser with the same rules as the server
//     (shared/listdata.js) and saved as a whole, with a version check so two people
//     saving at once never overwrite each other.
//   • Product lookup: the Apps Script fetches the product page (browsers can't read other
//     sites directly) and the page is parsed here (vendor/lookup.js – same parser as the server).

import { normalizeData, operations } from './shared/listdata.js';

const CODE_KEY = 'oskalisti.accessCode';

class BackendError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const storage = {
  get() {
    try {
      return localStorage.getItem(CODE_KEY) || '';
    } catch {
      return '';
    }
  },
  set(value) {
    try {
      if (value) localStorage.setItem(CODE_KEY, value);
      else localStorage.removeItem(CODE_KEY);
    } catch {
      /* private mode – the login then lasts only for this page view */
    }
  },
};

const looksLikeUrl = (q) => /^(https?:\/\/|www\.)\S+$/i.test(q) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(q);
const toUrl = (q) => (/^https?:\/\//i.test(q) ? q : `https://${q}`);

const NOT_CONNECTED =
  'Síðan er ekki enn tengd við Google Sheet. Settu slóðina á Apps Script-ið í public/config.json (sjá README).';

/** @param {{ url: string }} config  url: the Apps Script "Web app URL" (ends in /exec). */
export function createSheetsBackend(config, { fetchImpl = (...args) => globalThis.fetch(...args), loadLookup } = {}) {
  const endpoint = typeof config?.url === 'string' ? config.url.trim() : '';
  let code = storage.get();
  const importLookup = loadLookup || (() => import('./vendor/lookup.js'));

  async function send(init, signal) {
    if (!endpoint) throw new BackendError(NOT_CONNECTED, 503);
    let res;
    try {
      res = await fetchImpl(init ? endpoint : `${endpoint}?v=${Date.now()}`, {
        redirect: 'follow',
        cache: 'no-store',
        signal,
        ...(init
          ? {
              method: 'POST',
              // text/plain keeps this a "simple" request, which Apps Script can answer cross-origin.
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify(init),
            }
          : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new BackendError('Ekki náðist samband við gagnaskrána. Athugaðu nettenginguna og reyndu aftur.', 0);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new BackendError('Gagnaskráin svaraði ekki rétt. Reyndu aftur eftir smástund.', 502);
    if (data.error) {
      if (data.status === 401 && init) {
        code = '';
        storage.set('');
      }
      throw new BackendError(data.error, data.status || 400);
    }
    return data;
  }

  const post = (action, payload = {}, signal) => send({ action, code, ...payload }, signal);

  function requireLogin() {
    if (!code) throw new BackendError('Aðgangur ekki leyfður', 401);
  }

  async function readAll() {
    const raw = await send(null);
    return { data: normalizeData(raw), version: raw.version ?? 0 };
  }

  /** Read → apply operation → save; retried if someone else saved in between. */
  async function mutate(apply) {
    requireLogin();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, version } = await readAll();
      let result;
      try {
        result = apply(data);
      } catch (err) {
        throw new BackendError(err.message, err.status || 400);
      }
      try {
        await post('save', { data, version });
        return structuredClone(result);
      } catch (err) {
        if (err.status !== 409) throw err;
      }
    }
    throw new BackendError('Einhver annar var að vista á sama tíma. Reyndu aftur.', 409);
  }

  async function login(body) {
    const candidate = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!candidate) throw new BackendError('Sláðu inn aðgangskóðann.', 400);
    await send({ action: 'login', code: candidate });
    code = candidate;
    storage.set(code);
    return { admin: true };
  }

  async function lookup(query, signal) {
    requireLogin();
    if (!query) throw new BackendError('Skrifaðu hvað þig langar í eða límdu inn hlekk.', 400);
    const { extractProductWith, searchWith, NOTHING_FOUND_MESSAGE } = await importLookup();

    // Page fetcher for the shared parser: goes through the Apps Script.
    const fetchPage = async (url) => {
      const page = await post('fetch', { url }, signal);
      if (page.status >= 400) throw new BackendError(`Síðan svaraði með villu ${page.status}.`, 502);
      return { url, text: page.text || '' };
    };

    if (looksLikeUrl(query)) {
      try {
        const result = await extractProductWith(fetchPage, toUrl(query));
        const message =
          result.price === null || !result.imageUrl
            ? 'Fann ekki allt á síðunni – fylltu út það sem vantar hér fyrir neðan.'
            : undefined;
        return { results: [result], source: 'url', ...(message ? { message } : {}) };
      } catch (err) {
        if (signal?.aborted) throw err;
        return {
          results: [],
          source: 'none',
          message: 'Gat ekki lesið vörusíðuna. Sumar verslanir loka á þetta – fylltu þá út upplýsingarnar handvirkt.',
        };
      }
    }
    try {
      return await searchWith(fetchPage, query, { signal, logger: null });
    } catch (err) {
      if (signal?.aborted) throw err;
      return { results: [], source: 'none', message: NOTHING_FOUND_MESSAGE };
    }
  }

  /** Same contract as the Node server's /api routes. */
  async function request(path, { method = 'GET', body = {}, signal } = {}) {
    const parts = new URL(path, 'http://x').pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const [resource = '', id, sub] = parts;
    const route = `${method} /${resource}`;

    if (route === 'GET /list') return (await readAll()).data;
    if (route === 'GET /admin' && id === 'me') return { admin: Boolean(code), aiSearch: false, backend: 'sheets' };
    if (route === 'POST /admin' && id === 'login') return login(body);
    if (route === 'POST /admin' && id === 'logout') {
      code = '';
      storage.set('');
      return { admin: false };
    }
    if (route === 'POST /lookup') return lookup(String(body?.query ?? '').trim(), signal);

    if (route === 'POST /items' && !id) return mutate((d) => operations.createItem(d, body));
    if (route === 'PUT /items' && id && !sub) return mutate((d) => operations.updateItem(d, id, body));
    if (route === 'DELETE /items' && id && !sub) return mutate((d) => operations.deleteItem(d, id));
    if (route === 'POST /items' && id && sub === 'purchased') {
      return mutate((d) => operations.setPurchased(d, id, body?.purchased === true));
    }
    if (route === 'POST /categories' && !id) return mutate((d) => operations.createCategory(d, body));
    if (route === 'PUT /categories' && id) return mutate((d) => operations.updateCategory(d, id, body));
    if (route === 'DELETE /categories' && id) return mutate((d) => operations.deleteCategory(d, id));
    if (route === 'PUT /settings') return mutate((d) => operations.updateSettings(d, body));

    throw new BackendError('Fannst ekki', 404);
  }

  return { request };
}
