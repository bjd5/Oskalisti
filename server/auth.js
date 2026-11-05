// Admin access: access code, HMAC-signed session cookie and login rate limiting.

import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const COOKIE_NAME = 'oskalisti_admin';
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const ADMIN_CODE_FILE = 'admin-code.txt';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 10;
// Defense in depth: X-Forwarded-For can be spoofed, so also cap failures across all IPs.
const MAX_FAILURES_GLOBAL = 100;
const CLOCK_SKEW_MS = 60 * 1000;

// No look-alike characters (0/o, 1/l/i) – easier to read off a terminal and type on a phone.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export const MESSAGES = Object.freeze({
  unauthorized: 'Aðgangur ekki leyfður',
  rateLimited: 'Of margar tilraunir. Reyndu aftur eftir smá stund.',
});

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest();

function generateCode(length = 8) {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/**
 * Work out the admin access code.
 * Uses env ADMIN_CODE when set; otherwise reads `${dataDir}/admin-code.txt`,
 * generating and persisting a random 8-character code on first run.
 * @returns {Promise<{ code: string, source: 'env'|'file'|'generated', file: string }>}
 */
export async function resolveAdminCode({ dataDir, env = process.env }) {
  const file = path.join(dataDir, ADMIN_CODE_FILE);
  const fromEnv = env.ADMIN_CODE?.trim();
  if (fromEnv) return { code: fromEnv, source: 'env', file };

  try {
    const saved = (await readFile(file, 'utf8')).trim();
    if (saved) return { code: saved, source: 'file', file };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const code = generateCode();
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, code + '\n', { mode: 0o600 });
  return { code, source: 'generated', file };
}

/** Parse a Cookie header into a plain object (no dependency on cookie-parser). */
export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name || name in cookies) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/** In-memory fixed-window limiter for failed login attempts. */
function createLoginLimiter({ now }) {
  const failures = new Map(); // key → { count, resetAt }

  function entry(key) {
    const current = failures.get(key);
    if (current && current.resetAt > now()) return current;
    failures.delete(key);
    return null;
  }

  function bump(key) {
    const current = entry(key);
    if (current) current.count++;
    else failures.set(key, { count: 1, resetAt: now() + LOGIN_WINDOW_MS });
  }

  function prune() {
    const time = now();
    for (const [key, value] of failures) if (value.resetAt <= time) failures.delete(key);
  }

  return {
    isBlocked(ip) {
      return (entry(`ip:${ip}`)?.count ?? 0) >= MAX_FAILURES_PER_IP
        || (entry('global')?.count ?? 0) >= MAX_FAILURES_GLOBAL;
    },
    recordFailure(ip) {
      if (failures.size > 10_000) prune();
      bump(`ip:${ip}`);
      bump('global');
    },
    reset(ip) {
      failures.delete(`ip:${ip}`);
    },
  };
}

/**
 * Create the auth helpers for a given admin code.
 * The session secret defaults to sha256(adminCode), so changing the code logs everyone out.
 */
export function createAuth({ adminCode, sessionSecret, now = Date.now }) {
  if (!adminCode) throw new TypeError('createAuth: adminCode is required');
  const secret = sessionSecret || sha256(adminCode).toString('hex');
  const codeHash = sha256(adminCode);
  const limiter = createLoginLimiter({ now });

  const sign = (issuedAt) => createHmac('sha256', secret).update(`admin.${issuedAt}`).digest('hex');

  function createSessionToken() {
    const issuedAt = now();
    return `${issuedAt}.${sign(issuedAt)}`;
  }

  function verifySessionToken(token) {
    if (typeof token !== 'string') return false;
    const match = /^(\d{1,16})\.([0-9a-f]{64})$/.exec(token);
    if (!match) return false;
    const issuedAt = Number(match[1]);
    const age = now() - issuedAt;
    if (age > SESSION_MAX_AGE_MS || age < -CLOCK_SKEW_MS) return false;
    return timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(sign(issuedAt), 'hex'));
  }

  function cookieOptions(req) {
    return { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' };
  }

  return {
    limiter,

    /** Constant-time comparison of a submitted code with the admin code. */
    checkCode(code) {
      if (typeof code !== 'string') return false;
      return timingSafeEqual(sha256(code.trim()), codeHash);
    },

    createSessionToken,
    verifySessionToken,

    isAdmin(req) {
      return verifySessionToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
    },

    startSession(req, res) {
      res.cookie(COOKIE_NAME, createSessionToken(), { ...cookieOptions(req), maxAge: SESSION_MAX_AGE_MS });
    },

    endSession(req, res) {
      res.clearCookie(COOKIE_NAME, cookieOptions(req));
    },

    /** Express middleware: only logged-in admins get through. */
    requireAdmin: (req, res, next) => {
      if (verifySessionToken(parseCookies(req.headers.cookie)[COOKIE_NAME])) return next();
      res.status(401).json({ error: MESSAGES.unauthorized });
    },
  };
}
