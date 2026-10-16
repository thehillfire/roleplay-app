import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Creates a saved story on the server (which also narrates its opening).
export default function Starting({ hero, onReady, onBack }) {
  const [error, setError] = useState('');
  const started = useRef(false);

  const create = () => {
    setError('');
    api.createStory(hero).then((story) => onReady(story.id), (err) => setError(err.message));
  };

  useEffect(() => {
    // StrictMode mounts twice in dev; only create once.
    if (started.current) return;
    started.current = true;
    create();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="screen">
      <button className="back" onClick={onBack}>← Back</button>
      {error ? (
        <div className="card error"><p>{error}</p><button className="btn" onClick={create}>Try again</button></div>
      ) : (
        <p className="loading">{hero.name}'s story begins…</p>
      )}
    </main>
  );
}
