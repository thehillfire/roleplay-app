import { useEffect, useMemo, useState } from 'react';
import { deckFor } from '../games.js';

const key = (id) => `kindred.cringe.${id}`;
const readCard = (id) => { try { return Number(localStorage.getItem(key(id))) || 0; } catch { return 0; } };
const saveCard = (id, n) => { try { localStorage.setItem(key(id), String(n)); } catch { /* private mode */ } };

// Cringe Duel: both players see the same scenario; either one deals the next card for both.
export default function CringeDeck({ conversationId, socket }) {
  const deck = useMemo(() => deckFor(conversationId), [conversationId]);
  const [card, setCard] = useState(() => readCard(conversationId) % deck.length);

  useEffect(() => socket.on('game', (e) => {
    if (e.conversationId !== conversationId || e.kind !== 'card' || !Number.isInteger(e.card)) return;
    const n = e.card % deck.length;
    setCard(n);
    saveCard(conversationId, n);
  }), [socket, conversationId, deck.length]);

  const next = () => {
    const n = (card + 1) % deck.length;
    setCard(n);
    saveCard(conversationId, n);
    socket.send({ type: 'game', conversationId, kind: 'card', card: n });
  };

  return (
    <section className="game-panel cringe" aria-label="Cringe Duel">
      <header>
        <span className="game-tag">#cringeduel</span>
        <span className="game-count">Card {card + 1}/{deck.length}</span>
      </header>
      <p className="game-card" aria-live="polite">{deck[card]}</p>
      <div className="game-actions">
        <p className="hint">Play it out in the chat. Funny, not mean.</p>
        <button className="btn" onClick={next}>Next card</button>
      </div>
    </section>
  );
}
