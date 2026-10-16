const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { createAuth, hashPassword, verifyPassword, hashToken } = require('./auth');
const { parseCredentials, parseMessageBody, str, badRequest } = require('./validate');
const { screenMessage } = require('./moderation');
const { createPayments } = require('./payments');
const { createPush } = require('./push');
const { createMailer } = require('./mailer');
const { envInt } = require('./env');
const crypto = require('crypto');

const RESET_TTL_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNSEND_WINDOW_MS = 5 * 60 * 1000;

const REPORT_REASONS = ['harassment', 'sexual', 'minor', 'hate', 'spam', 'self_harm', 'other'];
// Auto-pause (pending human review) when this many different people report someone within a week.
const AUTO_PAUSE = { window: 7 * 24 * 60 * 60 * 1000, reporters: 3, minorReporters: 2, minReporterAgeMs: 24 * 60 * 60 * 1000 };

function createRateLimiter({ max, windowMs, now = Date.now, key = (req) => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const k = key(req);
    const t = now();
    const entry = hits.get(k);
    if (!entry || t > entry.resetAt) {
      // Opportunistic cleanup keeps the map from growing without bound.
      if (hits.size > 10000) for (const [hk, hv] of hits) if (t > hv.resetAt) hits.delete(hk);
      hits.set(k, { count: 1, resetAt: t + windowMs });
      return next();
    }
    if (entry.count >= max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - t) / 1000)));
      return res.status(429).json({ error: 'Slow down a little and try again shortly.' });
    }
    entry.count += 1;
    return next();
  };
}

const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const publicUser = ({ id, handle, role, status, connectCredits, emailVerified, createdAt }) => ({ id, handle, role, status, connectCredits, emailVerified, createdAt });

// What one side of a conversation may see about its connect state.
function connectionView(c, userId) {
  if (!c) return { status: 'none' };
  const mine = c.requesterId === userId;
  if (c.status === 'accepted') {
    const me = mine ? c.requester : c.accepter;
    const them = mine ? c.accepter : c.requester;
    return { status: 'accepted', me, partner: them };
  }
  return { status: c.status, mine };
}

function createApp({
  store,
  hub,
  authRateLimit = { max: envInt('AUTH_RATE_LIMIT', 10), windowMs: 60000 },
  messageRateLimit = { max: 30, windowMs: 60000 },
  staticDir,
  log = process.env.NODE_ENV === 'test' || process.env.REQUEST_LOG === 'off' ? null : console,
  payments = createPayments(),
  autoPauseMinReporterAgeMs = AUTO_PAUSE.minReporterAgeMs,
  push = createPush(),
  mailer = createMailer(),
  publicUrl = process.env.PUBLIC_URL,
  // The Host header is attacker-controlled, so links in emails and payment redirects
  // only fall back to it in development. Production needs PUBLIC_URL.
  allowHostFallback = process.env.NODE_ENV !== 'production',
  // Google AdSense on the home screen only. Off unless both IDs are set.
  ads = process.env.ADSENSE_CLIENT && process.env.ADSENSE_SLOT
    ? { client: process.env.ADSENSE_CLIENT, slot: process.env.ADSENSE_SLOT }
    : null,
  adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
} = {}) {
  if (!store || !hub) throw new Error('createApp requires a store and a hub');
  const app = express();
  const auth = createAuth(store);

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // Ad scripts only get through the CSP when ads are configured.
  const adHosts = ads ? ['https://pagead2.googlesyndication.com', 'https://*.googlesyndication.com', 'https://*.doubleclick.net', 'https://*.google.com', 'https://*.adtrafficquality.google'] : [];
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        'connect-src': ["'self'", ...adHosts],
        'script-src': ["'self'", ...adHosts],
        'frame-src': ["'self'", ...adHosts],
        'img-src': ["'self'", 'data:', ...adHosts],
      },
    },
  }));
  // Stripe webhook needs the raw body for signature checks, so it's mounted before the JSON parser.
  app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '256kb' }), asyncRoute(async (req, res) => {
    if (!payments.enabled) throw httpError(404, 'Not found');
    const event = payments.verifyWebhook(req.body.toString('utf8'), req.get('stripe-signature'));
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id || session.metadata?.user_id;
      if (session.payment_status === 'paid' && userId && (await store.getUser(userId))) {
        const credits = Math.max(1, Math.min(10, Number(session.metadata?.credits) || 1));
        const granted = await store.recordPayment({ id: session.id, userId, amountCents: session.amount_total || 0, credits });
        // Money: make sure it's on disk before telling Stripe we have it (Stripe won't retry a 200).
        await store.flush();
        if (granted) hub.push(userId, { type: 'credits.updated' });
      }
    }
    res.json({ received: true });
  }));

  // One line per API request. Never bodies or query strings: they can hold message text or tokens.
  if (log) {
    app.use('/api', (req, res, next) => {
      if (req.path === '/health') return next();
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        // Collapse ids so logs group by route and never carry conversation ids.
        const route = req.baseUrl + req.path.replace(/\/[0-9a-f-]{20,}/gi, '/:id');
        log.log(JSON.stringify({ t: new Date().toISOString(), method: req.method, route, status: res.statusCode, ms: Math.round(ms) }));
      });
      next();
    });
  }

  app.use('/api', express.json({ limit: '32kb' }));

  // State-changing API calls must be JSON. Cross-site forms can't send that without
  // a CORS preflight, which this same-origin API never approves: a simple CSRF guard.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!/^application\/json\b/i.test(req.get('content-type') || '')) {
      return res.status(415).json({ error: 'Requests must be sent as JSON.' });
    }
    return next();
  });
  app.use('/api', auth.loadUser());

  const authLimiter = createRateLimiter(authRateLimit);
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
      if (failedLogins.size > 50000) failedLogins.clear(); // crude bound on memory
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

  const siteUrl = (req) => (publicUrl ? publicUrl.replace(/\/$/, '') : allowHostFallback ? `${req.protocol}://${req.get('host')}` : null);
  const messageLimiter = createRateLimiter({ ...messageRateLimit, key: (req) => req.user.id });

  // Signed in and in good standing.
  const member = (req, res, next) => auth.requireUser(req, res, () => {
    if (req.user.status !== 'active') {
      return res.status(403).json({ error: 'Your account is paused while a moderator takes a look.', paused: true });
    }
    return next();
  });

  // Loads the conversation and checks the caller belongs to it.
  const conversation = asyncRoute(async (req, res, next) => {
    const m = await store.getMembership(req.user.id, req.params.id);
    if (!m) throw httpError(404, 'Conversation not found.');
    req.conversation = m;
    next();
  });

  // Load balancers use this: it fails when the database is unreachable.
  app.get('/api/health', asyncRoute(async (req, res) => {
    try {
      await store.ping();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database unavailable' });
    }
  }));

  // Rough live numbers for the home screen ("12 people here now").
  app.get('/api/presence', member, (req, res) => res.json(hub.stats()));

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
    await promoteIfAdmin(await store.getUser(userId));
    hub.disconnect(userId);
    await auth.startSession(req, res, userId);
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', asyncRoute(async (req, res) => {
    res.json({
      user: req.user ? { ...publicUser(req.user), helped: await store.helpedCount(req.user.id) } : null,
      billing: { enabled: payments.enabled, priceCents: payments.priceCents, currency: payments.currency },
      push: { publicKey: push.publicKey },
      ads,
    });
  }));

  // --- Account ---

  app.get('/api/account/export', member, asyncRoute(async (req, res) => {
    const data = await store.exportAccount(req.user.id);
    res.set('Content-Disposition', `attachment; filename="kindred-${req.user.handle}.json"`);
    res.json(data);
  }));

  app.post('/api/account/delete', auth.requireUser, authLimiter, asyncRoute(async (req, res) => {
    const found = await store.findUserByEmail(req.user.email);
    if (typeof req.body.password !== 'string' || !(await verifyPassword(req.body.password, found?.passwordHash))) {
      throw httpError(401, 'Password is incorrect.');
    }
    const conversations = await store.listConversations(req.user.id);
    await store.deleteAccount(req.user.id);
    for (const c of conversations) hub.push(c.partner.id, { type: 'conversation.ended', conversationId: c.id });
    hub.disconnect(req.user.id);
    await auth.endSession(req, res);
    res.json({ ok: true });
  }));

  // --- Push notifications ---

  app.post('/api/push/subscribe', member, asyncRoute(async (req, res) => {
    if (!push.enabled) throw httpError(503, 'Notifications are not set up on this server.');
    const sub = req.body.subscription;
    const valid = sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000
      && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
    if (!valid) throw badRequest('Invalid push subscription');
    await store.savePushSubscription(req.user.id, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
    res.status(201).json({ ok: true });
  }));

  app.post('/api/push/unsubscribe', member, asyncRoute(async (req, res) => {
    if (typeof req.body.endpoint === 'string') await store.deletePushSubscription(req.body.endpoint, req.user.id);
    res.json({ ok: true });
  }));

  // --- Billing ---

  app.post('/api/billing/checkout', member, asyncRoute(async (req, res) => {
    if (!payments.enabled) throw httpError(503, "Payments aren't set up yet. Connecting is free for now.");
    const base = siteUrl(req);
    if (!base) throw httpError(503, 'Payments need PUBLIC_URL to be configured.');
    res.json(await payments.createCheckout({ userId: req.user.id, returnUrl: `${base}/` }));
  }));

  // --- Conversations ---

  app.get('/api/conversations', member, asyncRoute(async (req, res) => {
    const conversations = await store.listConversations(req.user.id);
    res.json({
      conversations: conversations.map(({ partner, ...c }) => ({
        ...c,
        partner: { handle: partner.handle, online: hub.isOnline(partner.id) },
      })),
    });
  }));

  app.get('/api/conversations/:id', member, conversation, asyncRoute(async (req, res) => {
    const partner = await store.getUser(req.conversation.partnerId);
    const blocked = await store.isBlocked(req.user.id, partner.id);
    if (blocked) throw httpError(404, 'Conversation not found.');
    const before = Number(req.query.before) || undefined;
    const beforeId = typeof req.query.beforeId === 'string' ? req.query.beforeId.slice(0, 64) : undefined;
    const messages = await store.listMessages(req.user.id, req.conversation.id, { before, beforeId });
    const [connection, counts, feedback, partnerReadAt] = await Promise.all([
      store.getConnection(req.conversation.id).then((c) => connectionView(c, req.user.id)),
      store.messageCounts(req.conversation.id, req.user.id),
      store.myFeedback(req.conversation.id, req.user.id),
      req.conversation.partnerReadAt,
    ]);
    // Ask "did this help?" once a real exchange has happened.
    const canRate = counts.mine >= 2 && counts.theirs >= 2;
    res.json({
      conversation: {
        id: req.conversation.id,
        partner: { handle: partner.handle, online: hub.isOnline(partner.id) },
        connection,
        partnerReadAt,
        feedback: { canRate, helpful: feedback },
      },
      // Flags are only shown to the sender, to explain why a message was held.
      messages: messages.map(({ senderId, flags, ...m }) => ({ ...m, fromMe: senderId === req.user.id, ...(senderId === req.user.id && m.status === 'held' ? { flags } : {}) })),
    });
  }));

  app.post('/api/conversations/:id/messages', member, messageLimiter, asyncRoute(async (req, res) => {
    const body = parseMessageBody(req.body.body);
    // One query for membership, partner status, blocks and connect state (this is the hot path).
    const ctx = await store.sendContext(req.user.id, req.params.id);
    if (!ctx) throw httpError(404, 'Conversation not found.');
    const { id, partnerId } = ctx;
    if (ctx.blocked) throw httpError(403, "You can't message this person.");
    if (ctx.partnerStatus === 'deleted') throw httpError(403, 'This person has left Kindred.');

    const screen = screenMessage(body, { connected: ctx.connected });
    const message = await store.addMessage({
      conversationId: id,
      senderId: req.user.id,
      body,
      status: screen.deliver ? 'delivered' : 'held',
      flags: screen.flags.length ? screen.flags : undefined,
    });
    const { senderId, flags, ...out } = message; // eslint-disable-line no-unused-vars

    if (screen.suspend) {
      // Someone said they're under 18: pause the account until a moderator looks.
      await store.setUserStatus(req.user.id, 'review');
      hub.push(partnerId, { type: 'conversation.ended', conversationId: id });
      setImmediate(() => hub.disconnect(req.user.id));
    } else if (screen.deliver) {
      hub.push(partnerId, { type: 'message', message: { ...out, fromMe: false, ...(screen.crisis ? { crisis: true } : {}) } });
      // Not looking at the app: notify their devices (handle only, never the text).
      if (!hub.isOnline(partnerId)) {
        push.notify(store, partnerId, { title: 'Kindred', body: `New message from ${req.user.handle}`, conversationId: id, tag: id })
          .catch((err) => console.warn('push notify failed', err.message));
      }
    }
    res.status(201).json({ message: { ...out, fromMe: true, flags }, crisis: screen.crisis, paused: screen.suspend || undefined });
  }));

  app.post('/api/conversations/:id/feedback', member, conversation, asyncRoute(async (req, res) => {
    if (typeof req.body.helpful !== 'boolean') throw badRequest('helpful must be true or false');
    const { id, partnerId } = req.conversation;
    const counts = await store.messageCounts(id, req.user.id);
    if (counts.mine < 2 || counts.theirs < 2) throw httpError(409, 'Chat a little first.');
    const newThanks = await store.saveFeedback({ conversationId: id, raterId: req.user.id, rateeId: partnerId, helpful: req.body.helpful });
    if (newThanks) hub.push(partnerId, { type: 'thanks', conversationId: id, from: req.user.handle });
    res.json({ helpful: req.body.helpful });
  }));

  // --- Connect: mutual reveal. Requesting costs a credit (when payments are on); accepting is free. ---

  const parseReveal = (body = {}) => ({
    name: str(body.name, 'name', 40),
    contact: str(body.contact, 'contact', 100, { required: false }),
  });

  const pushConnection = async (conversationId, userIds) => {
    const c = await store.getConnection(conversationId);
    for (const uid of userIds) {
      hub.push(uid, { type: 'connect.updated', conversationId, connection: connectionView(c, uid) });
      if (c?.status === 'pending' && !hub.isOnline(uid)) {
        push.notify(store, uid, { title: 'Kindred', body: 'Someone would like to connect with you', conversationId, tag: `connect-${conversationId}` })
          .catch(() => {});
      }
    }
  };

  app.post('/api/conversations/:id/connect', member, conversation, asyncRoute(async (req, res) => {
    const { id, partnerId } = req.conversation;
    if (await store.isBlocked(req.user.id, partnerId)) throw httpError(403, "You can't connect with this person.");
    const reveal = parseReveal(req.body);
    const existing = await store.getConnection(id);

    if (existing?.status === 'pending' && existing.requesterId === partnerId) {
      // They asked first: accepting is free and reveals both sides.
      if (!(await store.respondToConnect(id, { accept: true, ...reveal }))) throw httpError(409, 'That request was just withdrawn.');
    } else if (existing?.status === 'accepted') {
      throw httpError(409, "You're already connected.");
    } else if (existing?.status === 'pending') {
      throw httpError(409, 'Your request is waiting for their answer.');
    } else if (existing?.status === 'declined') {
      throw httpError(409, "They chose to stay anonymous. Let's respect that.");
    } else {
      const paid = payments.enabled;
      if (paid && !(await store.spendCredit(req.user.id))) {
        return res.status(402).json({ error: 'Connecting needs a credit.', needsCredit: true });
      }
      if (!(await store.createConnectRequest({ conversationId: id, requesterId: req.user.id, ...reveal, paid }))) {
        if (paid) await store.addCredits(req.user.id, 1); // lost a race with their request; refund
        throw httpError(409, 'They just sent you a request. Open it to accept.');
      }
    }
    await pushConnection(id, [partnerId]);
    res.json({ connection: connectionView(await store.getConnection(id), req.user.id) });
  }));

  app.post('/api/conversations/:id/connect/decline', member, conversation, asyncRoute(async (req, res) => {
    const { id, partnerId } = req.conversation;
    const c = await store.getConnection(id);
    if (!c || c.status !== 'pending' || c.requesterId !== partnerId) throw httpError(404, 'No request to decline.');
    // Only the request that actually flips it from pending refunds (no double refunds on races).
    if (!(await store.respondToConnect(id, { accept: false }))) throw httpError(409, 'That request was already answered.');
    if (c.paid) await store.addCredits(partnerId, 1); // their credit comes back
    await pushConnection(id, [partnerId]);
    res.json({ connection: connectionView(await store.getConnection(id), req.user.id) });
  }));

  app.post('/api/conversations/:id/connect/cancel', member, conversation, asyncRoute(async (req, res) => {
    const { id, partnerId } = req.conversation;
    const c = await store.getConnection(id);
    if (!c || !(await store.cancelConnectRequest(id, req.user.id))) throw httpError(404, 'No request to cancel.');
    if (c.paid) await store.addCredits(req.user.id, 1);
    await pushConnection(id, [partnerId]);
    res.json({ connection: { status: 'none' } });
  }));

  app.post('/api/conversations/:id/block', member, conversation, asyncRoute(async (req, res) => {
    await store.block(req.user.id, req.conversation.partnerId);
    hub.push(req.conversation.partnerId, { type: 'conversation.ended', conversationId: req.conversation.id });
    res.json({ ok: true });
  }));

  app.post('/api/conversations/:id/report', member, messageLimiter, conversation, asyncRoute(async (req, res) => {
    const reason = req.body.reason;
    if (!REPORT_REASONS.includes(reason)) throw badRequest('Choose a reason for the report');
    const details = str(req.body.details, 'details', 1000, { required: false });
    const { id, partnerId } = req.conversation;
    await store.createReport({ reporterId: req.user.id, reportedId: partnerId, conversationId: id, reason, details });
    if (req.body.block !== false) {
      await store.block(req.user.id, partnerId);
      hub.push(partnerId, { type: 'conversation.ended', conversationId: id });
    }
    const since = Date.now() - AUTO_PAUSE.window;
    const [all, minor] = await Promise.all([
      store.distinctReporters(partnerId, since, { minReporterAgeMs: autoPauseMinReporterAgeMs }),
      // Child safety outranks brigading: every reporter counts for "under 18" (a pause is reversible).
      store.distinctReporters(partnerId, since, { reason: 'minor' }),
    ]);
    if (all >= AUTO_PAUSE.reporters || minor >= AUTO_PAUSE.minorReporters) {
      const reported = await store.getUser(partnerId);
      if (reported.status === 'active') {
        await store.setUserStatus(partnerId, 'review');
        hub.disconnect(partnerId);
      }
    }
    res.status(201).json({ ok: true });
  }));

  // --- Moderation (admins) ---

  const admin = (req, res, next) => member(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Moderators only.' });
    return next();
  });

  app.get('/api/admin/stats', admin, asyncRoute(async (req, res) => {
    res.json({ ...(await store.adminStats()), ...hub.stats() });
  }));

  app.get('/api/admin/reports', admin, asyncRoute(async (req, res) => {
    const status = req.query.status === 'resolved' ? 'resolved' : 'open';
    res.json({ reports: await store.listReports({ status }) });
  }));

  app.post('/api/admin/reports/:id/resolve', admin, asyncRoute(async (req, res) => {
    const { resolution } = req.body;
    if (!['dismissed', 'warned', 'suspended'].includes(resolution)) throw badRequest('resolution must be dismissed, warned or suspended');
    const report = await store.getReport(req.params.id);
    if (!report || !(await store.resolveReport(report.id, resolution))) throw httpError(404, 'Open report not found.');
    if (resolution === 'suspended') {
      await store.setUserStatus(report.reported.id, 'suspended');
      hub.disconnect(report.reported.id);
    }
    res.json({ ok: true });
  }));

  app.get('/api/admin/held', admin, asyncRoute(async (req, res) => {
    res.json({ messages: await store.listHeldMessages() });
  }));

  app.post('/api/admin/users/:id/status', admin, asyncRoute(async (req, res) => {
    const { status } = req.body;
    if (!['active', 'suspended'].includes(status)) throw badRequest('status must be active or suspended');
    const user = await store.getUser(req.params.id);
    if (!user) throw httpError(404, 'User not found.');
    if (!(await store.setUserStatus(user.id, status))) throw httpError(409, 'This account was deleted by its owner.');
    if (status !== 'active') hub.disconnect(user.id);
    res.json({ ok: true });
  }));

  app.post('/api/conversations/:id/messages/:messageId/unsend', member, conversation, asyncRoute(async (req, res) => {
    const ok = await store.unsendMessage(req.user.id, req.conversation.id, req.params.messageId, UNSEND_WINDOW_MS);
    if (!ok) throw httpError(409, 'Messages can only be unsent for 5 minutes after sending.');
    hub.push(req.conversation.partnerId, { type: 'message.unsent', conversationId: req.conversation.id, messageId: req.params.messageId });
    res.json({ ok: true });
  }));

  app.post('/api/conversations/:id/read', member, conversation, asyncRoute(async (req, res) => {
    const at = await store.markRead(req.user.id, req.conversation.id);
    // Lets the other person show "Seen" under their latest message.
    hub.push(req.conversation.partnerId, { type: 'read', conversationId: req.conversation.id, at });
    res.json({ ok: true });
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // In production the built client is served from the same origin.
  if (staticDir) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    if (err.type === 'entity.parse.failed') status = 400;
    if (err.type === 'entity.too.large') status = 413;
    if (status >= 500 && !err.expose) console.error(err);
    let message = 'Something went wrong.';
    if (err.type === 'entity.parse.failed') message = 'Request body is not valid JSON.';
    else if (status === 413) message = 'Request is too large.';
    else if (status < 500 && err.expose) message = err.message;
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp, createRateLimiter };
