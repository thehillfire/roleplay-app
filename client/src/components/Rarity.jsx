import { RARITY_COLORS } from '../game.js';

export default function Rarity({ rarity }) {
  if (!rarity) return null;
  return (
    <span className="rarity" style={{ '--rarity': RARITY_COLORS[rarity] || RARITY_COLORS.Common }}>
      {rarity}
    </span>
  );
}
