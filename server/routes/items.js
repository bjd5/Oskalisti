// Wishlist items (admin only).

import { Router } from 'express';

export function itemsRouter({ store, auth }) {
  const router = Router();
  const { requireAdmin } = auth;

  router.post('/items', requireAdmin, async (req, res) => {
    res.status(201).json(await store.createItem(req.body));
  });

  router.put('/items/:id', requireAdmin, async (req, res) => {
    res.json(await store.updateItem(req.params.id, req.body));
  });

  router.delete('/items/:id', requireAdmin, async (req, res) => {
    res.json(await store.deleteItem(req.params.id));
  });

  router.post('/items/:id/purchased', requireAdmin, async (req, res) => {
    const purchased = req.body?.purchased;
    if (typeof purchased !== 'boolean') {
      return res.status(400).json({ error: 'Gildið „purchased“ verður að vera true eða false.' });
    }
    res.json(await store.setPurchased(req.params.id, purchased));
  });

  return router;
}
