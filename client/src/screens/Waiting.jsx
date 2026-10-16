import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { enablePush, pushBlocked, pushSupported } from '../notifications.js';
import { modeInfo } from '../games.js';

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

const GAME_LINES = ['Looking for a challenger…', 'Warming up your poker face…', 'Someone is about to get cringed at…', 'Still searching. Stretch those cheeks.'];

export default function Waiting({ mode = 'talk', onCancel, error, presence, canLeaveMessage, onLeftMessage, listening, pushKey, onCall, onWentOnCall }) {
  const [i, setI] = useState(0);
  const [slow, setSlow] = useState(false);
  const [offer, setOffer] = useState(false); // "leave a message" after 20s
  const [breathe, setBreathe] = useState(readBreathe);
  const [phase, setPhase] = useState(0);
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const [sending, setSending] = useState(false);

  const [callError, setCallError] = useState('');
  const goOnCall = async () => {
    setCallError('');
    try {
      if (!(await enablePush(pushKey, api.pushSubscribe))) {
        throw new Error(pushBlocked()
          ? 'Notifications are blocked for Kindred. Allow them in your browser\'s site settings, then try again.'
          : 'Allow notifications for Kindred first, then try again.');
      }
      await api.setListenerAlerts(true);
      onWentOnCall();
    } catch (err) {
      setCallError(err.message);
    }
  };

  const leaveMessage = async (e) => {
    e.preventDefault();
    setSending(true);
    setNoteError('');
    try {
      const { crisis } = await api.leaveBottle(note);
      onLeftMessage({ crisis });
    } catch (err) {
      setNoteError(err.message);
      setSending(false);
    }
  };

  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % LINES.length), 4000);
    const s = setTimeout(() => setSlow(true), 45000);
    const o = setTimeout(() => setOffer(true), 20000);
    return () => { clearInterval(t); clearTimeout(s); clearTimeout(o); };
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
      <h1 className="sr-only">{mode === 'talk' ? 'Finding someone to talk to' : `Finding a ${modeInfo(mode).label} match`}</h1>
      {mode !== 'talk' && <p className="banner">{modeInfo(mode).tag}</p>}
      {breathe ? (
        <div className="breath" aria-hidden="true"><span key={`${phase}`} className={phase === 0 ? 'in' : 'out'} /></div>
      ) : (
        <div className="pulse" aria-hidden="true"><span /><span /><span /></div>
      )}
      <p className="loading" role="status">{error || (breathe ? BREATH[phase].label : (mode === 'talk' ? LINES : GAME_LINES)[i % LINES.length])}</p>
      {breathe && !error && <p className="hint">Still looking for someone. You'll see them the moment they're here.</p>}
      {presence?.online > 1 && <p className="presence"><span className="dot" aria-hidden="true" /> {presence.online} people here now</p>}
      {slow && !error && mode !== 'talk' && <p className="hint">Nobody else is playing this one right now. Try another mode, or come back later.</p>}
      {slow && !error && mode === 'talk' && !listening && <p className="hint">It's quiet right now. Choosing <strong>Either</strong> or no topic widens the search.</p>}
      {slow && !error && listening && <p className="hint">It's quiet right now: nobody needs a listener this minute. Thank you for being here.</p>}
      {offer && !error && canLeaveMessage && !writing && (
        <button className="btn" onClick={() => setWriting(true)}>Leave a message for the next listener</button>
      )}
      {offer && !error && listening && !onCall && pushKey && pushSupported() && (
        <div className="on-call-offer">
          <p className="hint">Nobody needs a listener right this minute. We can let you know when someone does, at most once every few hours.</p>
          <button className="btn" onClick={goOnCall}>Notify me when someone needs a listener</button>
          {callError && <p className="form-error" role="alert">{callError}</p>}
        </div>
      )}
      {writing && (
        <form className="card form leave-message" onSubmit={leaveMessage}>
          <label>
            <span>What's on your mind? The next person who comes to listen will start here, and we'll let you know.</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={4} autoFocus />
          </label>
          {noteError && <p className="form-error" role="alert">{noteError}</p>}
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={() => setWriting(false)}>Keep waiting</button>
            <button type="submit" className="btn primary" disabled={sending || !note.trim()}>{sending ? 'Leaving it…' : 'Leave it'}</button>
          </div>
        </form>
      )}
      <div className="waiting-actions">
        <button className="link" onClick={toggle} aria-pressed={breathe}>{breathe ? 'Stop breathing exercise' : 'Breathe with me'}</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </main>
  );
}
