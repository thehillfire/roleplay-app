import { useEffect, useRef, useState } from 'react';
import { progress } from '../game.js';
import Rarity from '../components/Rarity.jsx';
import TurnEffects from '../components/TurnEffects.jsx';

// Renders a story and its composer. `advance(action?)` narrates the next turn
// (no action = opening) and throws on failure; the parent owns the story data.
export default function Story({ story, advance, onBack }) {
  const { hero, history, choices } = story;
  const state = story.state;
  const ended = !!state?.ended;
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
        {state && (
          <div className="vitals">
            <div className="hp" role="meter" aria-label="Health" aria-valuemin={0} aria-valuemax={state.maxHp} aria-valuenow={state.hp}>
              <div className="hp-fill" style={{ width: `${(state.hp / state.maxHp) * 100}%` }} data-low={state.hp <= 30 || undefined} />
              <span className="hp-label">HP {state.hp} / {state.maxHp}</span>
            </div>
            <span className="level">Level {p.level} <small>· {p.toNext} XP to next</small></span>
          </div>
        )}
        {state?.quest && <p className="quest"><span>Quest</span> {state.quest}</p>}
        {state?.inventory.length > 0 && (
          <details className="satchel">
            <summary>Satchel ({state.inventory.length})</summary>
            <ul>{state.inventory.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>
        )}
      </header>

      <div className="log" aria-live="polite">
        {history.map((turn, i) => (turn.role === 'player'
          ? <p key={i} className="turn player">{turn.text}</p>
          : (
            <div key={i} className="turn narrator">
              <p>{turn.text}</p>
              <TurnEffects turn={turn} />
            </div>
          )))}
        {busy && pending && <p className="turn player">{pending}</p>}
        {busy && <p className="loading">The story unfolds…</p>}
        {error && (
          <div className="card error" role="alert">
            <p>{error}</p>
            {history.length === 0 && <button className="btn" onClick={() => run()}>Try again</button>}
          </div>
        )}
      </div>

      {ended && (
        <div className="card ending">
          <h3>The tale ends here.</h3>
          <p>{hero.name}'s story is written. Every ending is the seed of another beginning.</p>
          <button className="btn primary" onClick={onBack}>Begin a new tale</button>
        </div>
      )}

      {history.length > 0 && !ended && (
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
