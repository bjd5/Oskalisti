// JSON-file store for the wishlist.
//
// All data lives in memory after load(). Every mutation runs through a single
// promise queue: it is applied to a copy of the data, the copy is written to
// disk atomically (temp file + rename) and only then becomes the live data.
// Concurrent requests therefore can neither lose updates nor corrupt the file.

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { DATA_FILE_NAME, normalizeData, operations, seedData } from '../public/shared/listdata.js';

export {
  DATA_FILE_NAME,
  FALLBACK_CATEGORY_ID,
  DEFAULT_SETTINGS,
  DEFAULT_CATEGORIES,
  ValidationError,
  NotFoundError,
  cleanText,
  cleanLine,
  sanitizeUrl,
  parsePrice,
  slugify,
} from '../public/shared/listdata.js';

/**
 * Create a store backed by `${dataDir}/oskalisti.json`.
 * All methods are async and load the data on first use.
 */
export function createStore({ dataDir }) {
  if (!dataDir) throw new TypeError('createStore: dataDir is required');
  const filePath = path.join(dataDir, DATA_FILE_NAME);

  let data = null;
  let loading = null;
  let queue = Promise.resolve();
  let tempCounter = 0;

  async function writeAtomic(snapshot) {
    const tempPath = `${filePath}.${process.pid}.${++tempCounter}.tmp`;
    const handle = await open(tempPath, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  async function doLoad() {
    await mkdir(dataDir, { recursive: true });
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const seeded = seedData();
      await writeAtomic(seeded);
      data = seeded;
      return;
    }
    // A corrupt file is a fatal error on purpose: never overwrite the user's data with defaults.
    data = normalizeData(JSON.parse(raw));
  }

  /** Load data from disk (seeding defaults on first run). Safe to call repeatedly. */
  function load() {
    loading ??= doLoad().catch((error) => {
      loading = null;
      throw error;
    });
    return loading;
  }

  /**
   * Apply `change(draft)` to a copy of the data, persist it, then make it live.
   * Mutations are serialized; a thrown error leaves both memory and disk untouched.
   */
  function mutate(change) {
    const run = queue.then(async () => {
      await load();
      const draft = structuredClone(data);
      const result = change(draft);
      await writeAtomic(draft);
      data = draft;
      return structuredClone(result);
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    load,

    /** Snapshot of everything: `{ settings, categories, items }`. */
    async getAll() {
      await load();
      return structuredClone(data);
    },

    createItem: (input) => mutate((draft) => operations.createItem(draft, input)),
    updateItem: (id, patch) => mutate((draft) => operations.updateItem(draft, id, patch)),
    deleteItem: (id) => mutate((draft) => operations.deleteItem(draft, id)),
    setPurchased: (id, purchased) => mutate((draft) => operations.setPurchased(draft, id, purchased)),
    createCategory: (input) => mutate((draft) => operations.createCategory(draft, input)),
    updateCategory: (id, patch) => mutate((draft) => operations.updateCategory(draft, id, patch)),
    deleteCategory: (id) => mutate((draft) => operations.deleteCategory(draft, id)),
    updateSettings: (patch) => mutate((draft) => operations.updateSettings(draft, patch)),
  };
}
