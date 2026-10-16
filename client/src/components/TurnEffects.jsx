// Small badges under a narrator passage: the dice roll and what changed.
export default function TurnEffects({ turn }) {
  const { roll, effects = {} } = turn;
  const badges = [];
  if (roll) {
    const tone = roll >= 15 ? 'good' : roll <= 5 ? 'bad' : 'mid';
    badges.push(<span key="roll" className={`badge roll ${tone}`} title="Luck roll (d20)">d20 · {roll}</span>);
  }
  if (effects.hp) {
    badges.push(<span key="hp" className={`badge ${effects.hp > 0 ? 'good' : 'bad'}`}>{effects.hp > 0 ? '+' : '−'}{Math.abs(effects.hp)} HP</span>);
  }
  for (const item of effects.gained || []) badges.push(<span key={`g-${item}`} className="badge good">+ {item}</span>);
  for (const item of effects.lost || []) badges.push(<span key={`l-${item}`} className="badge bad">− {item}</span>);
  if (effects.quest) badges.push(<span key="quest" className="badge quest">New quest: {effects.quest}</span>);
  if (!badges.length) return null;
  return <div className="badges">{badges}</div>;
}
