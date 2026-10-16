// Game rules the server enforces. The narrator proposes effects; these functions
// clamp and apply them, so the model can't hand out 10,000 HP or invent items to lose.

const MAX_HP = 100;
const MAX_ITEMS = 12;
const MAX_ITEM_LEN = 40;
const MAX_QUEST_LEN = 120;
const MAX_HP_SWING = 25;

function initialState() {
  return { hp: MAX_HP, maxHp: MAX_HP, inventory: [], quest: '', ended: false };
}

const rollD20 = (rng = Math.random) => Math.floor(rng() * 20) + 1;

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const sameItem = (a, b) => a.toLowerCase() === b.toLowerCase();

// Accepts untrusted state (e.g. from a guest client) and returns a valid one.
function normalizeState(input) {
  const base = initialState();
  if (!input || typeof input !== 'object') return base;
  const maxHp = MAX_HP;
  const hp = Number.isInteger(input.hp) ? Math.min(Math.max(input.hp, 0), maxHp) : base.hp;
  const inventory = [];
  for (const item of Array.isArray(input.inventory) ? input.inventory : []) {
    const name = cleanText(item, MAX_ITEM_LEN);
    if (name && !inventory.some((i) => sameItem(i, name)) && inventory.length < MAX_ITEMS) inventory.push(name);
  }
  return { hp, maxHp, inventory, quest: cleanText(input.quest, MAX_QUEST_LEN), ended: hp === 0 || input.ended === true };
}

// Returns the next state plus a record of what actually changed (for display).
function applyEffects(state, effects = {}) {
  const next = { ...state, inventory: [...state.inventory] };
  const applied = {};

  const rawHp = Number(effects.hpChange);
  if (Number.isFinite(rawHp) && rawHp !== 0) {
    const swing = Math.max(-MAX_HP_SWING, Math.min(MAX_HP_SWING, Math.round(rawHp)));
    const hp = Math.max(0, Math.min(next.maxHp, next.hp + swing));
    if (hp !== next.hp) applied.hp = hp - next.hp;
    next.hp = hp;
  }

  const lost = [];
  for (const item of Array.isArray(effects.loseItems) ? effects.loseItems : []) {
    const name = cleanText(item, MAX_ITEM_LEN);
    const idx = next.inventory.findIndex((i) => sameItem(i, name));
    if (name && idx !== -1) lost.push(next.inventory.splice(idx, 1)[0]);
  }
  const gained = [];
  for (const item of Array.isArray(effects.gainItems) ? effects.gainItems : []) {
    const name = cleanText(item, MAX_ITEM_LEN);
    if (name && next.inventory.length < MAX_ITEMS && !next.inventory.some((i) => sameItem(i, name))) {
      next.inventory.push(name);
      gained.push(name);
    }
  }
  if (gained.length) applied.gained = gained;
  if (lost.length) applied.lost = lost;

  const quest = cleanText(effects.quest, MAX_QUEST_LEN);
  if (quest && quest !== next.quest) {
    next.quest = quest;
    applied.quest = quest;
  }

  if (next.hp === 0) {
    next.ended = true;
    applied.ended = true;
  }
  return { state: next, applied };
}

module.exports = { MAX_HP, MAX_ITEMS, initialState, rollD20, normalizeState, applyEffects };
