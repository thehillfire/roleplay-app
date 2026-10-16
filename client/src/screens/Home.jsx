import Rarity from '../components/Rarity.jsx';
import { progressFromActions } from '../game.js';

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function Home({
  user, stories, listError, onRetryList, notice, onDismissNotice,
  onRoll, onImagine, onOpen, onDelete, onSignIn, onSignOut,
}) {
  return (
    <main className="screen">
      <nav className="topbar">
        {user ? (
          <>
            <span className="who">{user.displayName}</span>
            <button className="link" onClick={onSignOut}>Sign out</button>
          </>
        ) : (
          <button className="link" onClick={onSignIn}>Sign in to save stories</button>
        )}
      </nav>

      <header className="hero">
        <h1>LoreForge</h1>
        <p className="tagline">A realm of infinite, quiet stories</p>
      </header>

      {notice && (
        <div className="notice" role="status">
          <p>{notice}</p>
          <button className="icon-btn" aria-label="Dismiss" onClick={onDismissNotice}>×</button>
        </div>
      )}

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

      {listError && (
        <div className="card error"><p>{listError}</p><button className="btn" onClick={onRetryList}>Try again</button></div>
      )}

      {user && !stories && !listError && <p className="loading">Gathering your stories…</p>}

      {stories?.length > 0 && (
        <section>
          <h2 className="section-title">{user ? 'Your stories' : 'Stories on this device'}</h2>
          <ul className="saved">
            {stories.map((s) => (
              <li key={s.id} className="saved-item">
                <button className="saved-open" onClick={() => onOpen(s.id)}>
                  <span className="saved-name">{s.hero.name} <Rarity rarity={s.hero.rarity} /></span>
                  <span className="saved-meta">
                    Level {progressFromActions(s.actions).level} · {s.actions} {s.actions === 1 ? 'action' : 'actions'} · {timeAgo(s.updatedAt)}
                  </span>
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
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
