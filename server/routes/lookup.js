// Product lookup (admin only): free text or a product URL → price/store/image candidates.

import { Router } from 'express';

const MAX_QUERY_LENGTH = 500;

export function lookupRouter({ auth, lookup }) {
  const router = Router();

  router.post('/lookup', auth.requireAdmin, async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      return res.status(400).json({ error: 'Sláðu inn hvað þig langar í eða límdu inn slóð.' });
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({ error: `Leitin má mest vera ${MAX_QUERY_LENGTH} stafir.` });
    }

    // Stop an expensive lookup (e.g. AI search) if the admin closes the page or cancels.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    let result;
    try {
      result = await lookup(query, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return; // client is gone, nobody to answer
      console.error('Lookup failed:', error);
      return res.status(502).json({ error: 'Leit mistókst. Prófaðu aftur eða settu inn upplýsingar handvirkt.' });
    }
    res.json(result ?? { results: [], source: 'none' });
  });

  return router;
}
