import { useEffect, useState } from 'react';

const LINES = [
  'Finding someone kind…',
  'Take a slow breath while you wait.',
  "Whatever it is, you don't have to carry it alone.",
  'Still looking. Good people are worth the wait.',
];

export default function Waiting({ onCancel, error }) {
  const [i, setI] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % LINES.length), 4000);
    const s = setTimeout(() => setSlow(true), 45000);
    return () => { clearInterval(t); clearTimeout(s); };
  }, []);

  return (
    <main className="screen waiting">
      <h1 className="sr-only">Finding someone to talk to</h1>
      <div className="pulse" aria-hidden="true"><span /><span /><span /></div>
      <p className="loading" role="status">{error || LINES[i]}</p>
      {slow && !error && <p className="hint">It's quiet right now. Choosing <strong>Either</strong> or no topic widens the search.</p>}
      <button className="btn" onClick={onCancel}>Cancel</button>
    </main>
  );
}
