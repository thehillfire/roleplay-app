const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rollClassSeed, RARITY_NAMES } = require('./game');
const { createNarrator } = require('./narrator');

const LIMITS = { name: 60, description: 300, action: 300, turnText: 1200, history: 60 };

function createRateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const t = now();
    const entry = hits.get(key);
    if (!entry || t > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: t + windowMs });
      return next();
    }
    if (entry.count >= max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - t) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Take a breath and try again shortly.' });
    }
    entry.count += 1;
    return next();
  };
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function str(value, field, max, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw badRequest(`${field} is required`);
  if (trimmed.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return trimmed || undefined;
}

function parseStoryRequest(body = {}) {
  const heroIn = body.hero;
  if (!heroIn || typeof heroIn !== 'object') throw badRequest('hero is required');
  const hero = {
    name: str(heroIn.name, 'hero.name', LIMITS.name),
    description: str(heroIn.description, 'hero.description', LIMITS.description, { required: false }),
    rarity: str(heroIn.rarity, 'hero.rarity', 20, { required: false }),
  };
  if (hero.rarity && !RARITY_NAMES.includes(hero.rarity)) throw badRequest('hero.rarity is not a known rarity');

  const historyIn = body.history ?? [];
  if (!Array.isArray(historyIn)) throw badRequest('history must be an array');
  if (historyIn.length > LIMITS.history) throw badRequest(`history must have at most ${LIMITS.history} turns`);
  const history = historyIn.map((turn, i) => {
    if (!turn || (turn.role !== 'player' && turn.role !== 'narrator')) {
      throw badRequest(`history[${i}].role must be "player" or "narrator"`);
    }
    return { role: turn.role, text: str(turn.text, `history[${i}].text`, LIMITS.turnText) };
  });

  const action = str(body.action, 'action', LIMITS.action, { required: false });
  if (history.length > 0 && !action) throw badRequest('action is required to continue a story');
  return { hero, history, action };
}

function createApp({ narrator = createNarrator(), rateLimit = { max: 20, windowMs: 60000 }, staticDir } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: { 'font-src': ["'self'", 'https://fonts.gstatic.com'], 'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"] },
    },
  }));
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  const limiter = createRateLimiter(rateLimit);

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', narrator: narrator.source });
  });

  app.post('/api/class', limiter, async (req, res, next) => {
    try {
      const seed = rollClassSeed();
      const { name, description } = await narrator.describeClass(seed);
      if (!name || !description) throw Object.assign(new Error('Narrator returned an empty class'), { status: 502 });
      res.json({ class: { name, description, ...seed }, source: narrator.source });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/story', limiter, async (req, res, next) => {
    try {
      const input = parseStoryRequest(req.body);
      const { passage, choices } = await narrator.tell(input);
      if (!passage) throw Object.assign(new Error('Narrator returned an empty passage'), { status: 502 });
      res.json({ passage, choices, source: narrator.source });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // In production the built client is served from the same origin.
  if (staticDir) {
    app.use(express.static(staticDir));
    app.get('/{*splat}', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    const message = status === 400 ? err.message
      : status === 429 ? 'The narrator is busy. Try again in a moment.'
      : status === 502 ? 'The narrator lost the thread. Try again.'
      : 'Something went wrong.';
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp, createRateLimiter, parseStoryRequest };
