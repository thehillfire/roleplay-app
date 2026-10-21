const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;
const COOKIE = 'lf_sid';
// Sessions slide: each day someone uses the app, their sign-in is pushed out to 180 days again,
// so anyone who comes back at least twice a year never sees the sign-in screen. Signing out,
// "sign out everywhere", a password reset or a suspension still end it at once.
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 180 * DAY_MS;
const RENEW_AFTER_MS = DAY_MS; // at most one renewal write per session per day

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

// A long-lived random id for this browser, kept apart from the session so it survives
// signing out. Only its hash is stored. Clearing cookies resets it: this stops casual
// ban evasion, not a determined person.
const DEVICE_COOKIE = 'kd_dev';
function deviceHash(req, res) {
  let id = readCookie(req, DEVICE_COOKIE);
  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) {
    id = crypto.randomBytes(18).toString('base64url');
    res.append('Set-Cookie', `${DEVICE_COOKIE}=${id}; ${cookieOptions(req, 2 * 365 * 24 * 60 * 60)}`);
  }
  return hashToken(`device:${id}`);
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
          if (req.user && req.user.sessionExpiresAt - Date.now() < SESSION_TTL_MS - RENEW_AFTER_MS) {
            await store.renewSession(hashToken(token), SESSION_TTL_MS);
            res.append('Set-Cookie', `${COOKIE}=${token}; ${cookieOptions(req, SESSION_TTL_MS / 1000)}`);
          }
          next();
        } catch (err) {
          next(err);
        }
      };
    },

    requireUser(req, res, next) {
      // The code tells the client this is a missing session, not a wrong password somewhere.
      if (!req.user) return res.status(401).json({ error: 'Sign in to continue.', code: 'signed_out' });
      return next();
    },
  };
}

module.exports = { createAuth, hashPassword, verifyPassword, readCookie, hashToken, deviceHash, COOKIE, SESSION_TTL_MS };
