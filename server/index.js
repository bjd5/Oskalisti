// Entry point: wires the real store, auth and product lookup, then listens.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createAuth, resolveAdminCode } from './auth.js';
import { lookupProduct, isAiSearchEnabled } from './lookup/index.js';
import { createStore } from './store.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(projectRoot, 'data'));
const port = Number(process.env.PORT) || 3000;

const store = createStore({ dataDir });
await store.load();

const admin = await resolveAdminCode({ dataDir });
const auth = createAuth({ adminCode: admin.code, sessionSecret: process.env.SESSION_SECRET });

const app = createApp({
  store,
  auth,
  lookup: lookupProduct, // called as lookupProduct(query, { signal })
  aiSearchEnabled: isAiSearchEnabled,
});

app.listen(port, (error) => {
  if (error) {
    console.error(`Gat ekki ræst vefþjón á porti ${port}:`, error.message);
    process.exit(1);
  }
  console.log(`Óskalisti keyrir á http://localhost:${port}`);
  console.log(`Gögn: ${dataDir}`);
  if (admin.source === 'env') {
    console.log('Aðgangskóði: stilltur með ADMIN_CODE');
  } else {
    console.log(`Aðgangskóði: ${admin.code}  (vistaður í ${admin.file})`);
  }
  console.log(isAiSearchEnabled() ? 'Gervigreindarleit: virk' : 'Gervigreindarleit: óvirk (ANTHROPIC_API_KEY ekki stillt)');
});
