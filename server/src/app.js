const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { createAuth } = require('./auth');
const { createClassifier } = require('./classifier');
const { createPayments } = require('./payments');
const { createPush } = require('./push');
const { createMailer } = require('./mailer');
const { createCaptcha } = require('./captcha');
const { envInt } = require('./env');

const { AUTO_PAUSE, createRateLimiter, httpError, asyncRoute } = require('./routes/common');
const routes = {
  webhook: require('./routes/webhook'),
  auth: require('./routes/auth'),
  account: require('./routes/account'),
  billing: require('./routes/billing'),
  conversations: require('./routes/conversations'),
  admin: require('./routes/admin'),
  bottles: require('./routes/bottles'),
};

function createApp({
  store,
  hub,
  authRateLimit = { max: envInt('AUTH_RATE_LIMIT', 10), windowMs: 60000 },
  messageRateLimit = { max: 30, windowMs: 60000 },
  staticDir,
  log = process.env.NODE_ENV === 'test' || process.env.REQUEST_LOG === 'off' ? null : console,
  payments = createPayments(),
  classifier = createClassifier(),
  autoPauseMinReporterAgeMs = AUTO_PAUSE.minReporterAgeMs,
  push = createPush(),
  mailer = createMailer(),
  captcha = createCaptcha(),
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
  const captchaHosts = captcha.enabled ? ['https://challenges.cloudflare.com'] : [];
  const adHosts = ads ? ['https://pagead2.googlesyndication.com', 'https://*.googlesyndication.com', 'https://*.doubleclick.net', 'https://*.google.com', 'https://*.adtrafficquality.google'] : [];
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        'connect-src': ["'self'", ...adHosts, ...captchaHosts],
        'script-src': ["'self'", ...adHosts, ...captchaHosts],
        'frame-src': ["'self'", ...adHosts, ...captchaHosts],
        'img-src': ["'self'", 'data:', ...adHosts],
      },
    },
  }));
  routes.webhook(app, { store, hub, payments });

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

  const ctx = { store, hub, auth, payments, classifier, push, mailer, captcha, ads, adminEmails, autoPauseMinReporterAgeMs, authLimiter, messageLimiter, member, siteUrl, conversation };
  routes.auth(app, ctx);
  routes.account(app, ctx);
  routes.billing(app, ctx);
  routes.conversations(app, ctx);
  routes.bottles(app, ctx);
  routes.admin(app, ctx);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // In production the built client is served from the same origin.
  if (staticDir) {
    // Social previews need absolute URLs, so the page gets PUBLIC_URL filled in once at startup.
    const indexHtml = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8')
      .replaceAll('__PUBLIC_URL__', (publicUrl || '').replace(/\/$/, ''));
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (req, res) => res.type('html').set('Cache-Control', 'no-cache').send(indexHtml));
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
