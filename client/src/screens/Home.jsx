import Rarity from '../components/Rarity.jsx';
import { progress } from '../game.js';

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function Home({ stories, onRoll, onImagine, onOpen, onDelete }) {
  const sorted = [...stories].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <main className="screen">
      <header className="hero">
        <h1>LoreForge</h1>
        <p className="tagline">A realm of infinite, quiet stories</p>
      </header>

      <section className="paths">
        <button className="path" onClick={onRoll}>
          <span className="path-title">Roll a Class</span>
          <span className="path-desc">Let fate weave a hero from theme, role and rarity.</span>
        </button>
        <button className="path" onClick={onImagine}>
          <span className="path-title">Imagine Yourself</span>
          <span className="path-desc">Describe who you are and step into your own tale.</span>
        </button>
      </section>

      {sorted.length > 0 && (
        <section>
          <h2 className="section-title">Your stories</h2>
          <ul className="saved">
            {sorted.map((s) => {
              const p = progress(s.history);
              return (
                <li key={s.id} className="saved-item">
                  <button className="saved-open" onClick={() => onOpen(s.id)}>
                    <span className="saved-name">{s.hero.name} <Rarity rarity={s.hero.rarity} /></span>
                    <span className="saved-meta">Level {p.level} · {p.actions} actions · {timeAgo(s.updatedAt)}</span>
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Delete ${s.hero.name}`}
                    onClick={() => {
                      if (window.confirm(`Let "${s.hero.name}" fade from memory?`)) onDelete(s.id);
                    }}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
