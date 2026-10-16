import { useEffect, useState } from 'react';
import { api } from '../api.js';

const TOPICS = [
  { id: 'account', label: 'My account' },
  { id: 'billing', label: 'Payments' },
  { id: 'safety', label: 'Safety' },
  { id: 'feedback', label: 'Ideas & feedback' },
  { id: 'other', label: 'Something else' },
];

// Write to the team from inside the app. Replies come by email, and show here too.
export default function Support({ emailVerified }) {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState('account');
  const [message, setMessage] = useState('');
  const [requests, setRequests] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    api.support().then(setRequests, () => {});
  }, [sent]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.sendSupport(topic, message);
      setMessage('');
      setOpen(false);
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card support">
      <h2 className="section-title">Contact support</h2>
      {sent && (
        <p className="hint" role="status">
          Thanks, we got it. {emailVerified ? "We'll reply by email." : "We'll reply by email once you confirm your address (see the link on Home)."}
        </p>
      )}
      {open ? (
        <form className="form" onSubmit={submit}>
          <label>
            <span>What's it about?</span>
            <select value={topic} onChange={(e) => setTopic(e.target.value)}>
              {TOPICS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          <label>
            <span>Your message</span>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} rows={4} required />
          </label>
          <p className="hint">For an emergency, call or text 988 (US). We can't respond in real time.</p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy || !message.trim()}>{busy ? 'Sending…' : 'Send'}</button>
          </div>
        </form>
      ) : (
        <button className="btn" onClick={() => { setOpen(true); setSent(false); }}>Write to us</button>
      )}
      {requests.length > 0 && (
        <ul className="support-list">
          {requests.map((r) => (
            <li key={r.id}>
              <span className="support-meta">{TOPICS.find((t) => t.id === r.topic)?.label || r.topic} · {r.status === 'open' ? 'waiting for a reply' : 'answered'}</span>
              <p>{r.message}</p>
              {r.reply && <p className="support-reply"><strong>Kindred:</strong> {r.reply}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
