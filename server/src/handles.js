// Anonymous handles like "QuietHeron42": friendly, unguessable, never tied to a real name.
const ADJECTIVES = [
  'Quiet', 'Gentle', 'Brave', 'Calm', 'Kind', 'Bright', 'Steady', 'Warm', 'Soft', 'Hopeful',
  'Patient', 'Curious', 'Golden', 'Silver', 'Misty', 'Sunny', 'Velvet', 'Amber', 'Cozy', 'Wild',
  'Humble', 'Lucky', 'Mellow', 'Nimble', 'Quick', 'Rustic', 'Sage', 'Tender', 'Wise', 'Dreamy',
];
const NOUNS = [
  'Heron', 'Fox', 'Otter', 'Willow', 'River', 'Comet', 'Maple', 'Sparrow', 'Lantern', 'Harbor',
  'Meadow', 'Pine', 'Owl', 'Finch', 'Cedar', 'Brook', 'Ember', 'Moth', 'Pebble', 'Wren',
  'Badger', 'Clover', 'Dune', 'Fern', 'Lark', 'Moss', 'Panda', 'Robin', 'Tide', 'Juniper',
];

function randomHandle(rng = Math.random) {
  const pick = (list) => list[Math.floor(rng() * list.length)];
  return `${pick(ADJECTIVES)}${pick(NOUNS)}${Math.floor(rng() * 90) + 10}`;
}

module.exports = { randomHandle };
