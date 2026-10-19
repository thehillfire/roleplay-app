// "Continue with Google / Apple": start the flow, and finish it when the provider sends the browser back.
//
// Policies, on purpose:
//  - Same 18+ gate as email signup. New accounts must send a birthdate and agree before leaving
//    for the provider; an under-18 answer is refused and the device is flagged, exactly as for email.
//  - Never merged into an existing email account. If the email already belongs to someone, the
//    person is told to sign in with their password. A provider's say-so is not enough to hand over
//    an account (this codebase already treats email squatting as a real attack).
//  - No name, photo or token is kept: just the provider's account id and the verified email.
//  - No moderator rights from here. ADMIN_EMAILS are only granted after a password reset.
const crypto = require('crypto');
const express = require('express');
const { readCookie, deviceHash } = require('../auth');
const { parseAdult, badRequest } = require('../validate');
const { SocialError } = require('../social');
const { httpError, asyncRoute } = require('./common');
const { createSignup } = require('./signup');

const BROWSER_COOKIE = 'kd_oauth';
const NO_PASSWORD = 'social'; // password_hash for accounts that only sign in through a provider; matches no password

module.exports = function register(app, { store, auth, mailer, social, authLimiter, siteUrl }) {
  const { finish } = createSignup({ store, auth, mailer, siteUrl });
  const redirectUriFor = (base, provider) => `${base}/auth/callback/${provider}`;

  // The cookie ties the flow to this browser. SameSite=None because Apple answers with a
  // cross-site form POST; scoped to the callback path and short-lived.
  const flowCookie = (req, value, maxAgeSeconds) => {
    const secure = req.secure || process.env.NODE_ENV === 'production';
    return `${BROWSER_COOKIE}=${value}; Path=/auth/callback; HttpOnly; Max-Age=${maxAgeSeconds}; SameSite=${secure ? 'None' : 'Lax'}${secure ? '; Secure' : ''}`;
  };

  app.post('/api/auth/social/start', authLimiter, asyncRoute(async (req, res) => {
    const { provider, mode } = req.body;
    if (typeof provider !== 'string' || !social.has(provider)) throw httpError(404, "That sign-in option isn't available.");
    if (!['login', 'signup', 'reauth'].includes(mode)) throw badRequest('mode must be login, signup or reauth');
    const base = siteUrl(req);
    if (!base) throw httpError(503, "Signing in with a provider isn't ready yet.");

    let signup;
    if (mode === 'signup') {
      try {
        signup = { birthdate: parseAdult(req.body) };
      } catch (err) {
        if (err.underage) await store.flagUnderageDevice(deviceHash(req, res));
        throw err;
      }
    }
    let userId;
    if (mode === 'reauth') {
      if (!req.user) throw httpError(401, 'Sign in to continue.');
      if (!(await store.identityProviders(req.user.id)).includes(provider)) throw httpError(400, "This account doesn't sign in with that option.");
      userId = req.user.id;
    }

    const browser = crypto.randomBytes(18).toString('base64url');
    const url = social.start({ provider, mode, redirectUri: redirectUriFor(base, provider), browser, signup, userId });
    res.append('Set-Cookie', flowCookie(req, browser, 10 * 60));
    res.json({ url });
  }));

  // Google comes back with a GET; Apple with a form POST. Neither can send JSON, so these live
  // outside /api (whose JSON-only guard is the CSRF check). The one-time `state`, tied to the
  // cookie above, is what protects this endpoint.
  const callback = asyncRoute(async (req, res) => {
    const provider = req.params.provider;
    const back = (query) => {
      res.append('Set-Cookie', flowCookie(req, '', 0));
      res.set('Cache-Control', 'no-store');
      res.redirect(303, `/?${new URLSearchParams(query)}`);
    };

    const base = siteUrl(req);
    if (!base || !social.has(provider)) return back({ social: 'failed' });

    let result;
    try {
      result = await social.complete({
        provider,
        params: req.method === 'POST' ? req.body || {} : req.query,
        browser: readCookie(req, BROWSER_COOKIE),
        redirectUri: redirectUriFor(base, provider),
      });
    } catch (err) {
      if (!(err instanceof SocialError)) throw err;
      console.warn(`social sign-in (${provider}) stopped: ${err.code}: ${err.message}`);
      return back({ social: err.code, ...(err.mode === 'signup' ? { tab: 'signup' } : {}) });
    }

    const { flow, identity } = result;
    const known = await store.findUserByIdentity(identity.provider, identity.subject);

    if (flow.mode === 'reauth') {
      if (known && known.id === flow.userId) {
        social.grantReauth(known.id);
        return back({ reauth: 'ok' });
      }
      return back({ social: 'wrong_account' });
    }

    if (known && known.status !== 'deleted') {
      await store.noteDevice(known.id, deviceHash(req, res));
      await auth.startSession(req, res, known.id);
      return back({ signed_in: '1' });
    }

    if (flow.mode === 'login') {
      const owner = await store.findUserByEmail(identity.email);
      return back({ social: owner ? 'email_taken' : 'no_account', ...(owner ? {} : { tab: 'signup' }) });
    }

    // New account. The age gate already passed when the flow started; the birthdate rode along.
    const user = await store.createUser({ email: identity.email, birthdate: flow.signup.birthdate, passwordHash: NO_PASSWORD });
    if (!user) return back({ social: 'email_taken' });
    await store.addIdentity(user.id, identity.provider, identity.subject);
    await finish(req, res, user, { emailConfirmed: true });
    return back({ signed_in: 'new' });
  });

  app.get('/auth/callback/:provider', authLimiter, callback);
  app.post('/auth/callback/:provider', authLimiter, express.urlencoded({ extended: false, limit: '16kb' }), callback);
};

module.exports.NO_PASSWORD = NO_PASSWORD;
