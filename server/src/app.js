const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { rollClassSeed } = require('./game');
const { initialState, normalizeState, applyEffects, rollD20 } = require('./rules');
const { createNarrator } = require('./narrator');
const { createAuth, hashPassword, verifyPassword } = require('./auth');
const { parseStoryRequest, parseHero, parseHistory, parseAction, parseCredentials, badRequest } = require('./validate');

const MAX_STORY_TURNS = 400;
const MAX_STORIES_PER_USER = 100;
const MAX_IMPORT = 50;

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
      return res.status(429).json({ error: 'Too many requests. Take a breath and try again shortly.' });
    }
    entry.count += 1;
    return next();
  };
}

const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });

// Runs one narration step: rolls the dice, asks the narrator, enforces the rules.
// Returns the turns to append, the next suggested choices and the new state.
async function narrate(narrator, { hero, history, action, state, rng }) {
  if (state.ended) throw httpError(409, 'This tale has ended. Begin a new one!');
  const roll = action ? rollD20(rng) : undefined;
  const out = await narrator.tell({ hero, history, action, state, roll });
  if (!out.passage) throw httpError(502, 'Narrator returned an empty passage');
  const { state: next, applied } = applyEffects(state, out.effects);
  const narration = { role: 'narrator', text: out.passage };
  if (roll && out.rollUsed) narration.roll = roll;
  if (Object.keys(applied).length) narration.effects = applied;
  const turns = action ? [{ role: 'player', text: action }, narration] : [narration];
  return { turns, choices: next.ended ? [] : out.choices, state: next };
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApp({
  narrator = createNarrator(),
  store,
  rateLimit = { max: 20, windowMs: 60000 },
  authRateLimit = { max: 10, windowMs: 60000 },
  staticDir,
  rng = Math.random,
} = {}) {
  if (!store) throw new Error('createApp requires a store');
  const app = express();
  const auth = createAuth(store);

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      },
    },
  }));
  app.use('/api', express.json({ limit: '256kb' }));

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

  const limiter = createRateLimiter({ ...rateLimit, key: (req) => req.user?.id || req.ip });
  const authLimiter = createRateLimiter(authRateLimit);

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', narrator: narrator.source });
  });

  // --- Accounts ---

  app.post('/api/auth/signup', authLimiter, asyncRoute(async (req, res) => {
    const { email, password, displayName } = parseCredentials(req.body, { signup: true });
    const user = await store.createUser({ email, displayName, passwordHash: await hashPassword(password) });
    if (!user) throw httpError(409, 'An account with that email already exists.');
    await auth.startSession(req, res, user.id);
    res.status(201).json({ user });
  }));

  app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
    const { email, password } = parseCredentials(req.body, { signup: false });
    const found = await store.findUserByEmail(email);
    const ok = await verifyPassword(password, found?.passwordHash);
    if (!found || !ok) throw httpError(401, 'Email or password is incorrect.');
    const { passwordHash, ...user } = found; // eslint-disable-line no-unused-vars
    await auth.startSession(req, res, user.id);
    res.json({ user });
  }));

  app.post('/api/auth/logout', asyncRoute(async (req, res) => {
    await auth.endSession(req, res);
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user });
  });

  // --- Game: available to guests and players ---

  app.post('/api/class', limiter, asyncRoute(async (req, res) => {
    const seed = rollClassSeed();
    const { name, description } = await narrator.describeClass(seed);
    if (!name || !description) throw httpError(502, 'Narrator returned an empty class');
    res.json({ class: { name, description, ...seed }, source: narrator.source });
  }));

  // Stateless turn for guests: the client holds the history and state.
  app.post('/api/story', limiter, asyncRoute(async (req, res) => {
    const input = parseStoryRequest(req.body);
    const state = input.history.length ? normalizeState(req.body.state) : initialState();
    const { turns, choices, state: next } = await narrate(narrator, { ...input, state, rng });
    res.json({ turns, choices, state: next, source: narrator.source });
  }));

  // --- Saved stories: the server owns the history for signed-in players ---

  app.get('/api/stories', auth.requireUser, asyncRoute(async (req, res) => {
    res.json({ stories: await store.listStories(req.user.id) });
  }));

  app.post('/api/stories', auth.requireUser, limiter, asyncRoute(async (req, res) => {
    const hero = parseHero(req.body.hero);
    if (await store.countStories(req.user.id) >= MAX_STORIES_PER_USER) {
      throw httpError(409, `You can keep up to ${MAX_STORIES_PER_USER} stories. Delete one to start another.`);
    }
    const { turns, choices, state } = await narrate(narrator, { hero, history: [], state: initialState(), rng });
    const story = await store.createStory(req.user.id, { hero, history: turns, choices, state });
    res.status(201).json({ story });
  }));

  app.post('/api/stories/import', auth.requireUser, asyncRoute(async (req, res) => {
    const list = req.body.stories;
    if (!Array.isArray(list)) throw badRequest('stories must be an array');
    if (list.length > MAX_IMPORT) throw badRequest(`You can import at most ${MAX_IMPORT} stories at once`);
    const existing = await store.countStories(req.user.id);
    if (existing + list.length > MAX_STORIES_PER_USER) {
      throw httpError(409, `Importing would exceed the ${MAX_STORIES_PER_USER}-story limit.`);
    }
    const parsed = list.map((s) => {
      const history = parseHistory(s?.history, { max: MAX_STORY_TURNS });
      if (history.length === 0) throw badRequest('Each imported story needs at least one turn');
      const choices = Array.isArray(s.choices) ? s.choices.filter((c) => typeof c === 'string').map((c) => c.slice(0, 80)).slice(0, 3) : [];
      const createdAt = Number.isFinite(s.createdAt) && s.createdAt > 0 && s.createdAt <= Date.now() ? s.createdAt : undefined;
      return { hero: parseHero(s.hero), history, choices, state: normalizeState(s.state), createdAt };
    });
    const created = [];
    for (const s of parsed) created.push((await store.createStory(req.user.id, s)).id);
    res.status(201).json({ imported: created.length, ids: created });
  }));

  app.get('/api/stories/:id', auth.requireUser, asyncRoute(async (req, res) => {
    const story = await store.getStory(req.user.id, req.params.id);
    if (!story) throw httpError(404, 'Story not found.');
    res.json({ story });
  }));

  app.post('/api/stories/:id/turns', auth.requireUser, limiter, asyncRoute(async (req, res) => {
    const action = parseAction(req.body.action, { required: true });
    const story = await store.getStory(req.user.id, req.params.id);
    if (!story) throw httpError(404, 'Story not found.');
    if (req.body.version !== undefined && req.body.version !== story.version) {
      throw httpError(409, 'This story moved on in another tab. Reload to continue.');
    }
    if (story.history.length + 2 > MAX_STORY_TURNS) {
      throw httpError(409, 'This story has reached its final page. Start a new tale!');
    }
    const { turns, choices, state } = await narrate(narrator, { hero: story.hero, history: story.history, action, state: story.state, rng });
    const updated = await store.updateStory(req.user.id, story, { history: [...story.history, ...turns], choices, state });
    if (!updated) throw httpError(409, 'This story moved on in another tab. Reload to continue.');
    res.json({ story: updated });
  }));

  app.delete('/api/stories/:id', auth.requireUser, asyncRoute(async (req, res) => {
    if (!(await store.deleteStory(req.user.id, req.params.id))) throw httpError(404, 'Story not found.');
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
    if (status >= 500 && status !== 502) console.error(err);
    let message;
    if (status === 400 && err.type === 'entity.parse.failed') message = 'Request body is not valid JSON.';
    else if (status === 413) message = 'Request is too large.';
    else if (status < 500 && (err.expose || status === 400)) message = err.message;
    else if (status === 429) message = 'The narrator is busy. Try again in a moment.';
    else if (status === 502) message = 'The narrator lost the thread. Try again.';
    else message = 'Something went wrong.';
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp, createRateLimiter, MAX_STORY_TURNS };
