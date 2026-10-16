import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { createSocket } from './socket.js';
import Welcome from './screens/Welcome.jsx';
import Home from './screens/Home.jsx';
import Waiting from './screens/Waiting.jsx';
import Chat from './screens/Chat.jsx';
import Moderate from './screens/Moderate.jsx';
import Account from './screens/Account.jsx';
import Legal from './screens/Legal.jsx';
import ResetPassword from './screens/ResetPassword.jsx';
import { disablePushOnThisDevice, enablePush, pushSupported, syncPush } from './notifications.js';

function Paused({ onSignOut }) {
  const [appeal, setAppeal] = useState(undefined);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api.appeal().then(setAppeal, () => setAppeal(null));
  }, []);
  const send = async (e) => {
    e.preventDefault();
    setError('');
    try {
      setAppeal(await api.sendAppeal(text));
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <main className="screen paused">
      <div className="card">
        <h1 className="find-title">Your account is paused</h1>
        <p>A moderator is taking a look at a recent report or message. This usually happens when something may break the guidelines, for example if it looks like someone under 18 is using Kindred.</p>
        <p className="hint">If you need support right now, call or text <a href="tel:988">988</a> (US) or visit <a href="https://findahelpline.com" target="_blank" rel="noreferrer">findahelpline.com</a>.</p>
      </div>
      {appeal && (
        <div className="card">
          <p role="status">Your note was sent {new Date(appeal.createdAt).toLocaleDateString()}. A moderator will read it.</p>
        </div>
      )}
      {appeal === null && (
        <form className="card form" onSubmit={send}>
          <label>
            <span>Think this was a mistake? Tell the moderators what happened.</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} rows={4} required />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn primary" type="submit" disabled={!text.trim()}>Send to moderators</button>
        </form>
      )}
      <button className="btn" onClick={onSignOut}>Sign out</button>
    </main>
  );
}

function Signedin({ user, billing, ads, pushKey, onSignOut, onSignOutEverywhere, onDeleted, onPaused, onRefreshMe, onOpenLegal, initialNotice, externalNotice }) {
  const [view, setView] = useState({ name: 'home' });

  // Browser history: home is the root entry; other screens are pushed on top so the
  // phone's back button (and swipe back) returns to the previous screen instead of leaving.
  useEffect(() => {
    window.history.replaceState({ view: { name: 'home' } }, '');
    const onPop = (e) => { if (!e.state?.legal) setView(e.state?.view || { name: 'home' }); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next, { replace = false } = {}) => {
    window.history[replace ? 'replaceState' : 'pushState']({ view: next }, '');
    setView(next);
  }, []);
  const goHome = useCallback(() => {
    if (window.history.state?.view && window.history.state.view.name !== 'home') window.history.back();
    else setView({ name: 'home' });
  }, []);
  const [notice, setNotice] = useState(initialNotice || '');
  useEffect(() => {
    if (externalNotice) setNotice(externalNotice);
  }, [externalNotice]);
  const [conversations, setConversations] = useState(null);
  const [listError, setListError] = useState('');
  const [connection, setConnection] = useState('connecting');
  const [matchError, setMatchError] = useState('');
  const [socket] = useState(() => createSocket({ onStatus: setConnection }));
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => () => socket.close(), [socket]);

  // Live "people here now", refreshed while the home screen is visible.
  const [presence, setPresence] = useState(null);
  useEffect(() => {
    if (view.name !== 'home') return undefined;
    const tick = () => api.presence().then(setPresence, () => {});
    tick();
    const t = setInterval(tick, 20000);
    return () => clearInterval(t);
  }, [view.name]);

  const [askPush, setAskPush] = useState(() => Boolean(pushKey) && pushSupported() && Notification.permission === 'default');
  useEffect(() => {
    if (pushKey) syncPush(api.pushSubscribe).catch(() => {});
  }, [pushKey]);
  const turnOnPush = async () => {
    try {
      await enablePush(pushKey, api.pushSubscribe);
    } catch {
      // Permission denied or the browser refused; nothing else to do.
    }
    setAskPush(false);
  };

  const refresh = useCallback(() => {
    setListError('');
    api.conversations().then(setConversations, (err) => setListError(err.message));
  }, []);

  useEffect(() => {
    if (view.name === 'home') refresh();
  }, [view.name, refresh]);

  useEffect(() => {
    const offs = [
      // Replace the waiting room in history, so back from the chat goes home.
      socket.on('match.found', ({ conversationId }) => navigate({ name: 'chat', id: conversationId }, { replace: viewRef.current.name === 'waiting' })),
      socket.on('match.error', ({ error }) => setMatchError(error)),
      // New messages elsewhere update the list (unread counts, ordering).
      socket.on('message', () => { if (viewRef.current.name === 'home') refresh(); }),
      socket.on('open', () => { if (viewRef.current.name === 'home') refresh(); }),
      socket.on('close', () => { if (viewRef.current.name === 'waiting') setMatchError('Connection lost. Reconnecting…'); }),
      socket.on('credits.updated', onRefreshMe),
      socket.on('thanks', ({ from }) => {
        setNotice(`💙 ${from} said talking with you helped.`);
        onRefreshMe();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [socket, refresh, onRefreshMe, navigate]);

  // Leaving the waiting room any way (cancel, back button) takes you out of the queue.
  const prevView = useRef(view.name);
  useEffect(() => {
    if (prevView.current === 'waiting' && view.name !== 'waiting' && view.name !== 'chat') socket.send({ type: 'match.leave' });
    prevView.current = view.name;
  }, [view.name, socket]);

  useEffect(() => window.scrollTo(0, 0), [view.name]);

  // Unread count in the tab title, e.g. "(2) Kindred".
  useEffect(() => {
    const unread = (conversations || []).reduce((n, c) => n + c.unread, 0);
    document.title = unread && view.name === 'home' ? `(${unread}) Kindred` : 'Kindred';
    return () => { document.title = 'Kindred'; };
  }, [conversations, view.name]);

  const find = ({ role, topic }) => {
    setMatchError('');
    navigate({ name: 'waiting' });
    socket.send({ type: 'match.join', role, topic });
  };

  const cancel = goHome;

  return (
    <>
      {view.name === 'home' && (
        <Home
          user={user}
          conversations={conversations}
          listError={listError}
          onRetry={refresh}
          onFind={find}
          onOpen={(id) => navigate({ name: 'chat', id })}
          onAccount={() => navigate({ name: 'account' })}
          connection={connection}
          notice={notice}
          onDismissNotice={() => setNotice('')}
          onModerate={user.role === 'admin' ? () => navigate({ name: 'moderate' }) : undefined}
          presence={presence}
          ads={ads}
          askPush={askPush}
          onEnablePush={turnOnPush}
          onDismissPush={() => setAskPush(false)}
        />
      )}
      {view.name === 'moderate' && <Moderate onBack={goHome} />}
      {view.name === 'account' && <Account user={user} billing={billing} onBack={goHome} onSignOut={onSignOut} onSignOutEverywhere={onSignOutEverywhere} onDeleted={onDeleted} onOpenLegal={onOpenLegal} />}
      {view.name === 'waiting' && <Waiting onCancel={cancel} error={matchError} />}
      {view.name === 'chat' && (
        <Chat
          key={view.id}
          id={view.id}
          socket={socket}
          onBack={goHome}
          onLeft={(text) => {
            // Drop the blocked conversation now rather than flashing it until the list refreshes.
            setConversations((prev) => prev?.filter((c) => c.id !== view.id) ?? prev);
            setNotice(text);
            goHome();
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
  const [pushKey, setPushKey] = useState(null);
  const [ads, setAds] = useState(null);
  const [checkoutNotice] = useState(takeCheckoutNotice);

  const refreshMe = useCallback(() => api.me().then((d) => {
    setUser(d.user);
    setBilling(d.billing);
    setPushKey(d.push?.publicKey || null);
    setAds(d.ads || null);
  }), []);

  const refreshMeQuietly = useCallback(() => { refreshMe().catch(() => {}); }, [refreshMe]);

  useEffect(() => {
    refreshMe().catch(() => setUser(null));
  }, [refreshMe]);

  const signOut = async () => {
    await disablePushOnThisDevice(api.pushUnsubscribe).catch(() => {});
    await api.logout().catch(() => {});
    window.history.replaceState(null, '', '/');
    setUser(null);
  };

  const signOutEverywhere = async () => {
    await disablePushOnThisDevice(api.pushUnsubscribe).catch(() => {});
    await api.logoutAll().catch(() => {});
    window.history.replaceState(null, '', '/');
    setUser(null);
  };

  const deleted = () => {
    window.history.replaceState(null, '', '/');
    setUser(null);
  };

  // /privacy and /terms are readable signed in or out. They overlay the app
  // (instead of replacing it) so the live connection and current screen survive.
  const legalFromPath = () => {
    const path = window.location.pathname.replace(/\/$/, '');
    return path === '/privacy' || path === '/terms' ? path.slice(1) : null;
  };
  const [legal, setLegal] = useState(legalFromPath);
  // Reset links look like /reset#<token>; the token stays out of server logs and referrers.
  const [resetToken, setResetToken] = useState(() => (window.location.pathname === '/reset' ? window.location.hash.slice(1) || '' : null));
  // Email confirmation links look like /verify#<token>.
  const [verifyNotice, setVerifyNotice] = useState('');
  useEffect(() => {
    if (window.location.pathname !== '/verify') return;
    const token = window.location.hash.slice(1);
    window.history.replaceState(null, '', '/');
    api.verify(token).then(
      () => { setVerifyNotice('Email confirmed. Thank you!'); refreshMe().catch(() => {}); },
      (err) => setVerifyNotice(err.message),
    );
  }, [refreshMe]);

  const finishReset = () => {
    window.history.replaceState(null, '', '/');
    setResetToken(null);
    refreshMe().catch(() => setUser(null));
  };
  useEffect(() => {
    const onPop = () => setLegal(legalFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const openLegal = useCallback((doc) => {
    window.history.pushState({ ...window.history.state, legal: doc }, '', `/${doc}`);
    setLegal(doc);
  }, []);
  const closeLegal = () => {
    if (window.history.state?.legal) window.history.back();
    else {
      window.history.replaceState(null, '', '/');
      setLegal(null);
    }
  };

  return (
    <div className="app">
      <div className="sky" aria-hidden="true" />
      {legal && <Legal doc={legal} onBack={closeLegal} />}
      {resetToken !== null && !legal && <ResetPassword token={resetToken} onDone={finishReset} />}
      <div hidden={Boolean(legal) || resetToken !== null}>
      {user === undefined && <main className="screen"><p className="loading">One moment…</p></main>}
      {user === null && <Welcome onSignedIn={(u) => refreshMe().catch(() => setUser(u))} onOpenLegal={openLegal} />}
      {user && user.status !== 'active' && <Paused onSignOut={signOut} />}
      {user && user.status === 'active' && (
        <Signedin
          key={user.id}
          user={user}
          billing={billing}
          ads={ads}
          pushKey={pushKey}
          initialNotice={checkoutNotice}
          externalNotice={verifyNotice}
          onSignOut={signOut}
          onSignOutEverywhere={signOutEverywhere}
          onDeleted={deleted}
          onPaused={() => setUser({ ...user, status: 'review' })}
          onRefreshMe={refreshMeQuietly}
          onOpenLegal={openLegal}
        />
      )}
      </div>
    </div>
  );
}
