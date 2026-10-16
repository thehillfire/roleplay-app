import { useEffect, useRef, useState } from 'react';
import { progress } from '../game.js';
import Rarity from '../components/Rarity.jsx';

// Renders a story and its composer. `advance(action?)` narrates the next turn
// (no action = opening) and throws on failure; the parent owns the story data.
export default function Story({ story, advance, onBack }) {
  const { hero, history, choices } = story;
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(null); // the action being narrated, if any
  const [error, setError] = useState('');
  const opened = useRef(false);
  const p = progress(history);

  const run = async (action) => {
    setPending(action ?? '');
    setError('');
    try {
      await advance(action);
      setDraft('');
    } catch (err) {
      setError(err.message);
      if (action) setDraft(action); // keep what they wrote so they can retry
    } finally {
      setPending(null);
    }
  };

  useEffect(() => {
    if (history.length === 0 && !opened.current) {
      opened.current = true;
      run();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Scroll to the page bottom so the sticky composer sits below the newest passage, not over it.
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }, [history.length, pending, error]);

  const busy = pending !== null;
  const submit = (e) => {
    e.preventDefault();
    const action = draft.trim();
    if (action && !busy) run(action);
  };

  return (
    <main className="screen story">
      <header className="story-head">
        <button className="back" onClick={onBack}>← Stories</button>
        <div className="story-hero">
          <h2>{hero.name} <Rarity rarity={hero.rarity} /></h2>
          {hero.description && <p>{hero.description}</p>}
        </div>
        <dl className="stats">
          <div><dt>Level</dt><dd>{p.level}</dd></div>
          <div><dt>XP</dt><dd>{p.xp}</dd></div>
          <div><dt>Actions</dt><dd>{p.actions}</dd></div>
        </dl>
      </header>

      <div className="log" aria-live="polite">
        {history.map((turn, i) => (
          <p key={i} className={turn.role === 'player' ? 'turn player' : 'turn narrator'}>{turn.text}</p>
        ))}
        {busy && pending && <p className="turn player">{pending}</p>}
        {busy && <p className="loading">The story unfolds…</p>}
        {error && (
          <div className="card error" role="alert">
            <p>{error}</p>
            {history.length === 0 && <button className="btn" onClick={() => run()}>Try again</button>}
          </div>
        )}
      </div>

      {history.length > 0 && (
        <div className="composer">
          {choices.length > 0 && (
            <div className="choices">
              {choices.map((c) => (
                <button key={c} className="chip" disabled={busy} onClick={() => run(c)}>{c}</button>
              ))}
            </div>
          )}
          <form className="action-row" onSubmit={submit}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={300}
              placeholder="What do you do?"
              disabled={busy}
              aria-label="Your action"
            />
            <button className="btn primary" type="submit" disabled={busy || !draft.trim()}>Act</button>
          </form>
        </div>
      )}
    </main>
  );
}
