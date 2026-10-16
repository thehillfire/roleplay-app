// Sign up, sign in, email confirmation and password resets.
const crypto = require('crypto');
const { hashPassword, verifyPassword, hashToken } = require('../auth');
const { parseCredentials, badRequest } = require('../validate');
const { httpError, asyncRoute, publicUser, RESET_TTL_MS, VERIFY_TTL_MS, PLUS_MONTHLY_CREDITS } = require('./common');

module.exports = function register(app, { store, hub, auth, payments, push, mailer, ads, adminEmails, authLimiter, member, siteUrl }) {
  // Failed logins per account, whatever IPs they come from (slow down distributed guessing).
  const failedLogins = new Map(); // email -> { count, resetAt }
  const LOGIN_FAILS = { max: 10, windowMs: 15 * 60 * 1000 };
  const loginLocked = (email) => {
    const e = failedLogins.get(email);
    return Boolean(e && Date.now() < e.resetAt && e.count >= LOGIN_FAILS.max);
  };
  const noteFailedLogin = (email) => {
    const t = Date.now();
    const e = failedLogins.get(email);
    if (!e || t > e.resetAt) {
      // Bound memory by dropping expired entries, then the oldest; never wipe everything
      // (that would let a flood of junk emails reset a targeted account's counter).
      if (failedLogins.size > 50000) {
        for (const [k, v] of failedLogins) if (t > v.resetAt) failedLogins.delete(k);
        for (const k of failedLogins.keys()) {
          if (failedLogins.size <= 45000) break;
          failedLogins.delete(k);
        }
      }
      failedLogins.set(email, { count: 1, resetAt: t + LOGIN_FAILS.windowMs });
    } else {
      e.count += 1;
    }
  };
  // Emails a confirmation link. Moderator rights (ADMIN_EMAILS) need a confirmed inbox, so
  // registering someone else's address first gets you nothing.
  const sendVerification = async (req, user) => {
    const base = siteUrl(req);
    if (!base) return;
    const token = crypto.randomBytes(32).toString('base64url');
    await store.createEmailVerification(hashToken(token), user.id, VERIFY_TTL_MS);
    mailer.send({
      to: user.email,
      subject: 'Confirm your email for Kindred',
      text: `Welcome to Kindred, ${user.handle}.\n\nConfirm this is your email so you can reset your password if you ever forget it:\n${base}/verify#${token}\n\nIf you didn't sign up, ignore this email.`,
    }).catch((err) => console.error('verification email failed', err.message));
  };
  const promoteIfAdmin = async (user) => {
    if (user.emailVerified && adminEmails.includes(user.email) && user.role !== 'admin') {
      await store.setUserRole(user.email, 'admin');
      return { ...user, role: 'admin' };
    }
    return user;
  };

  // --- Accounts ---

  app.post('/api/auth/signup', authLimiter, asyncRoute(async (req, res) => {
    const { email, password, birthdate } = parseCredentials(req.body, { signup: true });
    const user = await store.createUser({ email, birthdate, passwordHash: await hashPassword(password) });
    if (!user) throw httpError(409, 'An account with that email already exists.');
    await sendVerification(req, user);
    await auth.startSession(req, res, user.id);
    res.status(201).json({ user: publicUser(user) });
  }));

  app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
    const { email, password } = parseCredentials(req.body, { signup: false });
    if (loginLocked(email)) throw httpError(429, 'Too many attempts for this account. Try again in 15 minutes, or reset your password.');
    const found = await store.findUserByEmail(email);
    const ok = await verifyPassword(password, found?.passwordHash);
    if (!found || !ok) {
      noteFailedLogin(email);
      throw httpError(401, 'Email or password is incorrect.');
    }
    failedLogins.delete(email);
    const user = await promoteIfAdmin(found);
    await auth.startSession(req, res, user.id);
    res.json({ user: publicUser(user) });
  }));

  // Ends every session on every device (e.g. after using a shared computer) and drops live sockets.
  app.post('/api/auth/logout-all', auth.requireUser, asyncRoute(async (req, res) => {
    await store.deleteAllSessions(req.user.id);
    await store.deletePushSubscriptionsFor(req.user.id); // other devices shouldn't keep getting pushes
    hub.disconnect(req.user.id);
    await auth.endSession(req, res);
    res.json({ ok: true });
  }));

  app.post('/api/auth/logout', asyncRoute(async (req, res) => {
    await auth.endSession(req, res);
    res.json({ ok: true });
  }));

  // Always answers the same way, so it can't be used to find out who has an account.
  app.post('/api/auth/forgot', authLimiter, asyncRoute(async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const found = email ? await store.findUserByEmail(email) : null;
    if (found && found.status !== 'deleted') {
      const base = siteUrl(req);
      if (!base) {
        console.error('PUBLIC_URL is not set; refusing to email a reset link built from the Host header.');
        return res.json({ ok: true });
      }
      const token = crypto.randomBytes(32).toString('base64url');
      await store.createPasswordReset(hashToken(token), found.id, RESET_TTL_MS);
      mailer.send({
        to: email,
        subject: 'Reset your Kindred password',
        text: `Someone asked to reset the password for your Kindred account.\n\nChoose a new password here (the link works once, for one hour):\n${base}/reset#${token}\n\nIf this wasn't you, you can ignore this email.`,
      }).catch((err) => console.error('reset email failed', err.message));
    }
    res.json({ ok: true });
  }));

  app.post('/api/auth/verify', authLimiter, asyncRoute(async (req, res) => {
    if (typeof req.body.token !== 'string' || !req.body.token) throw badRequest('Confirmation link is invalid');
    const user = await store.useEmailVerification(hashToken(req.body.token));
    if (!user) throw httpError(400, 'This confirmation link has expired or was already used.');
    await promoteIfAdmin(user);
    res.json({ ok: true });
  }));

  app.post('/api/auth/resend-verification', member, authLimiter, asyncRoute(async (req, res) => {
    if (!req.user.emailVerified) await sendVerification(req, req.user);
    res.json({ ok: true });
  }));

  app.post('/api/auth/reset', authLimiter, asyncRoute(async (req, res) => {
    const { token, password } = req.body;
    if (typeof token !== 'string' || !token) throw badRequest('Reset link is invalid');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw badRequest('Password must be at least 8 characters');
    const userId = await store.usePasswordReset(hashToken(token), await hashPassword(password));
    if (!userId) throw httpError(400, 'This reset link has expired or was already used. Request a new one.');
    // Opening the emailed link proves the inbox, so this also confirms the email.
    await store.markEmailVerified(userId);
    const resetUser = await promoteIfAdmin(await store.getUser(userId));
    failedLogins.delete(resetUser.email); // the owner just proved who they are
    hub.disconnect(userId);
    await auth.startSession(req, res, userId);
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', asyncRoute(async (req, res) => {
    res.json({
      user: req.user ? { ...publicUser(req.user), helped: await store.helpedCount(req.user.id) } : null,
      billing: { enabled: payments.enabled, priceCents: payments.priceCents, plusPriceCents: payments.plusPriceCents, plusCredits: PLUS_MONTHLY_CREDITS, currency: payments.currency },
      push: { publicKey: push.publicKey },
      ads,
    });
  }));
};
