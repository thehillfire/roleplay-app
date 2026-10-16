import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Your message for the next listener, while nobody has picked it up yet.
export default function WaitingMessage({ refreshKey, onChange = () => {} }) {
  const [bottle, setBottle] = useState(null);
  useEffect(() => {
    api.bottle().then(setBottle, () => {});
  }, [refreshKey]);
  useEffect(() => onChange(Boolean(bottle)), [bottle, onChange]);
  if (!bottle) return null;
  const withdraw = async () => {
    setBottle(null);
    await api.withdrawBottle().catch(() => {});
  };
  return (
    <section className="card waiting-message" aria-labelledby="waiting-message-title">
      <h2 className="section-title" id="waiting-message-title">Waiting for the next listener</h2>
      <blockquote>{bottle.body}</blockquote>
      <p className="hint">It starts a conversation as soon as someone comes to listen. Messages wait up to a day.</p>
      <button className="link" onClick={withdraw}>Withdraw it</button>
    </section>
  );
}
