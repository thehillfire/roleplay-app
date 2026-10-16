import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { createSocket } from './socket.js';
import Welcome from './screens/Welcome.jsx';
import Home from './screens/Home.jsx';
import Waiting from './screens/Waiting.jsx';
import Chat from './screens/Chat.jsx';

function Signedin({ user, onSignOut }) {
  const [view, setView] = useState({ name: 'home' });
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
    ];
    return () => offs.forEach((off) => off());
  }, [socket, refresh]);

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
        />
      )}
      {view.name === 'waiting' && <Waiting onCancel={cancel} error={matchError} />}
      {view.name === 'chat' && <Chat key={view.id} id={view.id} socket={socket} onBack={() => setView({ name: 'home' })} />}
    </>
  );
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined while checking the session

  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
  }, []);

  const signOut = async () => {
    await api.logout().catch(() => {});
    setUser(null);
  };

  return (
    <div className="app">
      <div className="sky" aria-hidden="true" />
      {user === undefined && <main className="screen"><p className="loading">One moment…</p></main>}
      {user === null && <Welcome onSignedIn={setUser} />}
      {user && <Signedin key={user.id} user={user} onSignOut={signOut} />}
    </div>
  );
}
