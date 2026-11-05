// GitHub Pages backend.
//
// On GitHub Pages there is no server, so this module answers the same /api/* requests the
// Node server would, entirely in the browser:
//   • Guests read the published data file (public/data/oskalisti.json) from the Pages site.
//   • The "aðgangskóði" is a GitHub fine-grained token with write access to the repo. Admin
//     changes are committed straight to the data file through the GitHub contents API, which
//     triggers the Pages workflow to republish the site (about a minute).
//   • Product lookup uses the admin's own Claude API key (stored only in this browser) and the
//     shared prompt/loop in shared/ai-core.js; Claude's web search/fetch does the browsing.
//
// The data rules (validation, price = cheapest offer, categories…) are the same module the
// Node server uses: shared/listdata.js.

import { normalizeData, operations } from './shared/listdata.js';
import { DEFAULT_MODEL, runAiLookup } from './shared/ai-core.js';

const GITHUB_API = 'https://api.github.com';
const TOKEN_KEY = 'oskalisti.githubToken';
const CLAUDE_KEY = 'oskalisti.claudeKey';

class BackendError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  },
  set(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* private mode etc. – the login then lasts only for this page view */
    }
  },
};

// ---- base64 <-> UTF-8 (the data contains Icelandic letters and emoji) -----------------

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function decodeBase64(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

// ---- Claude errors → Icelandic (the bundled SDK's classes, matched by status) ---------

function claudeErrorMessage(err) {
  if (err?.name === 'AbortError' || err?.constructor?.name === 'APIUserAbortError') return 'Leit hætt.';
  switch (err?.status) {
    case 401:
      return 'Gervigreindarleit: ógildur Claude API-lykill.';
    case 403:
      return 'Gervigreindarleit: API-lykillinn hefur ekki aðgang að þessari þjónustu.';
    case 429:
      return 'Gervigreindarleit: of margar fyrirspurnir í bili, reyndu aftur eftir smá stund.';
    case 400:
      return 'Gervigreindarleit: villa í beiðni til þjónustunnar.';
    case undefined:
      return 'Gervigreindarleit: náði ekki sambandi við þjónustuna.';
    default:
      return err.status >= 500
        ? 'Gervigreindarleit: þjónustan er upptekin, reyndu aftur síðar.'
        : `Gervigreindarleit mistókst (villa ${err.status}).`;
  }
}

/**
 * @param {{ owner: string, repo: string, branch?: string, dataPath: string, publicDataUrl?: string }} config
 *   dataPath: path of the data file in the repo (e.g. "public/data/oskalisti.json").
 *   publicDataUrl: where the published copy is served on the Pages site (default "data/oskalisti.json").
 */
export function createGitHubBackend(config, { fetchImpl = (...args) => globalThis.fetch(...args), loadSdk } = {}) {
  const { owner, repo, branch = 'main', dataPath, publicDataUrl = 'data/oskalisti.json' } = config;
  const contentsUrl = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${dataPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

  let token = storage.get(TOKEN_KEY);
  let claudeKey = storage.get(CLAUDE_KEY);

  const importSdk = loadSdk || (() => import('./vendor/anthropic-sdk.js'));

  async function github(url, { method = 'GET', body, signal, authToken = token } = {}) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        cache: 'no-store',
        signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new BackendError('Ekki náðist samband við GitHub. Athugaðu nettenginguna og reyndu aftur.', 0);
    }
    const data = await res.json().catch(() => null);
    return { res, data };
  }

  function requireToken() {
    if (!token) throw new BackendError('Aðgangur ekki leyfður', 401);
  }

  /** Latest data straight from the repo (not the possibly-stale Pages copy) + its sha. */
  async function readRepoData() {
    const { res, data } = await github(`${contentsUrl}?ref=${encodeURIComponent(branch)}`);
    if (res.status === 401) {
      logout();
      throw new BackendError('Aðgangur ekki leyfður', 401);
    }
    if (res.status === 404) return { data: normalizeData({}), sha: undefined }; // first save creates it
    if (!res.ok) throw new BackendError(`Gat ekki lesið listann frá GitHub (villa ${res.status}).`, 502);
    return { data: normalizeData(JSON.parse(decodeBase64(data.content))), sha: data.sha };
  }

  async function writeRepoData(next, sha, message) {
    const body = {
      message: `Óskalisti: ${message}`,
      content: encodeBase64(JSON.stringify(next, null, 2) + '\n'),
      branch,
      ...(sha ? { sha } : {}),
    };
    const { res } = await github(contentsUrl, { method: 'PUT', body });
    if (res.ok) return 'ok';
    if (res.status === 409 || res.status === 422) return 'conflict'; // someone else saved first
    if (res.status === 401) {
      logout();
      throw new BackendError('Aðgangur ekki leyfður', 401);
    }
    if (res.status === 403 || res.status === 404) {
      throw new BackendError('Aðgangskóðinn hefur ekki skrifaðgang að gögnunum (Contents: Read and write).', 403);
    }
    throw new BackendError(`Gat ekki vistað á GitHub (villa ${res.status}).`, 502);
  }

  /** Read → apply operation → commit; retried when another save happened in between. */
  async function mutate(apply, message) {
    requireToken();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, sha } = await readRepoData();
      let result;
      try {
        result = apply(data);
      } catch (err) {
        throw new BackendError(err.message, err.status || 400);
      }
      const outcome = await writeRepoData(data, sha, typeof message === 'function' ? message(result) : message);
      if (outcome === 'ok') return structuredClone(result);
    }
    throw new BackendError('Einhver annar var að vista á sama tíma. Reyndu aftur.', 409);
  }

  function logout() {
    token = '';
    claudeKey = '';
    storage.set(TOKEN_KEY, '');
    storage.set(CLAUDE_KEY, '');
  }

  async function login({ code, claudeKey: newClaudeKey }) {
    const candidate = typeof code === 'string' ? code.trim() : '';
    if (!candidate) throw new BackendError('Sláðu inn aðgangskóðann.', 400);
    const { res, data } = await github(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { authToken: candidate },
    );
    if (res.status === 401 || res.status === 404 || !res.ok) {
      throw new BackendError('Rangur aðgangskóði (GitHub-lykill) eða hann hefur ekki aðgang að repoinu.', 401);
    }
    if (data?.permissions && !data.permissions.push) {
      throw new BackendError('Þessi GitHub-lykill hefur bara lesaðgang. Hann þarf „Contents: Read and write“.', 401);
    }
    token = candidate;
    storage.set(TOKEN_KEY, token);
    claudeKey = typeof newClaudeKey === 'string' ? newClaudeKey.trim() : '';
    storage.set(CLAUDE_KEY, claudeKey);
    return { admin: true };
  }

  async function list() {
    if (token) {
      try {
        return (await readRepoData()).data;
      } catch (err) {
        if (err.status === 401) throw err;
        /* fall back to the published copy below */
      }
    }
    let res;
    try {
      res = await fetchImpl(`${publicDataUrl}?v=${Date.now()}`, { cache: 'no-store' });
    } catch {
      throw new BackendError('Ekki náðist samband við síðuna. Athugaðu nettenginguna og reyndu aftur.', 0);
    }
    if (!res.ok) throw new BackendError('Gat ekki sótt óskalistann.', res.status);
    return normalizeData(await res.json());
  }

  async function lookup(query, signal) {
    requireToken();
    if (!claudeKey) {
      return {
        results: [],
        source: 'none',
        message:
          'Sjálfvirk leit þarf Claude API-lykil. Skráðu þig út og aftur inn með lykli – eða fylltu út upplýsingarnar handvirkt.',
      };
    }
    const { default: Anthropic } = await importSdk();
    const client = new Anthropic({ apiKey: claudeKey, dangerouslyAllowBrowser: true, timeout: 120_000, maxRetries: 1 });
    const { results, message } = await runAiLookup(query, {
      client,
      signal,
      model: DEFAULT_MODEL,
      errorMessage: claudeErrorMessage,
    });
    if (results.length) return { results, source: 'ai', ...(message ? { message } : {}) };
    return {
      results: [],
      source: 'none',
      message: message || 'Fann ekkert sjálfvirkt. Prófaðu annað orðalag eða settu inn upplýsingar handvirkt.',
    };
  }

  const nameOf = (item) => item?.name || 'gjöf';

  /** Same contract as the Node server's /api routes. */
  async function request(path, { method = 'GET', body = {}, signal } = {}) {
    const url = new URL(path, 'http://x');
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const route = `${method} /${parts[0] || ''}`;
    const [, id, sub] = parts;

    switch (true) {
      case route === 'GET /list':
        return list();
      case route === 'GET /admin' && id === 'me':
        return { admin: Boolean(token), aiSearch: Boolean(token && claudeKey), backend: 'github' };
      case route === 'POST /admin' && id === 'login':
        return login(body);
      case route === 'POST /admin' && id === 'logout':
        logout();
        return { admin: false };
      case route === 'POST /lookup':
        return lookup(String(body?.query ?? '').trim(), signal);

      case route === 'POST /items' && !id:
        return mutate((d) => operations.createItem(d, body), (item) => `ný gjöf – ${nameOf(item)}`);
      case route === 'PUT /items' && id && !sub:
        return mutate((d) => operations.updateItem(d, id, body), (item) => `breytti gjöf – ${nameOf(item)}`);
      case route === 'DELETE /items' && id && !sub:
        return mutate((d) => {
          const name = nameOf(d.items.find((item) => item.id === id));
          operations.deleteItem(d, id);
          return { ok: true, name };
        }, (result) => `eyddi gjöf – ${result.name}`).then(() => ({ ok: true }));
      case route === 'POST /items' && sub === 'purchased':
        return mutate(
          (d) => operations.setPurchased(d, id, body?.purchased === true),
          (item) => `${item.purchased ? 'keypt' : 'afmerkt'} – ${nameOf(item)}`,
        );

      case route === 'POST /categories' && !id:
        return mutate((d) => operations.createCategory(d, body), (c) => `nýr flokkur – ${c.name}`);
      case route === 'PUT /categories' && !!id:
        return mutate((d) => operations.updateCategory(d, id, body), (c) => `breytti flokki – ${c.name}`);
      case route === 'DELETE /categories' && !!id:
        return mutate((d) => operations.deleteCategory(d, id), 'eyddi flokki');

      case route === 'PUT /settings':
        return mutate((d) => operations.updateSettings(d, body), 'breytti stillingum');

      default:
        throw new BackendError('Fannst ekki', 404);
    }
  }

  return { request };
}
