const { RARITY_NAMES } = require('./game');

const LIMITS = { name: 60, description: 300, action: 300, turnText: 1200, history: 60, seed: 40 };

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
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

function parseHero(heroIn) {
  if (!heroIn || typeof heroIn !== 'object') throw badRequest('hero is required');
  const hero = {
    name: str(heroIn.name, 'hero.name', LIMITS.name),
    description: str(heroIn.description, 'hero.description', LIMITS.description, { required: false }),
    rarity: str(heroIn.rarity, 'hero.rarity', 20, { required: false }),
    theme: str(heroIn.theme, 'hero.theme', LIMITS.seed, { required: false }),
    role: str(heroIn.role, 'hero.role', LIMITS.seed, { required: false }),
  };
  if (hero.rarity && !RARITY_NAMES.includes(hero.rarity)) throw badRequest('hero.rarity is not a known rarity');
  // Drop unset fields so stored heroes stay compact.
  return Object.fromEntries(Object.entries(hero).filter(([, v]) => v !== undefined));
}

function parseHistory(historyIn, { max = LIMITS.history } = {}) {
  const history = historyIn ?? [];
  if (!Array.isArray(history)) throw badRequest('history must be an array');
  if (history.length > max) throw badRequest(`history must have at most ${max} turns`);
  return history.map((turn, i) => {
    if (!turn || (turn.role !== 'player' && turn.role !== 'narrator')) {
      throw badRequest(`history[${i}].role must be "player" or "narrator"`);
    }
    return { role: turn.role, text: str(turn.text, `history[${i}].text`, LIMITS.turnText) };
  });
}

function parseAction(value, { required }) {
  return str(value, 'action', LIMITS.action, { required });
}

function parseStoryRequest(body = {}) {
  const hero = parseHero(body.hero);
  const history = parseHistory(body.history);
  const action = parseAction(body.action, { required: false });
  if (history.length > 0 && !action) throw badRequest('action is required to continue a story');
  return { hero, history, action };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseCredentials(body = {}, { signup }) {
  const email = str(body.email, 'email', 254)?.toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest('Enter a valid email address');
  if (typeof body.password !== 'string' || body.password.length < (signup ? 8 : 1)) {
    throw badRequest(signup ? 'Password must be at least 8 characters' : 'password is required');
  }
  if (body.password.length > 200) throw badRequest('Password must be at most 200 characters');
  const out = { email, password: body.password };
  if (signup) out.displayName = str(body.displayName, 'displayName', 40);
  return out;
}

module.exports = { LIMITS, badRequest, str, parseHero, parseHistory, parseAction, parseStoryRequest, parseCredentials };
