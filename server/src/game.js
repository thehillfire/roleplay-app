const { RARITIES, THEMES, ROLES } = require('./data/lore');

const RARITY_NAMES = RARITIES.map((r) => r.name);

function pick(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

function rollRarity(rng = Math.random) {
  const total = RARITIES.reduce((sum, r) => sum + r.weight, 0);
  let roll = rng() * total;
  for (const r of RARITIES) {
    roll -= r.weight;
    if (roll < 0) return r.name;
  }
  return RARITIES[RARITIES.length - 1].name;
}

// Rolls the ingredients for a class; the narrator turns them into a name and description.
function rollClassSeed(rng = Math.random) {
  return {
    rarity: rollRarity(rng),
    theme: pick(THEMES, rng),
    role: pick(ROLES, rng),
  };
}

module.exports = { RARITY_NAMES, rollRarity, rollClassSeed };
