// Only the most recent turns are sent; the server trims further for the prompt.
const HISTORY_SENT = 24;

async function request(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function rollClass() {
  return (await request('/api/class')).class;
}

export async function tellStory(hero, history, action) {
  return request('/api/story', {
    hero: { name: hero.name, description: hero.description, rarity: hero.rarity },
    history: history.slice(-HISTORY_SENT),
    action: action || undefined,
  });
}
