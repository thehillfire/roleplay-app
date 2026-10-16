const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { createAuth, hashPassword, verifyPassword } = require('./auth');
const { parseCredentials, parseMessageBody, str, badRequest } = require('./validate');
const { screenMessage } = require('./moderation');
const { createPayments } = require('./payments');
const { createPush } = require('./push');

const REPORT_REASONS = ['harassment', 'sexual', 'minor', 'hate', 'spam', 'self_harm', 'other'];
// Auto-pause (pending human review) when this many different people report someone within a week.
const AUTO_PAUSE = { window: 7 * 24 * 60 * 60 * 1000, reporters: 3, minorReporters: 2 };

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
const publicUser = ({ id, handle, role, status, connectCredits, createdAt }) => ({ id, handle, role, status, connectCredits, createdAt });

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
  authRateLimit = { max: 10, windowMs: 60000 },
  messageRateLimit = { max: 30, windowMs: 60000 },
  staticDir,
  payments = createPayments(),
  push = createPush(),
  adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
} = {}) {
  if (!store || !hub) throw new Error('createApp requires a store and a hub');
  const app = express();
  const auth = createAuth(store);

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        'connect-src': ["'self'"],
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
        if (granted) hub.push(userId, { type: 'credits.updated' });
      }
    }
    res.json({ received: true });
  }));

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

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  // --- Accounts ---

  app.post('/api/auth/signup', authLimiter, asyncRoute(async (req, res) => {
    const { email, password, birthdate } = parseCredentials(req.body, { signup: true });
    let user = await store.createUser({ email, birthdate, passwordHash: await hashPassword(password) });
    if (!user) throw httpError(409, 'An account with that email already exists.');
    if (adminEmails.includes(email)) {
      await store.setUserRole(email, 'admin');
      user = { ...user, role: 'admin' };
    }
    await auth.startSession(req, res, user.id);
    res.status(201).json({ user: publicUser(user) });
  }));

  app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
    const { email, password } = parseCredentials(req.body, { signup: false });
    const found = await store.findUserByEmail(email);
    const ok = await verifyPassword(password, found?.passwordHash);
    if (!found || !ok) throw httpError(401, 'Email or password is incorrect.');
    if (adminEmails.includes(email) && found.role !== 'admin') {
      await store.setUserRole(email, 'admin');
      found.role = 'admin';
    }
    await auth.startSession(req, res, found.id);
    res.json({ user: publicUser(found) });
  }));

  app.post('/api/auth/logout', asyncRoute(async (req, res) => {
    await auth.endSession(req, res);
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', (req, res) => {
    res.json({
      user: req.user ? publicUser(req.user) : null,
      billing: { enabled: payments.enabled, priceCents: payments.priceCents, currency: payments.currency },
      push: { publicKey: push.publicKey },
    });
  });

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
    const returnUrl = `${req.protocol}://${req.get('host')}/`;
    res.json(await payments.createCheckout({ userId: req.user.id, returnUrl }));
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
    const messages = await store.listMessages(req.user.id, req.conversation.id, { before });
    const connection = connectionView(await store.getConnection(req.conversation.id), req.user.id);
    res.json({
      conversation: { id: req.conversation.id, partner: { handle: partner.handle, online: hub.isOnline(partner.id) }, connection },
      // Flags are only shown to the sender, to explain why a message was held.
      messages: messages.map(({ senderId, flags, ...m }) => ({ ...m, fromMe: senderId === req.user.id, ...(senderId === req.user.id && m.status === 'held' ? { flags } : {}) })),
    });
  }));

  app.post('/api/conversations/:id/messages', member, messageLimiter, conversation, asyncRoute(async (req, res) => {
    const body = parseMessageBody(req.body.body);
    const { id, partnerId } = req.conversation;
    if (await store.isBlocked(req.user.id, partnerId)) throw httpError(403, "You can't message this person.");
    if ((await store.getUser(partnerId))?.status === 'deleted') throw httpError(403, 'This person has left Kindred.');

    const connected = (await store.getConnection(id))?.status === 'accepted';
    const screen = screenMessage(body, { connected });
    const message = await store.addMessage({
      conversationId: id,
      senderId: req.user.id,
      body,
      status: screen.deliver ? 'delivered' : 'held',
      flags: screen.flags.length ? screen.flags : undefined,
    });
    await store.markRead(req.user.id, id, message.createdAt);
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
      await store.respondToConnect(id, { accept: true, ...reveal });
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
    await store.respondToConnect(id, { accept: false });
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
      store.distinctReporters(partnerId, since),
      store.distinctReporters(partnerId, since, 'minor'),
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
    await store.setUserStatus(user.id, status);
    if (status !== 'active') hub.disconnect(user.id);
    res.json({ ok: true });
  }));

  app.post('/api/conversations/:id/read', member, conversation, asyncRoute(async (req, res) => {
    await store.markRead(req.user.id, req.conversation.id);
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
