// Express application. Dependencies are injected so tests can use a temp data
// directory and a fake product lookup.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { adminRouter } from './routes/admin.js';
import { categoriesRouter } from './routes/categories.js';
import { itemsRouter } from './routes/items.js';
import { lookupRouter } from './routes/lookup.js';
import { siteRouter } from './routes/site.js';
import { NotFoundError, ValidationError } from './store.js';

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  // Errors from express.json()
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ógilt JSON í beiðni.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Beiðnin er of stór.' });

  // ValidationError / NotFoundError from the store carry an Icelandic message.
  if (error instanceof ValidationError || error instanceof NotFoundError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ error: 'Ógild beiðni.' });
  }

  console.error(error);
  res.status(500).json({ error: 'Eitthvað fór úrskeiðis. Reyndu aftur síðar.' });
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {ReturnType<import('./auth.js').createAuth>} deps.auth
 * @param {(query: string, options?: { signal?: AbortSignal }) => Promise<object>} deps.lookup
 * @param {() => boolean} [deps.aiSearchEnabled]  reported by GET /api/admin/me
 * @param {string} [deps.publicDir]               static files directory
 */
export function createApp({
  store,
  auth,
  lookup,
  aiSearchEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY),
  publicDir = DEFAULT_PUBLIC_DIR,
}) {
  if (!store || !auth || typeof lookup !== 'function') {
    throw new TypeError('createApp: store, auth and lookup are required');
  }

  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(securityHeaders);

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(express.json({ limit: '100kb' }));
  api.use(siteRouter({ store, auth }));
  api.use(adminRouter({ auth, aiSearchEnabled }));
  api.use(itemsRouter({ store, auth }));
  api.use(categoriesRouter({ store, auth }));
  api.use(lookupRouter({ auth, lookup }));
  api.use((req, res) => res.status(404).json({ error: 'Fannst ekki.' }));

  app.use('/api', api);
  app.use(express.static(publicDir));
  app.use(errorHandler);

  return app;
}
