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
import { disablePushOnThisDevice, enablePush, pushDismissed, pushSupported, syncPush } from './notifications.js';

function Paused({ onSignOut, onCheck }) {
  const [appeal, setAppeal] = useState(undefined);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api.appeal().then(setAppeal, () => setAppeal(null));
  }, []);
  // No live connection while paused, so look again now and then: a restore opens the app,
  // a decision shows up, without a reload.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      onCheck();
      api.appeal().then(setAppeal, () => {});
    };
    const timer = setInterval(check, 60000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [onCheck]);
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
        <p>A moderator is taking a look at your account. This can follow a report, a message our safety check flagged, or something about the sign-up, such as an age that didn't add up. It isn't a final decision.</p>
        <p className="hint">If you need support right now, call or text <a href="tel:988">988</a> (US) or visit <a href="https://findahelpline.com" target="_blank" rel="noreferrer">findahelpline.com</a>.</p>
      </div>
      {appeal?.status === 'open' && (
        <div className="card">
          <p role="status">Your note was sent {new Date(appeal.createdAt).toLocaleDateString()}. A moderator will read it.</p>
        </div>
      )}
      {appeal?.decision === 'denied' && (
        <div className="card">
          <p role="status">A moderator read your note on {new Date(appeal.decidedAt).toLocaleDateString()} and decided to keep the pause in place for now.</p>
          {appeal.note && <p className="details">“{appeal.note}”</p>}
          {Date.now() < appeal.nextAppealAt && <p className="hint">If something has changed, you can send another note after {new Date(appeal.nextAppealAt).toLocaleDateString()}.</p>}
        </div>
      )}
      {/* A note can be sent unless one is waiting, or a "no" is still inside its week. */}
      {appeal !== undefined && appeal?.status !== 'open' && !(appeal?.decision === 'denied' && Date.now() < appeal.nextAppealAt) && (
        <form className="card form" onSubmit={send}>
          <label>
            <span>Think this was a mistake? Tell the moderators what happened.</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} rows={4} required />
            {text.length > 800 && <small className="hint">{1000 - text.length} characters left</small>}
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn primary" type="submit" disabled={!text.trim()}>Send to moderators</button>
        </form>
      )}
      <button className="btn" onClick={onSignOut}>Sign out</button>
    </main>
  );
}

function Signedin({ user, billing, ads, pushKey, onSignOut, onSignOutEverywhere, onDeleted, onPaused, onRefreshMe, onCheckSession, onOpenLegal, initialNotice, externalNotice }) {
  // A reload mid-chat stays in the chat (the browser keeps history.state across reloads). Opening
  // the site afresh (typing the address, a link) starts at home even if the state survived.
  const restoreChat = () => {
    const nav = performance.getEntriesByType?.('navigation')?.[0]?.type;
    return (nav === 'reload' || nav === 'back_forward') && window.history.state?.view?.name === 'chat';
  };
  const [view, setView] = useState(() => (restoreChat() ? window.history.state.view : { name: 'home' }));

  // Browser history: home is the root entry; other screens are pushed on top so the
  // phone's back button (and swipe back) returns to the previous screen instead of leaving.
  useEffect(() => {
    if (!restoreChat()) window.history.replaceState({ view: { name: 'home' } }, '');
    const onPop = (e) => {
      if (e.state?.legal) return;
      const next = e.state?.view || { name: 'home' };
      // Back/forward into the waiting room would show a search that isn't running: go home.
      if (next.name === 'waiting') {
        window.history.replaceState({ view: { name: 'home' } }, '');
        setView({ name: 'home' });
        return;
      }
      setView(next);
    };
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
  // A note from the moderators (a report was reviewed, or a reminder of the guidelines): show once.
  useEffect(() => {
    if (!user.notice) return;
    setNotice(user.notice);
    api.dismissNotice().catch(() => {});
  }, [user.notice]);
  const [conversations, setConversations] = useState(null);
  const [listError, setListError] = useState('');
  const [connection, setConnection] = useState('connecting');
  const [matchError, setMatchError] = useState('');
  const [socket] = useState(() => createSocket({ onStatus: setConnection }));
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    socket.start();
    return () => socket.close();
  }, [socket]);

  // Live "people here now": fetched when home opens, then kept current by 'presence' pushes.
  const [presence, setPresence] = useState(null);
  useEffect(() => {
    if (view.name === 'home' || view.name === 'waiting') api.presence().then(setPresence, () => {});
  }, [view.name]);

  // Asked once per device: "not now" sticks until they turn it on from Account.
  const [askPush, setAskPush] = useState(() => Boolean(pushKey) && pushSupported() && Notification.permission === 'default' && !pushDismissed());
  const dismissPush = () => {
    try { localStorage.setItem('kd_push_dismissed', '1'); } catch { /* private mode */ }
    setAskPush(false);
  };
  useEffect(() => {
    if (pushKey) syncPush(api.pushSubscribe).catch(() => {});
  }, [pushKey]);
  const turnOnPush = async () => {
    try {
      await enablePush(pushKey, api.pushSubscribe);
    } catch {
      // Permission denied or the browser refused; nothing else to do.
    }
    dismissPush();
  };

  const refresh = useCallback(() => {
    setListError('');
    api.conversations().then(setConversations, (err) => setListError(err.message));
  }, []);

  // The chat needs the list too: its back arrow counts what's unread elsewhere (also after a reload).
  const listKey = view.name === 'chat' ? `chat:${view.id}` : view.name; // chat to chat refetches too
  useEffect(() => {
    if (view.name === 'home' || view.name === 'chat') refresh();
  }, [listKey, refresh]);

  useEffect(() => {
    const offs = [
      // Replace the waiting room in history, so back from the chat goes home.
      socket.on('match.found', ({ conversationId }) => navigate({ name: 'chat', id: conversationId }, { replace: viewRef.current.name === 'waiting' })),
      socket.on('match.error', ({ error }) => setMatchError(error)),
      // New messages anywhere but the open chat update the list (unread counts, ordering), so the
      // title and the chat's back arrow can say something arrived elsewhere.
      socket.on('message', ({ message }) => {
        const v = viewRef.current;
        if (!(v.name === 'chat' && message?.conversationId === v.id)) refresh();
      }),
      socket.on('message.unsent', ({ conversationId }) => {
        const v = viewRef.current;
        if (!(v.name === 'chat' && conversationId === v.id)) refresh();
      }),
      socket.on('open', () => {
        if (viewRef.current.name === 'home' || viewRef.current.name === 'chat') refresh();
        // A dropped connection took us out of the queue: rejoin with the same choice.
        if (viewRef.current.name === 'waiting' && lastFind.current) {
          setMatchError('');
          socket.send({ type: 'match.join', ...lastFind.current });
        }
      }),
      socket.on('close', ({ code, attempt }) => {
        if (viewRef.current.name === 'waiting') setMatchError('Connection lost. Reconnecting…');
        // 4003: the server closed it because the account is unavailable. A refused upgrade (signed out)
        // looks like any other failure, so check after a couple of failed tries too.
        if (code === 4003 || attempt === 2) onCheckSession();
      }),
      socket.on('credits.updated', onRefreshMe),
      socket.on('presence', ({ online, waiting, waitingToTalk }) => setPresence({ online, waiting, waitingToTalk })),
      socket.on('bottle.answered', ({ partner }) => {
        setNotice(`💙 ${partner.handle} picked up your message.`);
        refresh();
      }),
      socket.on('notice.updated', onRefreshMe),
      socket.on('kind_words', () => setNotice('💙 Someone left you a few kind words.')),
      socket.on('thanks', () => {
        setNotice('💙 Someone you talked with said it helped.');
        onRefreshMe();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [socket, refresh, onRefreshMe, onCheckSession, navigate]);

  // Leaving the waiting room any way (cancel, back button) takes you out of the queue.
  const prevView = useRef(view.name);
  useEffect(() => {
    if (prevView.current === 'waiting' && view.name !== 'waiting' && view.name !== 'chat') socket.send({ type: 'match.leave' });
    prevView.current = view.name;
  }, [view.name, socket]);

  useEffect(() => window.scrollTo(0, 0), [view.name]);

  // Unread count in the tab title, e.g. "(2) Kindred", leaving out the chat that's open.
  const openChatId = view.name === 'chat' ? view.id : null;
  const unreadElsewhere = (conversations || []).reduce((n, c) => (c.id === openChatId ? n : n + c.unread), 0);
  useEffect(() => {
    document.title = unreadElsewhere ? `(${unreadElsewhere}) Kindred` : 'Kindred';
    return () => { document.title = 'Kindred'; };
  }, [unreadElsewhere]);

  const [findRole, setFindRole] = useState('talk');
  const lastFind = useRef(null);
  const find = ({ role, topic }) => {
    lastFind.current = { role, topic };
    setMatchError(connection === 'online' ? '' : 'Connecting…');
    setFindRole(role);
    navigate({ name: 'waiting' });
    socket.send({ type: 'match.join', role, topic }); // if offline, the reconnect below re-sends it
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
          onDismissPush={dismissPush}
        />
      )}
      {view.name === 'moderate' && <Moderate onBack={goHome} />}
      {view.name === 'account' && <Account user={user} billing={billing} pushKey={pushKey} onUserChanged={onRefreshMe} onBack={goHome} onSignOut={onSignOut} onSignOutEverywhere={onSignOutEverywhere} onDeleted={onDeleted} onOpenLegal={onOpenLegal} />}
      {view.name === 'waiting' && <Waiting
          onCancel={cancel}
          error={matchError}
          presence={presence}
          canLeaveMessage={findRole !== 'listen'}
          listening={findRole === 'listen'}
          pushKey={pushKey}
          onCall={user.listenerAlerts}
          onWentOnCall={() => {
            onRefreshMe();
            setNotice("You're on call. We'll send a notification when someone is waiting for a listener (at most once every few hours). Turn it off any time in Account.");
            goHome();
          }}
          onLeftMessage={({ crisis }) => {
            setNotice(`Your message is waiting for the next listener. It shows up in your conversations when someone picks it up${pushKey ? ", and you'll get a notification" : ''}.${crisis ? ' If you are in danger right now, call or text 988.' : ''}`);
            goHome();
          }}
        />}
      {view.name === 'chat' && (
        <Chat
          key={view.id}
          id={view.id}
          socket={socket}
          unreadElsewhere={unreadElsewhere}
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
  if (result === 'plus') return 'Welcome to Kindred Plus! Your monthly credits will appear in a moment.';
  return result === 'success'
    ? 'Payment received. Your connect credit will be ready in a moment.'
    : 'Checkout cancelled. Nothing was charged.';
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined while checking the session
  const userRef = useRef(user);
  userRef.current = user;
  const [billing, setBilling] = useState(null);
  const [pushKey, setPushKey] = useState(null);
  const [ads, setAds] = useState(null);
  const [captchaSiteKey, setCaptchaSiteKey] = useState(null);
  const [checkoutNotice] = useState(takeCheckoutNotice);

  const refreshMe = useCallback(() => api.me().then((d) => {
    // Signed in a moment ago and now not: the session ended elsewhere.
    if (!d.user && userRef.current) setWelcomeMode('expired');
    setUser(d.user);
    setBilling(d.billing);
    setPushKey(d.push?.publicKey || null);
    setAds(d.ads || null);
    setCaptchaSiteKey(d.captcha?.siteKey || null);
  }), []);

  const refreshMeQuietly = useCallback(() => { refreshMe().catch(() => {}); }, [refreshMe]);
  // The live connection was refused or keeps failing: find out whether the session or account changed.
  const checkSession = refreshMeQuietly;

  useEffect(() => {
    refreshMe().catch(() => setUser(null));
  }, [refreshMe]);

  // A 401 from any request means this session is gone: show sign-in with a word about why.
  useEffect(() => {
    const onSignedOut = () => {
      if (!userRef.current) return;
      setWelcomeMode('expired');
      setUser(null);
    };
    window.addEventListener('kindred:signed-out', onSignedOut);
    return () => window.removeEventListener('kindred:signed-out', onSignedOut);
  }, []);

  const signOut = async () => {
    await disablePushOnThisDevice(api.pushUnsubscribe).catch(() => {});
    await api.logout().catch(() => {});
    // A fresh page: the next person's Back button can't walk into the previous account's screens.
    window.location.replace('/');
  };

  const signOutEverywhere = async () => {
    await disablePushOnThisDevice(api.pushUnsubscribe).catch(() => {});
    await api.logoutAll().catch(() => {});
    // A fresh page: the next person's Back button can't walk into the previous account's screens.
    window.location.replace('/');
  };

  const deleted = () => {
    // A fresh page: the next person's Back button can't walk into the previous account's screens.
    window.location.replace('/?deleted=1');
  };

  // /privacy and /terms are readable signed in or out. They overlay the app
  // (instead of replacing it) so the live connection and current screen survive.
  const legalFromPath = () => {
    const path = window.location.pathname.replace(/\/$/, '');
    return path === '/privacy' || path === '/terms' ? path.slice(1) : null;
  };
  const [legal, setLegal] = useState(legalFromPath);
  // Reset links look like /reset#<token>; the token stays out of server logs and referrers.
  // Where the signed-out screen starts: after deleting an account, or from a dead reset link.
  const [welcomeMode, setWelcomeMode] = useState(() => {
    if (new URLSearchParams(window.location.search).get('deleted') !== '1') return null;
    window.history.replaceState(null, '', '/');
    return 'deleted';
  });
  const [resetToken, setResetToken] = useState(() => (window.location.pathname === '/reset' ? window.location.hash.slice(1) || '' : null));
  // Email confirmation links look like /verify#<token>.
  const [verifyNotice, setVerifyNotice] = useState('');
  useEffect(() => {
    if (window.location.pathname !== '/verify') return;
    const token = window.location.hash.slice(1);
    window.history.replaceState(null, '', '/');
    api.verify(token).then(
      (d) => {
        setVerifyNotice(d?.moderatorNextStep === 'reset'
          ? 'Email confirmed. To switch on moderator access, sign out and use "Forgot password?" once: it proves the account is yours.'
          : 'Email confirmed. Thank you!');
        refreshMe().catch(() => {});
      },
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
      {resetToken !== null && !legal && (
        <ResetPassword
          token={resetToken}
          onDone={finishReset}
          onRequestNew={() => { window.history.replaceState(null, '', '/'); setResetToken(null); setWelcomeMode('forgot'); }}
        />
      )}
      <div hidden={Boolean(legal) || resetToken !== null}>
      {user === undefined && <main className="screen"><p className="loading">One moment…</p></main>}
      {user === null && <Welcome key={welcomeMode || 'landing'} initialMode={welcomeMode === 'forgot' ? 'forgot' : welcomeMode === 'expired' ? 'login' : null} farewell={welcomeMode === 'deleted'} notice={welcomeMode === 'expired' ? 'You were signed out. Sign in again to carry on.' : ''} onSignedIn={(u) => refreshMe().catch(() => setUser(u))} onOpenLegal={openLegal} captchaSiteKey={captchaSiteKey} />}
      {user && user.status !== 'active' && <Paused onSignOut={signOut} onCheck={refreshMeQuietly} />}
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
          onCheckSession={checkSession}
          onOpenLegal={openLegal}
        />
      )}
      </div>
    </div>
  );
}
