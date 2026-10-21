// "Continue with Google/Apple", against a fake provider that signs real RS256 tokens with a real key,
// so the server's checks (signature, issuer, audience, expiry, nonce) run for real.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { start, client, adult } = require('./helpers');
const { createSocial, appleClientSecret, STATE_TTL_MS } = require('../src/social');

const JWKS = 'https://idp.test/keys';
const TOKEN = 'https://idp.test/token';
const CLIENT_ID = 'client-1';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwkOf = (key, kid) => ({ ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
function mint({ claims, header = { alg: 'RS256', kid: 'k1' }, key = privateKey }) {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

function fakeProvider(overrides = {}) {
  const clock = { t: Date.now() };
  const idp = { keys: [jwkOf(publicKey, 'k1')], tokenStatus: 200, jwksStatus: 200, tokens: [], jwksFetches: 0, idToken: null };
  const fetchImpl = async (url, init = {}) => {
    if (url === JWKS) {
      idp.jwksFetches += 1;
      return idp.jwksStatus === 200
        ? { ok: true, status: 200, json: async () => ({ keys: idp.keys }) }
        : { ok: false, status: idp.jwksStatus, json: async () => ({}) };
    }
    if (url === TOKEN) {
      idp.tokens.push(Object.fromEntries(new URLSearchParams(init.body)));
      if (idp.tokenStatus !== 200) return { ok: false, status: idp.tokenStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id_token: idp.idToken() }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const providers = {
    fake: {
      id: 'fake', label: 'Fake', clientId: CLIENT_ID, clientSecret: () => 'secret-1',
      authUrl: 'https://idp.test/authorize', tokenUrl: TOKEN, jwksUrl: JWKS,
      issuers: ['https://idp.test'], scope: 'openid email', pkce: true,
      extraAuthParams: { prompt: 'select_account' }, reauthParams: { prompt: 'login' },
      ...overrides,
    },
  };
  const social = createSocial({ providers, fetchImpl, now: () => clock.t, log: { warn() {} } });
  return { idp, clock, social };
}

// Sends the browser to the provider (our /start), then answers as the provider would.
async function begin(api, body = {}) {
  const res = await api('POST', '/api/auth/social/start', { provider: 'fake', mode: 'login', ...body });
  if (res.status !== 200) return res;
  const url = new URL(res.body.url);
  return { ...res, url, state: url.searchParams.get('state'), nonce: url.searchParams.get('nonce') };
}

function answerWith(p, started, claims = {}, tokenOptions = {}) {
  const nowS = Math.floor(p.clock.t / 1000);
  p.idp.idToken = () => mint({
    claims: {
      iss: 'https://idp.test', aud: CLIENT_ID, sub: 'sub-1', email: 'sam@example.com', email_verified: true,
      nonce: started.nonce, iat: nowS, exp: nowS + 600, ...claims,
    },
    ...tokenOptions,
  });
}

const outcome = (r) => Object.fromEntries(new URL(r.location, 'http://x').searchParams);
const hasSession = (api) => api.cookie() !== '';

async function setup(t, { providerOverrides, ...options } = {}) {
  const p = fakeProvider(providerOverrides);
  // Plenty of sign-in attempts per minute: these tests make dozens (the last one checks the real limit).
  const s = await start({ social: p.social, authRateLimit: { max: 1000, windowMs: 60000 }, ...options });
  t.after(s.stop);
  return { p, s };
}

async function signUpVia(t, ctx, { claims, api = client(ctx.s.base), body = {} } = {}) {
  const started = await begin(api, { mode: 'signup', birthdate: '1990-01-01', agree: true, ...body });
  answerWith(ctx.p, started, claims);
  const r = await api.raw('GET', `/auth/callback/fake?code=abc&state=${started.state}`);
  return { api, started, r };
}

test('providers are advertised only when configured; preview shows the rest as "soon"', async (t) => {
  const off = await start({ social: createSocial({ providers: {} }) });
  t.after(off.stop);
  const none = (await client(off.base)('GET', '/api/auth/me')).body.social;
  assert.deepEqual(none, { providers: [], soon: [] });

  const { s } = await setup(t, { socialPreview: true });
  const me = (await client(s.base)('GET', '/api/auth/me')).body.social;
  assert.deepEqual(me.providers, [{ id: 'fake', label: 'Fake' }]);
  assert.deepEqual(me.soon.map((p) => p.id), ['google', 'apple']);
});

test('sign up with a provider: anonymous account, email confirmed, signed in; same account next time', async (t) => {
  const ctx = await setup(t);
  const { api, started, r } = await signUpVia(t, ctx);

  const url = started.url;
  assert.equal(url.origin + url.pathname, 'https://idp.test/authorize');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.match(url.searchParams.get('redirect_uri'), /\/auth\/callback\/fake$/);

  assert.equal(r.status, 303);
  assert.deepEqual(outcome(r), { signed_in: 'new' });
  assert.ok(hasSession(api));

  // What we send the provider to swap the code: PKCE verifier matches the challenge sent earlier.
  const sent = ctx.p.idp.tokens[0];
  assert.equal(sent.grant_type, 'authorization_code');
  assert.equal(sent.code, 'abc');
  assert.equal(sent.client_secret, 'secret-1');
  assert.equal(b64(crypto.createHash('sha256').update(sent.code_verifier).digest()).length > 0, true);
  assert.equal(crypto.createHash('sha256').update(sent.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));

  const me = (await api('GET', '/api/auth/me')).body.user;
  assert.equal(me.emailVerified, true, 'the provider already proved the inbox');
  assert.deepEqual(me.signIn, { hasPassword: false, providers: ['fake'] });
  assert.doesNotMatch(me.handle.toLowerCase(), /sam/, 'the handle is random, not taken from the email');
  assert.equal(JSON.stringify(me).includes('sam@example.com'), false, 'the email is not sent back to the client');

  // The flow cookie is cleared once used.
  assert.ok(r.setCookies.some((c) => /^kd_oauth=;/.test(c) && /Max-Age=0/.test(c)));

  // Coming back later with the same provider account signs in to the same person.
  const again = client(ctx.s.base);
  const second = await begin(again, { mode: 'login' });
  answerWith(ctx.p, second);
  const r2 = await again.raw('GET', `/auth/callback/fake?code=abc&state=${second.state}`);
  assert.deepEqual(outcome(r2), { signed_in: '1' });
  assert.equal((await again('GET', '/api/auth/me')).body.user.id, me.id);
});

test('the flow cookie is scoped to the callback and HttpOnly', async (t) => {
  const { s } = await setup(t);
  const res = await fetch(`${s.base}/api/auth/social/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'fake', mode: 'login' }),
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('kd_oauth='));
  assert.match(cookie, /Path=\/auth\/callback/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Max-Age=600/);
});

test('the 18+ gate applies before the person ever leaves for the provider', async (t) => {
  const { s } = await setup(t);
  const api = client(s.base);

  for (const body of [{}, { birthdate: '1990-01-01' }, { birthdate: 'nope', agree: true }]) {
    const res = await begin(api, { mode: 'signup', ...body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }

  const year = new Date().getUTCFullYear();
  const minor = await begin(api, { mode: 'signup', birthdate: `${year - 15}-03-03`, agree: true });
  assert.equal(minor.status, 403);
  assert.match(minor.body.error, /adults 18 and over/);

  // Same as email signup: trying again from that browser with an adult birthdate waits for a moderator.
  const retry = await api('POST', '/api/auth/signup', adult());
  assert.equal(retry.status, 201);
  assert.equal(retry.body.user.status, 'review');
});

test('a provider sign-up on a banned device is paused for review, like email', async (t) => {
  const ctx = await setup(t);
  const kid = client(ctx.s.base);
  await begin(kid, { mode: 'signup', birthdate: `${new Date().getUTCFullYear() - 15}-03-03`, agree: true });
  const { api } = await signUpVia(t, ctx, { api: kid });
  assert.equal((await api('GET', '/api/auth/me')).body.user.status, 'review');
});

test('signing in with an unknown provider account does not create one', async (t) => {
  const ctx = await setup(t);
  const api = client(ctx.s.base);
  const started = await begin(api, { mode: 'login' });
  answerWith(ctx.p, started);
  const r = await api.raw('GET', `/auth/callback/fake?code=abc&state=${started.state}`);
  assert.deepEqual(outcome(r), { social: 'no_account', tab: 'signup' });
  assert.equal(hasSession(api), false);
  assert.equal(await ctx.s.store.findUserByEmail('sam@example.com'), null);
});

test('a provider account is never merged into an existing email account', async (t) => {
  const ctx = await setup(t);
  // Someone already registered sam@example.com with a password.
  const owner = client(ctx.s.base);
  const created = await owner('POST', '/api/auth/signup', adult({ email: 'sam@example.com' }));
  assert.equal(created.status, 201);

  for (const mode of ['login', 'signup']) {
    const api = client(ctx.s.base);
    const started = await begin(api, { mode, ...(mode === 'signup' ? { birthdate: '1990-01-01', agree: true } : {}) });
    answerWith(ctx.p, started);
    const r = await api.raw('GET', `/auth/callback/fake?code=abc&state=${started.state}`);
    assert.equal(outcome(r).social, 'email_taken', mode);
    assert.equal(hasSession(api), false, `${mode}: no session for someone else's account`);
  }
  assert.deepEqual(await ctx.s.store.identityProviders(created.body.user.id), [], 'nothing was linked');
});

test('the provider never grants moderator rights', async (t) => {
  const ctx = await setup(t, { adminEmails: ['boss@example.com'] });
  const { api } = await signUpVia(t, ctx, { claims: { email: 'boss@example.com' } });
  assert.equal((await api('GET', '/api/auth/me')).body.user.role, 'member');
});

test('forged, replayed and mismatched answers never sign anyone in', async (t) => {
  const ctx = await setup(t);
  const nowS = () => Math.floor(ctx.p.clock.t / 1000);
  const base = (started) => ({ iss: 'https://idp.test', aud: CLIENT_ID, sub: 'sub-evil', email: 'evil@example.com', email_verified: true, nonce: started.nonce, iat: nowS(), exp: nowS() + 600 });

  const attempt = async (label, { claims = {}, token, expect = 'failed' } = {}) => {
    const api = client(ctx.s.base);
    const started = await begin(api, { mode: 'signup', birthdate: '1990-01-01', agree: true });
    ctx.p.idp.idToken = token ? () => token(started) : () => mint({ claims: { ...base(started), ...claims } });
    const r = await api.raw('GET', `/auth/callback/fake?code=abc&state=${started.state}`);
    assert.equal(outcome(r).social, expect, label);
    assert.equal(hasSession(api), false, `${label}: no session`);
    assert.equal(await ctx.s.store.findUserByEmail('evil@example.com'), null, `${label}: no account`);
  };

  await attempt('wrong nonce', { claims: { nonce: 'someone-elses' } });
  await attempt('missing nonce', { claims: { nonce: undefined } });
  await attempt('wrong audience', { claims: { aud: 'another-app' } });
  await attempt('audience list without us', { claims: { aud: ['a', 'b'] } });
  await attempt('wrong issuer', { claims: { iss: 'https://evil.test' } });
  await attempt('expired', { claims: { exp: nowS() - 3600 } });
  await attempt('issued in the future', { claims: { iat: nowS() + 3600 } });
  await attempt('no subject', { claims: { sub: '' } });
  await attempt('signed with someone else\'s key', { token: (st) => mint({ claims: base(st), key: otherKey.privateKey }) });
  await attempt('unknown key id', { token: (st) => mint({ claims: base(st), header: { alg: 'RS256', kid: 'nope' } }) });
  await attempt('valid signature but a different declared algorithm', { token: (st) => mint({ claims: base(st), header: { alg: 'RS512', kid: 'k1' } }) });
  await attempt('alg none (unsigned)', { token: (st) => `${b64({ alg: 'none', kid: 'k1' })}.${b64(base(st))}.` });
  await attempt('alg none with the right-looking signature slot', { token: (st) => `${b64({ alg: 'none', kid: 'k1' })}.${b64(base(st))}.AAAA` });
  await attempt('HS256 signed with the public key as the secret', {
    token: (st) => {
      const input = `${b64({ alg: 'HS256', kid: 'k1' })}.${b64(base(st))}`;
      const mac = crypto.createHmac('sha256', publicKey.export({ type: 'spki', format: 'pem' })).update(input).digest('base64url');
      return `${input}.${mac}`;
    },
  });
  await attempt('payload swapped after signing', {
    token: (st) => {
      const [h, , sig] = mint({ claims: { ...base(st), email: 'sam@example.com' } }).split('.');
      return `${h}.${b64(base(st))}.${sig}`;
    },
  });
  await attempt('not a JWT', { token: () => 'abc' });
  await attempt('too long', { token: () => 'a.'.repeat(5000) });
  await attempt('missing id_token', { token: () => undefined });
  await attempt('email not verified', { claims: { email_verified: false }, expect: 'unverified_email' });
  await attempt('email_verified missing', { claims: { email_verified: undefined }, expect: 'unverified_email' });
  await attempt('no email', { claims: { email: undefined }, expect: 'no_email' });
  await attempt('email is not an email', { claims: { email: 'nope' }, expect: 'no_email' });
});

test('state is single-use, tied to the browser that started it, and expires', async (t) => {
  const ctx = await setup(t);

  // Replay.
  const api = client(ctx.s.base);
  const started = await begin(api, { mode: 'signup', birthdate: '1990-01-01', agree: true });
  answerWith(ctx.p, started);
  const url = `/auth/callback/fake?code=abc&state=${started.state}`;
  assert.deepEqual(outcome(await api.raw('GET', url)), { signed_in: 'new' });
  const replayer = client(ctx.s.base);
  assert.equal(outcome(await api.raw('GET', url)).social, 'expired', 'replay by the same browser');
  assert.equal(outcome(await replayer.raw('GET', url)).social, 'expired', 'replay by another');

  // A link someone else started (no cookie, or somebody else's cookie): login CSRF.
  const victim = client(ctx.s.base);
  const attacker = client(ctx.s.base);
  const theirs = await begin(attacker, { mode: 'signup', birthdate: '1990-01-01', agree: true });
  answerWith(ctx.p, theirs, { sub: 'sub-attacker', email: 'attacker@example.com' });
  const cross = await victim.raw('GET', `/auth/callback/fake?code=abc&state=${theirs.state}`);
  assert.equal(outcome(cross).social, 'failed');
  assert.equal(hasSession(victim), false);
  assert.equal(await ctx.s.store.findUserByEmail('attacker@example.com'), null);
  // ...and that attempt used the state up, so the attacker can't try again either.
  assert.equal(outcome(await attacker.raw('GET', `/auth/callback/fake?code=abc&state=${theirs.state}`)).social, 'expired');

  // Expiry.
  const late = client(ctx.s.base);
  const stale = await begin(late, { mode: 'login' });
  answerWith(ctx.p, stale);
  ctx.p.clock.t += STATE_TTL_MS + 1000;
  assert.equal(outcome(await late.raw('GET', `/auth/callback/fake?code=abc&state=${stale.state}`)).social, 'expired');

  // Junk.
  for (const state of ['', 'x'.repeat(500), 'not-a-state']) {
    assert.equal(outcome(await client(ctx.s.base).raw('GET', `/auth/callback/fake?code=abc&state=${state}`)).social, 'expired');
  }
  assert.equal(outcome(await client(ctx.s.base).raw('GET', '/auth/callback/fake?code=abc')).social, 'expired');
});

test('callbacks for another or unknown provider, a missing code, or a cancelled prompt', async (t) => {
  const ctx = await setup(t);

  const api = client(ctx.s.base);
  const started = await begin(api, { mode: 'login' });
  assert.equal(outcome(await api.raw('GET', `/auth/callback/other?code=abc&state=${started.state}`)).social, 'failed');

  const noCode = client(ctx.s.base);
  const s2 = await begin(noCode, { mode: 'login' });
  assert.equal(outcome(await noCode.raw('GET', `/auth/callback/fake?state=${s2.state}`)).social, 'failed');

  const cancelled = client(ctx.s.base);
  const s3 = await begin(cancelled, { mode: 'signup', birthdate: '1990-01-01', agree: true });
  const r = await cancelled.raw('GET', `/auth/callback/fake?error=access_denied&state=${s3.state}`);
  assert.deepEqual(outcome(r), { social: 'cancelled', tab: 'signup' });
  assert.equal(ctx.p.idp.tokens.length, 0, 'a cancelled prompt never reaches the token endpoint');
});

test('start refuses unknown providers, bad modes, and reauth without a matching account', async (t) => {
  const { s } = await setup(t);
  const api = client(s.base);
  assert.equal((await api('POST', '/api/auth/social/start', { provider: 'nope', mode: 'login' })).status, 404);
  assert.equal((await api('POST', '/api/auth/social/start', { provider: 'constructor', mode: 'login' })).status, 404);
  assert.equal((await api('POST', '/api/auth/social/start', { provider: 'fake', mode: 'hack' })).status, 400);
  assert.equal((await api('POST', '/api/auth/social/start', { provider: 'fake', mode: 'reauth' })).status, 401);

  const member = client(s.base);
  await member('POST', '/api/auth/signup', adult());
  assert.equal((await member('POST', '/api/auth/social/start', { provider: 'fake', mode: 'reauth' })).status, 400, 'a password account has nothing to re-confirm with');
});

test('the provider endpoints failing fails closed', async (t) => {
  const ctx = await setup(t);
  const run = async () => {
    const api = client(ctx.s.base);
    const started = await begin(api, { mode: 'signup', birthdate: '1990-01-01', agree: true });
    answerWith(ctx.p, started);
    const r = await api.raw('GET', `/auth/callback/fake?code=abc&state=${started.state}`);
    return { r, api };
  };

  ctx.p.idp.tokenStatus = 400;
  let out = await run();
  assert.equal(outcome(out.r).social, 'failed');
  assert.equal(hasSession(out.api), false);
  ctx.p.idp.tokenStatus = 200;

  ctx.p.idp.jwksStatus = 503;
  out = await run();
  assert.equal(outcome(out.r).social, 'failed', 'no keys, no trust');
  assert.equal(hasSession(out.api), false);
  ctx.p.idp.jwksStatus = 200;

  out = await run();
  assert.equal(outcome(out.r).signed_in, 'new', 'and it recovers');
});

test('signing keys: cached, and re-read (at most once a minute) when the provider rotates', async (t) => {
  const ctx = await setup(t);
  const { idp, clock } = ctx.p;

  await signUpVia(t, ctx, { claims: { sub: 'a', email: 'a@example.com' } });
  await signUpVia(t, ctx, { claims: { sub: 'b', email: 'b@example.com' } });
  assert.equal(idp.jwksFetches, 1, 'second sign-in used the cached keys');

  // The provider rotates: new key id, old one gone.
  idp.keys = [jwkOf(otherKey.publicKey, 'k2')];
  const rotated = async (sub) => {
    const api = client(ctx.s.base);
    const started = await begin(api, { mode: 'signup', birthdate: '1990-01-01', agree: true });
    const nowS = Math.floor(clock.t / 1000);
    idp.idToken = () => mint({ header: { alg: 'RS256', kid: 'k2' }, key: otherKey.privateKey, claims: { iss: 'https://idp.test', aud: CLIENT_ID, sub, email: `${sub}@example.com`, email_verified: true, nonce: started.nonce, iat: nowS, exp: nowS + 600 } });
    return outcome(await api.raw('GET', `/auth/callback/fake?code=abc&state=${started.state}`));
  };
  assert.equal((await rotated('c')).social, 'failed', 'too soon to look again: an unknown key is refused');
  assert.equal(idp.jwksFetches, 1);
  clock.t += 61 * 1000;
  assert.equal((await rotated('c')).signed_in, 'new', 'after a minute the new key is picked up');
  assert.equal(idp.jwksFetches, 2);
});

test('an account without a password: no password sign-in; deleting it asks the provider again', async (t) => {
  const ctx = await setup(t);
  const { api } = await signUpVia(t, ctx);
  const user = (await api('GET', '/api/auth/me')).body.user;

  // The placeholder matches no password.
  for (const password of ['social', '!', 'quiet-harbor-9', '']) {
    const res = await client(ctx.s.base)('POST', '/api/auth/login', { email: 'sam@example.com', password });
    assert.equal(res.status, password ? 401 : 400, password || '(empty)');
  }

  // Deleting: no password to type, so a bare request (or a made-up one) is refused...
  assert.equal((await api('POST', '/api/account/delete', {})).status, 401);
  assert.equal((await api('POST', '/api/account/delete', { password: 'social' })).status, 401);
  assert.equal((await api('GET', '/api/auth/me')).body.user.id, user.id, 'still there');

  // ...a re-confirmation by a different provider account doesn't count...
  const wrong = await begin(api, { mode: 'reauth' });
  answerWith(ctx.p, wrong, { sub: 'someone-else', email: 'else@example.com' });
  assert.deepEqual(outcome(await api.raw('GET', `/auth/callback/fake?code=abc&state=${wrong.state}`)), { social: 'wrong_account' });
  assert.equal((await api('POST', '/api/account/delete', {})).status, 401);

  // ...the right one does, once.
  const right = await begin(api, { mode: 'reauth' });
  assert.equal(right.url.searchParams.get('prompt'), 'login', 'asks the provider to confirm afresh');
  answerWith(ctx.p, right);
  assert.deepEqual(outcome(await api.raw('GET', `/auth/callback/fake?code=abc&state=${right.state}`)), { reauth: 'ok' });
  assert.equal((await api('POST', '/api/account/delete', {})).status, 200);
  assert.equal((await api('GET', '/api/auth/me')).body.user, null);

  // Someone else can't ride the confirmation: it was used up with the account.
  assert.equal(await ctx.s.store.findUserByIdentity('fake', 'sub-1'), null, 'the link to the provider account is gone');

  // The same provider account can start over with a brand-new, unrelated account.
  const fresh = await signUpVia(t, ctx);
  assert.deepEqual(outcome(fresh.r), { signed_in: 'new' });
  assert.notEqual((await fresh.api('GET', '/api/auth/me')).body.user.id, user.id);
});

test('re-confirmation only counts for the person who just made it, and only once', async (t) => {
  const ctx = await setup(t);
  const { api } = await signUpVia(t, ctx);
  const started = await begin(api, { mode: 'reauth' });
  answerWith(ctx.p, started);
  await api.raw('GET', `/auth/callback/fake?code=abc&state=${started.state}`);

  // Expires after five minutes.
  ctx.p.clock.t += 6 * 60 * 1000;
  assert.equal((await api('POST', '/api/account/delete', {})).status, 401, 'too late');
});

test('setting a password later (via reset) turns it into a normal account: delete with the password', async (t) => {
  const ctx = await setup(t);
  const { api } = await signUpVia(t, ctx);
  const user = await ctx.s.store.findUserByEmail('sam@example.com');
  assert.equal(await ctx.s.store.hasPassword(user.id), false);

  const { hashPassword } = require('../src/auth');
  await ctx.s.db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword('a-new-long-password'), user.id]);
  assert.equal((await api('GET', '/api/auth/me')).body.user.signIn.hasPassword, true);
  assert.equal((await api('POST', '/api/account/delete', { password: 'wrong-password-1' })).status, 401);
  assert.equal((await api('POST', '/api/account/delete', { password: 'a-new-long-password' })).status, 200);
});

test('Apple: answers come back as a form POST, and the client secret is a signed ES256 JWT', async (t) => {
  const ctx = await setup(t, { providerOverrides: { id: 'fake', responseMode: 'form_post', pkce: false } });
  const api = client(ctx.s.base);
  const started = await begin(api, { mode: 'signup', birthdate: '1990-01-01', agree: true });
  assert.equal(started.url.searchParams.get('response_mode'), 'form_post');
  assert.equal(started.url.searchParams.has('code_challenge'), false);

  answerWith(ctx.p, started);
  const r = await api.raw('POST', '/auth/callback/fake', { form: { code: 'abc', state: started.state } });
  assert.equal(r.status, 303);
  assert.deepEqual(outcome(r), { signed_in: 'new' });
  assert.equal('code_verifier' in ctx.p.idp.tokens.at(-1), false);

  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const t0 = 1_700_000_000_000;
  const secret = appleClientSecret({ clientId: 'com.example.web', teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: pem, now: () => t0 });
  const [h, p, sig] = secret.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: 'TEAM123456', iat: 1_700_000_000, exp: 1_700_000_300, aud: 'https://appleid.apple.com', sub: 'com.example.web' });
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), true);
});

test('the callback is outside /api (it must accept a plain form POST) and rate-limited like sign-in', async (t) => {
  const ctx = await setup(t, { authRateLimit: { max: 3, windowMs: 60000 } });
  const api = client(ctx.s.base);
  const codes = [];
  for (let i = 0; i < 5; i += 1) codes.push((await api.raw('GET', '/auth/callback/fake?code=a&state=x')).status);
  assert.deepEqual(codes, [303, 303, 303, 429, 429]);
});
