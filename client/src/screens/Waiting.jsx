import { useEffect, useState } from 'react';

const LINES = [
  'Finding someone kind…',
  'Take a slow breath while you wait.',
  "Whatever it is, you don't have to carry it alone.",
  'Still looking. Good people are worth the wait.',
];
// A longer breath out than in: the simplest way to settle a racing mind.
const BREATH = [{ label: 'Breathe in', ms: 4000 }, { label: 'Breathe out', ms: 6000 }];
const KEY = 'kindred.breathe';

function readBreathe() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export default function Waiting({ onCancel, error, presence }) {
  const [i, setI] = useState(0);
  const [slow, setSlow] = useState(false);
  const [breathe, setBreathe] = useState(readBreathe);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % LINES.length), 4000);
    const s = setTimeout(() => setSlow(true), 45000);
    return () => { clearInterval(t); clearTimeout(s); };
  }, []);

  useEffect(() => {
    if (!breathe) return undefined;
    const t = setTimeout(() => setPhase((p) => (p + 1) % BREATH.length), BREATH[phase].ms);
    return () => clearTimeout(t);
  }, [breathe, phase]);

  const toggle = () => {
    const next = !breathe;
    setBreathe(next);
    setPhase(0);
    try {
      localStorage.setItem(KEY, next ? '1' : '0');
    } catch {
      // Remembering is a nicety.
    }
  };

  return (
    <main className="screen waiting">
      <h1 className="sr-only">Finding someone to talk to</h1>
      {breathe ? (
        <div className="breath" aria-hidden="true"><span key={`${phase}`} className={phase === 0 ? 'in' : 'out'} /></div>
      ) : (
        <div className="pulse" aria-hidden="true"><span /><span /><span /></div>
      )}
      <p className="loading" role="status">{error || (breathe ? BREATH[phase].label : LINES[i])}</p>
      {breathe && !error && <p className="hint">Still looking for someone. You'll see them the moment they're here.</p>}
      {presence?.online > 1 && <p className="presence"><span className="dot" aria-hidden="true" /> {presence.online} people here now</p>}
      {slow && !error && <p className="hint">It's quiet right now. Choosing <strong>Either</strong> or no topic widens the search.</p>}
      <div className="waiting-actions">
        <button className="link" onClick={toggle} aria-pressed={breathe}>{breathe ? 'Stop breathing exercise' : 'Breathe with me'}</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </main>
  );
}
