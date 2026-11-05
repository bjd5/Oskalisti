// The public wishlist and the site settings.

import { Router } from 'express';

export function siteRouter({ store, auth }) {
  const router = Router();

  router.get('/list', async (req, res) => {
    res.json(await store.getAll());
  });

  router.put('/settings', auth.requireAdmin, async (req, res) => {
    res.json(await store.updateSettings(req.body));
  });

  return router;
}
