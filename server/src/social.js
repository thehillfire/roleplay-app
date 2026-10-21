// "Continue with Google / Apple": the OpenID Connect authorization-code flow, done on the server.
// A provider is on only when its keys are set. The browser is sent to the provider, comes back
// to /auth/callback/:provider with a one-time code, and this module trades the code for an
// id_token and checks everything about it before anyone is signed in.
//
// What is kept from a provider: its stable account id (`sub`) and the verified email. Never the
// name, photo or tokens. Kindred accounts stay anonymous.
const crypto = require('crypto');

const STATE_TTL_MS = 10 * 60 * 1000;
const REAUTH_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 2000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// `code` is what the client shows a person (it picks the wording); the message is for the log.
class SocialError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'SocialError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest();

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Apple wants the "client secret" to be a short-lived JWT signed with the key from the developer account.
function appleClientSecret({ clientId, teamId, keyId, privateKey, now = Date.now }) {
  const iat = Math.floor(now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: teamId, iat, exp: iat + 300, aud: 'https://appleid.apple.com', sub: clientId }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64url(sig)}`;
}

function providersFromEnv(env = process.env, now = Date.now) {
  const out = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    out.google = {
      id: 'google',
      label: 'Google',
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: () => env.GOOGLE_CLIENT_SECRET,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuers: ['https://accounts.google.com', 'accounts.google.com'],
      scope: 'openid email',
      pkce: true,
      extraAuthParams: { prompt: 'select_account' },
      reauthParams: { prompt: 'login' },
    };
  }
  if (env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY) {
    const privateKey = env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n');
    out.apple = {
      id: 'apple',
      label: 'Apple',
      clientId: env.APPLE_CLIENT_ID,
      clientSecret: () => appleClientSecret({ clientId: env.APPLE_CLIENT_ID, teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKey, now }),
      authUrl: 'https://appleid.apple.com/auth/authorize',
      tokenUrl: 'https://appleid.apple.com/auth/token',
      jwksUrl: 'https://appleid.apple.com/auth/keys',
      issuers: ['https://appleid.apple.com'],
      scope: 'email',
      // Apple only returns the email when the answer comes back as a form post.
      responseMode: 'form_post',
      pkce: false,
    };
  }
  return out;
}

function createSocial({
  providers = providersFromEnv(),
  fetchImpl = fetch,
  now = Date.now,
  random = crypto.randomBytes,
  log = console,
} = {}) {
  const pending = new Map(); // state -> flow in progress (single instance, like matchmaking)
  const reauth = new Map(); // userId -> time until which a fresh provider confirmation counts
  const keyCache = new Map(); // provider id -> { keys, fetchedAt }
  const keyFetches = new Map(); // provider id -> promise (one fetch at a time)

  const has = (id) => Object.prototype.hasOwnProperty.call(providers, id);
  const list = () => Object.values(providers).map((p) => ({ id: p.id, label: p.label }));

  function remember(state, flow) {
    const t = now();
    if (pending.size >= MAX_PENDING) {
      for (const [k, v] of pending) if (v.expiresAt < t) pending.delete(k);
      // Still full: drop the oldest, so a flood of "start" calls can't grow memory without bound.
      for (const k of pending.keys()) {
        if (pending.size < MAX_PENDING) break;
        pending.delete(k);
      }
    }
    pending.set(state, { ...flow, expiresAt: t + STATE_TTL_MS });
  }

  // The provider's authorization URL for this person's browser. `browser` ties the flow to the
  // browser that started it, so a link someone else started can't sign you in to their account.
  function start({ provider, mode, redirectUri, browser, signup, userId }) {
    if (!has(provider)) throw new SocialError('provider_off', `${provider} is not set up`);
    const def = providers[provider];
    const state = b64url(random(24));
    const nonce = b64url(random(16));
    const verifier = b64url(random(32));
    remember(state, { provider, mode, nonce, verifier, browser, signup, userId });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: def.clientId,
      redirect_uri: redirectUri,
      scope: def.scope,
      state,
      nonce,
      ...(def.responseMode ? { response_mode: def.responseMode } : {}),
      ...(def.pkce ? { code_challenge: b64url(sha256(verifier)), code_challenge_method: 'S256' } : {}),
      ...(mode === 'reauth' ? def.reauthParams : def.extraAuthParams),
    });
    return `${def.authUrl}?${params}`;
  }

  async function fetchKeys(def) {
    const res = await fetchImpl(def.jwksUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const keys = (Array.isArray(data.keys) ? data.keys : []).filter((k) => k && k.kty === 'RSA' && typeof k.kid === 'string');
    keyCache.set(def.id, { keys, fetchedAt: now() });
    return keys;
  }

  async function signingKey(def, kid) {
    const t = now();
    let cached = keyCache.get(def.id);
    const stale = !cached || t - cached.fetchedAt > JWKS_TTL_MS;
    const unknownKid = cached && !cached.keys.some((k) => k.kid === kid);
    // A key id we haven't seen may mean the provider rotated; look again, but not more than once a minute.
    if (stale || (unknownKid && t - cached.fetchedAt > JWKS_MIN_REFETCH_MS)) {
      if (!keyFetches.has(def.id)) {
        keyFetches.set(def.id, fetchKeys(def).finally(() => keyFetches.delete(def.id)));
      }
      try {
        await keyFetches.get(def.id);
      } catch (err) {
        log.warn(`${def.id}: could not fetch signing keys: ${err.message}`);
        if (stale) throw new SocialError('failed', 'signing keys unavailable');
      }
      cached = keyCache.get(def.id);
    }
    const jwk = cached?.keys.find((k) => k.kid === kid);
    return jwk ? crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null;
  }

  // Everything about the id_token that must be true before we believe who it says someone is.
  async function verifyIdToken(def, token, expectedNonce) {
    if (typeof token !== 'string' || token.length > 8192) throw new SocialError('failed', 'id_token missing or too long');
    const parts = token.split('.');
    if (parts.length !== 3) throw new SocialError('failed', 'id_token is not a JWT');
    let header;
    let claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new SocialError('failed', 'id_token is not valid JSON');
    }
    // Only RS256, whatever the token claims: never "none", never a shared-secret algorithm.
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') throw new SocialError('failed', 'id_token algorithm not accepted');

    const key = await signingKey(def, header.kid);
    if (!key) throw new SocialError('failed', 'id_token signed with an unknown key');
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!crypto.verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) throw new SocialError('failed', 'id_token signature is wrong');

    const nowS = Math.floor(now() / 1000);
    if (!claims || typeof claims !== 'object') throw new SocialError('failed', 'no claims');
    if (!def.issuers.includes(claims.iss)) throw new SocialError('failed', 'wrong issuer');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(def.clientId)) throw new SocialError('failed', 'wrong audience');
    if (!Number.isFinite(claims.exp) || claims.exp + CLOCK_SKEW_S < nowS) throw new SocialError('failed', 'id_token expired');
    if (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat - CLOCK_SKEW_S > nowS)) throw new SocialError('failed', 'id_token from the future');
    if (!safeEqual(claims.nonce, expectedNonce)) throw new SocialError('failed', 'wrong nonce');

    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new SocialError('failed', 'no subject');
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw new SocialError('no_email', 'no usable email');
    if (claims.email_verified !== true && claims.email_verified !== 'true') throw new SocialError('unverified_email', 'email not verified');
    return { subject: claims.sub, email };
  }

  async function exchange(def, flow, code, redirectUri) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: def.clientId,
      client_secret: await def.clientSecret(),
      ...(def.pkce ? { code_verifier: flow.verifier } : {}),
    });
    let res;
    try {
      res = await fetchImpl(def.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      log.warn(`${def.id}: token request failed: ${err.message}`);
      throw new SocialError('failed', 'token request failed');
    }
    if (!res.ok) {
      log.warn(`${def.id}: token endpoint answered HTTP ${res.status}`);
      throw new SocialError('failed', 'token endpoint refused the code');
    }
    const data = await res.json().catch(() => ({}));
    return data.id_token;
  }

  // The provider sent the browser back. Resolves to who the provider says this is, plus what the
  // flow was for; rejects with a SocialError whose `mode` says which tab to return to.
  async function complete({ provider, params = {}, browser, redirectUri }) {
    const state = typeof params.state === 'string' && params.state.length <= 200 ? params.state : '';
    const flow = state ? pending.get(state) : undefined;
    if (!flow) throw new SocialError('expired', 'unknown or already used state');
    pending.delete(state); // one use, whatever happens next
    const fail = (code, message) => new SocialError(code, message, { mode: flow.mode });

    if (flow.expiresAt < now()) throw fail('expired', 'state expired');
    if (flow.provider !== provider || !has(provider)) throw fail('failed', 'state belongs to another provider');
    if (!safeEqual(flow.browser, browser)) throw fail('failed', 'state started in another browser');
    if (params.error) throw fail('cancelled', `provider returned ${String(params.error).slice(0, 60)}`);
    if (typeof params.code !== 'string' || !params.code || params.code.length > 2048) throw fail('failed', 'no code');

    const def = providers[provider];
    try {
      const idToken = await exchange(def, flow, params.code, redirectUri);
      const identity = await verifyIdToken(def, idToken, flow.nonce);
      return { flow, identity: { provider, ...identity } };
    } catch (err) {
      if (err instanceof SocialError) throw fail(err.code, err.message);
      log.warn(`${provider}: sign-in failed: ${err.message}`);
      throw fail('failed', err.message);
    }
  }

  // "Confirm it's you" for deleting an account that has no password: one fresh confirmation, one use.
  function grantReauth(userId) {
    const t = now();
    for (const [k, until] of reauth) if (until < t) reauth.delete(k);
    reauth.set(userId, t + REAUTH_TTL_MS);
  }
  function consumeReauth(userId) {
    const until = reauth.get(userId);
    reauth.delete(userId);
    return Boolean(until && until >= now());
  }

  return { enabled: Object.keys(providers).length > 0, has, list, start, complete, grantReauth, consumeReauth };
}

module.exports = { createSocial, providersFromEnv, appleClientSecret, SocialError, STATE_TTL_MS, REAUTH_TTL_MS };
