// Only the most recent turns are sent for guest stories; the server trims further for the prompt.
const HISTORY_SENT = 24;

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const heroPayload = (hero) => {
  const { name, description, rarity, theme, role } = hero;
  return { name, description, rarity, theme, role };
};

export const api = {
  me: () => request('GET', '/api/auth/me').then((d) => d.user),
  signup: (email, password, displayName) => request('POST', '/api/auth/signup', { email, password, displayName }).then((d) => d.user),
  login: (email, password) => request('POST', '/api/auth/login', { email, password }).then((d) => d.user),
  logout: () => request('POST', '/api/auth/logout', {}),

  rollClass: () => request('POST', '/api/class').then((d) => d.class),

  // Guest play: the client keeps the history.
  tellStory: (hero, history, action, state) => request('POST', '/api/story', {
    hero: heroPayload(hero),
    history: history.slice(-HISTORY_SENT),
    state: state || undefined,
    action: action || undefined,
  }),

  // Account play: the server keeps the history.
  listStories: () => request('GET', '/api/stories').then((d) => d.stories),
  getStory: (id) => request('GET', `/api/stories/${encodeURIComponent(id)}`).then((d) => d.story),
  createStory: (hero) => request('POST', '/api/stories', { hero: heroPayload(hero) }).then((d) => d.story),
  takeTurn: (id, action, version) => request('POST', `/api/stories/${encodeURIComponent(id)}/turns`, { action, version }).then((d) => d.story),
  deleteStory: (id) => request('DELETE', `/api/stories/${encodeURIComponent(id)}`),
  importStories: (stories) => request('POST', '/api/stories/import', {
    stories: stories.map((s) => ({ hero: heroPayload(s.hero), history: s.history, choices: s.choices, state: s.state, createdAt: s.createdAt })),
  }),
};
