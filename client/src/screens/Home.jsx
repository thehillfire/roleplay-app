import { useState } from 'react';
import HomeAd from '../components/HomeAd.jsx';

const ROLES = [
  { id: 'talk', label: 'I need to talk' },
  { id: 'listen', label: 'I can listen' },
  { id: 'either', label: 'Either' },
];
const TOPICS = ['Money', 'Work', 'Family', 'Relationships', 'Loneliness', 'Health', 'Just vent'];

export function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export default function Home({ user, conversations, listError, onRetry, onFind, onOpen, onAccount, connection, notice, onDismissNotice, onModerate, askPush, onEnablePush, onDismissPush, presence, ads }) {
  const [role, setRole] = useState('talk');
  const [topic, setTopic] = useState('');

  return (
    <main className="screen">
      <nav className="topbar">
        <span className="who">You are <strong>{user.handle}</strong></span>
        <span className="topbar-actions">
          {onModerate && <button className="link" onClick={onModerate}>Moderate</button>}
          <button className="link" onClick={onAccount}>Account</button>
        </span>
      </nav>

      {connection === 'offline' && <p className="banner" role="status">Reconnecting…</p>}

      {user.helped > 0 && (
        <p className="helped">💙 You've helped <strong>{user.helped}</strong> {user.helped === 1 ? 'person' : 'people'} feel a little lighter.</p>
      )}

      {notice && (
        <div className="notice" role="status">
          <p>{notice}</p>
          <button className="icon-btn" aria-label="Dismiss" onClick={onDismissNotice}>×</button>
        </div>
      )}

      <section className="card find">
        <h1 className="find-title">Talk to someone</h1>
        <p className="hint">A random, anonymous match. Stay as long as you like.</p>
        {presence?.online > 1 && <p className="presence"><span className="dot" aria-hidden="true" /> {presence.online} people here now</p>}
        <div className="segmented" role="radiogroup" aria-label="What do you need?">
          {ROLES.map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={role === r.id} className={role === r.id ? 'seg active' : 'seg'} onClick={() => setRole(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="topics" aria-label="Topic (optional)">
          {TOPICS.map((t) => (
            <button key={t} type="button" className={topic === t ? 'chip active' : 'chip'} aria-pressed={topic === t} onClick={() => setTopic(topic === t ? '' : t)}>
              {t}
            </button>
          ))}
        </div>
        <button className="btn primary big" onClick={() => onFind({ role, topic })} disabled={connection !== 'online'}>
          {connection === 'online' ? 'Find someone' : 'Connecting…'}
        </button>
      </section>

      {askPush && (
        <div className="notice push-ask">
          <p>Get a notification when someone replies. It only shows their anonymous name, never what they wrote.</p>
          <button className="btn primary" onClick={onEnablePush}>Turn on</button>
          <button className="icon-btn" aria-label="Not now" onClick={onDismissPush}>×</button>
        </div>
      )}

      {listError && <div className="card error"><p>{listError}</p><button className="btn" onClick={onRetry}>Try again</button></div>}

      {conversations?.length > 0 && (
        <section>
          <h2 className="section-title">Your conversations</h2>
          <ul className="convos">
            {conversations.map((c) => (
              <li key={c.id}>
                <button className="convo" onClick={() => onOpen(c.id)}>
                  <span className="avatar" aria-hidden="true">{c.partner.handle.slice(0, 1)}</span>
                  <span className="convo-main">
                    <span className="convo-top">
                      <span className="convo-name">
                        {c.partner.handle}
                        {c.partner.online && <span className="dot" title="Online" aria-label="online" />}
                      </span>
                      <span className="convo-time">{timeAgo(c.lastMessageAt)}</span>
                    </span>
                    <span className={c.unread ? 'convo-preview unread' : 'convo-preview'}>
                      {c.lastMessage ? `${c.lastMessage.fromMe ? 'You: ' : ''}${c.lastMessage.body}` : 'Say hello'}
                    </span>
                  </span>
                  {c.unread > 0 && <span className="count" aria-label={`${c.unread} unread`}>{c.unread}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <HomeAd ads={ads} />

      {conversations?.length === 0 && <p className="empty">Your conversations will appear here. Past matches stay anonymous, and you can pick up where you left off.</p>}
    </main>
  );
}
