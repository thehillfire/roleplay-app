import { useEffect, useRef, useState } from 'react';
import { rollClass } from '../api.js';
import { RARITY_COLORS } from '../game.js';
import Rarity from '../components/Rarity.jsx';

export default function Reveal({ onBegin, onBack }) {
  const [hero, setHero] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);

  const roll = async () => {
    setLoading(true);
    setError('');
    try {
      setHero(await rollClass());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // StrictMode mounts twice in dev; only roll once.
    if (started.current) return;
    started.current = true;
    roll();
  }, []);

  return (
    <main className="screen">
      <button className="back" onClick={onBack}>← Back</button>

      {loading && <p className="loading">The threads of fate are spinning…</p>}

      {!loading && error && (
        <div className="card error">
          <p>{error}</p>
          <button className="btn" onClick={roll}>Try again</button>
        </div>
      )}

      {!loading && hero && (
        <article className="card reveal" style={{ '--rarity': RARITY_COLORS[hero.rarity] }}>
          <Rarity rarity={hero.rarity} />
          <h2 className="class-name">{hero.name}</h2>
          <p className="class-desc">{hero.description}</p>
          <p className="class-seed">{hero.theme} · {hero.role}</p>
          <div className="actions">
            <button className="btn primary" onClick={() => onBegin(hero)}>Begin this story</button>
            <button className="btn" onClick={roll}>Roll again</button>
          </div>
        </article>
      )}
    </main>
  );
}
