const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;
const COOKIE = 'lf_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Used when the email is unknown, so a miss costs the same time as a wrong password.
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

async function verifyPassword(password, stored = DUMMY_HASH) {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function cookieOptions(req, maxAgeSeconds) {
  const secure = req.secure || process.env.NODE_ENV === 'production';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function createAuth(store) {
  return {
    async startSession(req, res, userId) {
      const token = crypto.randomBytes(32).toString('base64url');
      await store.createSession(hashToken(token), userId, SESSION_TTL_MS);
      res.append('Set-Cookie', `${COOKIE}=${token}; ${cookieOptions(req, SESSION_TTL_MS / 1000)}`);
    },

    async endSession(req, res) {
      const token = readCookie(req, COOKIE);
      if (token) await store.deleteSession(hashToken(token));
      res.append('Set-Cookie', `${COOKIE}=; ${cookieOptions(req, 0)}`);
    },

    // Attaches req.user when a valid session cookie is present.
    loadUser() {
      return async (req, res, next) => {
        try {
          const token = readCookie(req, COOKIE);
          req.user = token ? await store.findSessionUser(hashToken(token)) : null;
          next();
        } catch (err) {
          next(err);
        }
      };
    },

    requireUser(req, res, next) {
      if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
      return next();
    },
  };
}

module.exports = { createAuth, hashPassword, verifyPassword, COOKIE };
