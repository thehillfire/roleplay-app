import { useMemo } from 'react';
import { modeInfo } from '../games.js';
import CringeDeck from '../components/CringeDeck.jsx';
import NoSmile from '../components/NoSmile.jsx';

// A solo round of a game, for when nobody else is looking for it (or just to try it out).
// Nothing is sent or saved, and nobody else sees any of it.
export default function Practice({ mode, onBack }) {
  const seed = useMemo(() => `practice-${Math.random().toString(36).slice(2)}`, []);
  const info = modeInfo(mode);
  return (
    <main className="screen practice">
      <button className="back" onClick={onBack}>← Back</button>
      <h1 className="find-title">Practice: {info.label}</h1>
      <p className="hint">Just you. Nothing here is sent or saved. When you're ready, find someone from the home screen.</p>
      {mode === 'cringe' ? <CringeDeck conversationId={seed} solo /> : <NoSmile conversationId={seed} solo />}
    </main>
  );
}
