// Rarity tiers, ordered lowest to highest, with roll weights (percent).
const RARITIES = [
  { name: 'Common', weight: 45 },
  { name: 'Uncommon', weight: 25 },
  { name: 'Rare', weight: 14 },
  { name: 'Epic', weight: 8 },
  { name: 'Legendary', weight: 4 },
  { name: 'Mythical', weight: 2 },
  { name: 'Celestial', weight: 1.5 },
  { name: 'Eternal', weight: 0.5 },
];

const THEMES = [
  'steel', 'void', 'coral', 'dream', 'bone', 'echo', 'prism', 'rust', 'star', 'moss',
  'crystal', 'shadow', 'flame', 'frost', 'storm', 'earth', 'wind', 'blood', 'spirit', 'light',
  'glass', 'sand', 'smoke', 'mist', 'vine', 'thorn', 'petal', 'root', 'spore', 'honey',
  'silk', 'feather', 'pearl', 'amber', 'fossil', 'lunar', 'solar', 'astral', 'spectral', 'aurora',
  'nebula', 'comet', 'gravity', 'cyber', 'quantum', 'circuit', 'gear', 'plasma', 'photon', 'portal',
  'rift', 'chaos', 'harmony', 'discord', 'hope', 'sorrow', 'courage', 'wisdom', 'thunder', 'tide',
  'fog', 'hurricane', 'avalanche', 'volcano', 'wildfire', 'geyser',
];

const ROLES = [
  'hunter', 'dancer', 'engineer', 'sculptor', 'harvester', 'monk', 'tactician', 'warrior', 'duelist', 'knight',
  'assassin', 'rogue', 'spy', 'scout', 'ranger', 'mage', 'sorcerer', 'warlock', 'witch', 'shaman',
  'druid', 'necromancer', 'summoner', 'enchanter', 'alchemist', 'artificer', 'spellsword', 'oracle', 'healer', 'cleric',
  'paladin', 'guardian', 'warden', 'bard', 'storyteller', 'jester', 'chronicler', 'sage', 'smith', 'architect',
  'jeweler', 'inventor', 'tinker', 'beastmaster', 'rider', 'whisperer', 'pathfinder', 'nomad', 'wanderer', 'scholar',
  'archivist', 'curator', 'scribe', 'translator', 'sailor', 'navigator', 'captain', 'corsair', 'pilot', 'diver',
];

module.exports = { RARITIES, THEMES, ROLES };
