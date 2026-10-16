import { useEffect, useState } from 'react';

const LINES = [
  'Finding someone kind…',
  'Take a slow breath while you wait.',
  "Whatever it is, you don't have to carry it alone.",
  'Still looking. Good people are worth the wait.',
];

export default function Waiting({ onCancel, error }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % LINES.length), 4000);
    return () => clearInterval(t);
  }, []);

  return (
    <main className="screen waiting">
      <div className="pulse" aria-hidden="true"><span /><span /><span /></div>
      <p className="loading" role="status">{error || LINES[i]}</p>
      <button className="btn" onClick={onCancel}>Cancel</button>
    </main>
  );
}
