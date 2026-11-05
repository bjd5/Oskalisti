// Categories (admin only).

import { Router } from 'express';

export function categoriesRouter({ store, auth }) {
  const router = Router();
  const { requireAdmin } = auth;

  router.post('/categories', requireAdmin, async (req, res) => {
    res.status(201).json(await store.createCategory(req.body));
  });

  router.put('/categories/:id', requireAdmin, async (req, res) => {
    res.json(await store.updateCategory(req.params.id, req.body));
  });

  router.delete('/categories/:id', requireAdmin, async (req, res) => {
    res.json(await store.deleteCategory(req.params.id));
  });

  return router;
}
