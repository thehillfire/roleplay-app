export const RARITY_COLORS = {
  Common: '#b0bec5',
  Uncommon: '#81c784',
  Rare: '#64b5f6',
  Epic: '#ba68c8',
  Legendary: '#ffb74d',
  Mythical: '#f48fb1',
  Celestial: '#80deea',
  Eternal: '#fff59d',
};

const XP_PER_ACTION = 10;
const XP_PER_LEVEL = 100;

export function progress(history) {
  const actions = history.filter((t) => t.role === 'player').length;
  const xp = actions * XP_PER_ACTION;
  return { actions, xp, level: Math.floor(xp / XP_PER_LEVEL) + 1, toNext: XP_PER_LEVEL - (xp % XP_PER_LEVEL) };
}

export function newStory(hero) {
  const now = Date.now();
  return { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, hero, history: [], choices: [], createdAt: now, updatedAt: now };
}
