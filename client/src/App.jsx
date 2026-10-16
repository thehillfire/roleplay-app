import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { createSocket } from './socket.js';
import Welcome from './screens/Welcome.jsx';
import Home from './screens/Home.jsx';
import Waiting from './screens/Waiting.jsx';
import Chat from './screens/Chat.jsx';
import Moderate from './screens/Moderate.jsx';

function Paused({ onSignOut }) {
  return (
    <main className="screen paused">
      <div className="card">
        <h1 className="find-title">Your account is paused</h1>
        <p>A moderator is taking a look at a recent report or message. This usually happens when something may break the guidelines, for example if it looks like someone under 18 is using Kindred.</p>
        <p className="hint">If you need support right now, call or text <a href="tel:988">988</a> (US) or visit <a href="https://findahelpline.com" target="_blank" rel="noreferrer">findahelpline.com</a>.</p>
      </div>
      <button className="btn" onClick={onSignOut}>Sign out</button>
    </main>
  );
}

function Signedin({ user, billing, onSignOut, onPaused, onRefreshMe, initialNotice }) {
  const [view, setView] = useState({ name: 'home' });
  const [notice, setNotice] = useState(initialNotice || '');
  const [conversations, setConversations] = useState(null);
  const [listError, setListError] = useState('');
  const [connection, setConnection] = useState('connecting');
  const [matchError, setMatchError] = useState('');
  const [socket] = useState(() => createSocket({ onStatus: setConnection }));
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => () => socket.close(), [socket]);

  const refresh = useCallback(() => {
    setListError('');
    api.conversations().then(setConversations, (err) => setListError(err.message));
  }, []);

  useEffect(() => {
    if (view.name === 'home') refresh();
  }, [view.name, refresh]);

  useEffect(() => {
    const offs = [
      socket.on('match.found', ({ conversationId }) => setView({ name: 'chat', id: conversationId })),
      socket.on('match.error', ({ error }) => setMatchError(error)),
      // New messages elsewhere update the list (unread counts, ordering).
      socket.on('message', () => { if (viewRef.current.name === 'home') refresh(); }),
      socket.on('open', () => { if (viewRef.current.name === 'home') refresh(); }),
      socket.on('close', () => { if (viewRef.current.name === 'waiting') setMatchError('Connection lost. Reconnecting…'); }),
      socket.on('credits.updated', onRefreshMe),
    ];
    return () => offs.forEach((off) => off());
  }, [socket, refresh, onRefreshMe]);

  useEffect(() => window.scrollTo(0, 0), [view.name]);

  const find = ({ role, topic }) => {
    setMatchError('');
    setView({ name: 'waiting' });
    socket.send({ type: 'match.join', role, topic });
  };

  const cancel = () => {
    socket.send({ type: 'match.leave' });
    setView({ name: 'home' });
  };

  return (
    <>
      {view.name === 'home' && (
        <Home
          user={user}
          conversations={conversations}
          listError={listError}
          onRetry={refresh}
          onFind={find}
          onOpen={(id) => setView({ name: 'chat', id })}
          onSignOut={onSignOut}
          connection={connection}
          notice={notice}
          onDismissNotice={() => setNotice('')}
          onModerate={user.role === 'admin' ? () => setView({ name: 'moderate' }) : undefined}
        />
      )}
      {view.name === 'moderate' && <Moderate onBack={() => setView({ name: 'home' })} />}
      {view.name === 'waiting' && <Waiting onCancel={cancel} error={matchError} />}
      {view.name === 'chat' && (
        <Chat
          key={view.id}
          id={view.id}
          socket={socket}
          onBack={() => setView({ name: 'home' })}
          onLeft={(text) => {
            // Drop the blocked conversation now rather than flashing it until the list refreshes.
            setConversations((prev) => prev?.filter((c) => c.id !== view.id) ?? prev);
            setNotice(text);
            setView({ name: 'home' });
          }}
          onPaused={onPaused}
          billing={billing}
          credits={user.connectCredits}
          onCreditsChanged={onRefreshMe}
        />
      )}
    </>
  );
}

// Returning from Stripe Checkout lands on /?checkout=success|cancelled.
function takeCheckoutNotice() {
  const result = new URLSearchParams(window.location.search).get('checkout');
  if (!result) return '';
  window.history.replaceState(null, '', window.location.pathname);
  return result === 'success'
    ? 'Payment received. Your connect credit will be ready in a moment.'
    : 'Checkout cancelled. Nothing was charged.';
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined while checking the session
  const [billing, setBilling] = useState(null);
  const [checkoutNotice] = useState(takeCheckoutNotice);

  const refreshMe = useCallback(() => api.me().then((d) => {
    setUser(d.user);
    setBilling(d.billing);
  }), []);

  const refreshMeQuietly = useCallback(() => { refreshMe().catch(() => {}); }, [refreshMe]);

  useEffect(() => {
    refreshMe().catch(() => setUser(null));
  }, [refreshMe]);

  const signOut = async () => {
    await api.logout().catch(() => {});
    setUser(null);
  };

  return (
    <div className="app">
      <div className="sky" aria-hidden="true" />
      {user === undefined && <main className="screen"><p className="loading">One moment…</p></main>}
      {user === null && <Welcome onSignedIn={setUser} />}
      {user && user.status !== 'active' && <Paused onSignOut={signOut} />}
      {user && user.status === 'active' && (
        <Signedin
          key={user.id}
          user={user}
          billing={billing}
          initialNotice={checkoutNotice}
          onSignOut={signOut}
          onPaused={() => setUser({ ...user, status: 'review' })}
          onRefreshMe={refreshMeQuietly}
        />
      )}
    </div>
  );
}
