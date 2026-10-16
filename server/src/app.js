const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { createAuth, hashPassword, verifyPassword } = require('./auth');
const { parseCredentials, parseMessageBody, str, badRequest } = require('./validate');
const { screenMessage } = require('./moderation');

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
const publicUser = ({ id, handle, role, status, createdAt }) => ({ id, handle, role, status, createdAt });

function createApp({
  store,
  hub,
  authRateLimit = { max: 10, windowMs: 60000 },
  messageRateLimit = { max: 30, windowMs: 60000 },
  staticDir,
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
    const user = await store.createUser({ email, birthdate, passwordHash: await hashPassword(password) });
    if (!user) throw httpError(409, 'An account with that email already exists.');
    await auth.startSession(req, res, user.id);
    res.status(201).json({ user: publicUser(user) });
  }));

  app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
    const { email, password } = parseCredentials(req.body, { signup: false });
    const found = await store.findUserByEmail(email);
    const ok = await verifyPassword(password, found?.passwordHash);
    if (!found || !ok) throw httpError(401, 'Email or password is incorrect.');
    await auth.startSession(req, res, found.id);
    res.json({ user: publicUser(found) });
  }));

  app.post('/api/auth/logout', asyncRoute(async (req, res) => {
    await auth.endSession(req, res);
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user ? publicUser(req.user) : null });
  });

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
    res.json({
      conversation: { id: req.conversation.id, partner: { handle: partner.handle, online: hub.isOnline(partner.id) } },
      // Flags are only shown to the sender, to explain why a message was held.
      messages: messages.map(({ senderId, flags, ...m }) => ({ ...m, fromMe: senderId === req.user.id, ...(senderId === req.user.id && m.status === 'held' ? { flags } : {}) })),
    });
  }));

  app.post('/api/conversations/:id/messages', member, messageLimiter, conversation, asyncRoute(async (req, res) => {
    const body = parseMessageBody(req.body.body);
    const { id, partnerId } = req.conversation;
    if (await store.isBlocked(req.user.id, partnerId)) throw httpError(403, "You can't message this person.");

    const screen = screenMessage(body);
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
    }
    res.status(201).json({ message: { ...out, fromMe: true, flags }, crisis: screen.crisis, paused: screen.suspend || undefined });
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
    if (status >= 500) console.error(err);
    let message = 'Something went wrong.';
    if (err.type === 'entity.parse.failed') message = 'Request body is not valid JSON.';
    else if (status === 413) message = 'Request is too large.';
    else if (status < 500 && err.expose) message = err.message;
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp, createRateLimiter };
