// Admin session endpoints: who am I, log in, log out.

import { Router } from 'express';
import { MESSAGES } from '../auth.js';

export function adminRouter({ auth, aiSearchEnabled }) {
  const router = Router();

  router.get('/admin/me', (req, res) => {
    res.json({ admin: auth.isAdmin(req), aiSearch: Boolean(aiSearchEnabled()) });
  });

  router.post('/admin/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (auth.limiter.isBlocked(ip)) {
      return res.status(429).json({ error: MESSAGES.rateLimited });
    }

    const code = req.body?.code;
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'Sláðu inn aðgangskóða.' });
    }

    if (!auth.checkCode(code)) {
      auth.limiter.recordFailure(ip);
      return res.status(401).json({ error: 'Rangur aðgangskóði.' });
    }

    auth.limiter.reset(ip);
    auth.startSession(req, res);
    res.json({ admin: true });
  });

  router.post('/admin/logout', (req, res) => {
    auth.endSession(req, res);
    res.json({ admin: false });
  });

  return router;
}
