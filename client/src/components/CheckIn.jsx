import { useEffect, useState } from 'react';
import { api } from '../api.js';

export const MOODS = [
  [1, '😞', 'Rough'],
  [2, '😕', 'Low'],
  [3, '😐', 'Okay'],
  [4, '🙂', 'Good'],
  [5, '😄', 'Great'],
];

// The person's own calendar date, so "today" means their today.
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Private daily mood check-in. Only you ever see it.
export default function CheckIn({ onWantToTalk }) {
  const [checkins, setCheckins] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.checkins().then(setCheckins, () => setCheckins([]));
  }, []);

  if (!checkins) return null;
  const today = checkins.find((c) => c.day === localDay());

  const choose = async (mood) => {
    setError('');
    try {
      setCheckins(await api.checkin(localDay(), mood));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="card checkin" aria-labelledby="checkin-title">
      <div className="checkin-head">
        <h2 id="checkin-title">{today ? `Today: ${MOODS[today.mood - 1][2].toLowerCase()}` : 'How are you feeling today?'}</h2>
        <span className="hint">Only you see this</span>
      </div>
      <div className="moods" role="radiogroup" aria-label="Today's mood">
        {MOODS.map(([value, emoji, label]) => (
          <button key={value} role="radio" aria-checked={today?.mood === value} aria-label={label} className={today?.mood === value ? 'mood on' : 'mood'} onClick={() => choose(value)}>
            <span aria-hidden="true">{emoji}</span>
          </button>
        ))}
      </div>
      {checkins.length > 1 && (
        <ol className="mood-strip" aria-label="Your last two weeks">
          {checkins.map((c) => (
            <li key={c.day} title={`${c.day}: ${MOODS[c.mood - 1][2]}`} style={{ '--h': `${c.mood * 20}%` }}>
              <span className="sr-only">{c.day}: {MOODS[c.mood - 1][2]}</span>
            </li>
          ))}
        </ol>
      )}
      {today && today.mood <= 2 && (
        <p className="checkin-nudge">
          Sorry today's hard. <button className="link" onClick={onWantToTalk}>Talk to someone now</button>. A listener is a tap away.
        </p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
