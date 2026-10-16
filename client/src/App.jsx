import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { loadStories, saveStories } from './storage.js';
import { newStory, progress } from './game.js';
import Home from './screens/Home.jsx';
import Reveal from './screens/Reveal.jsx';
import Imagine from './screens/Imagine.jsx';
import Auth from './screens/Auth.jsx';
import Story from './screens/Story.jsx';
import Starting from './screens/Starting.jsx';

const summarize = (s) => ({ id: s.id, hero: s.hero, actions: progress(s.history).actions, ended: !!s.state?.ended, updatedAt: s.updatedAt });

function GuestStory({ story, onUpdate, onBack }) {
  const advance = async (action) => {
    const { turns, choices, state } = await api.tellStory(story.hero, story.history, action, story.state);
    onUpdate({ history: [...story.history, ...turns], choices, state });
  };
  return <Story story={story} advance={advance} onBack={onBack} />;
}

function AccountStory({ id, onBack }) {
  const [story, setStory] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    api.getStory(id).then(setStory, (err) => setError(err.message));
  }, [id]);
  useEffect(load, [load]);

  if (error) {
    return (
      <main className="screen">
        <button className="back" onClick={onBack}>← Stories</button>
        <div className="card error"><p>{error}</p><button className="btn" onClick={load}>Try again</button></div>
      </main>
    );
  }
  if (!story) return <main className="screen"><p className="loading">Opening the book…</p></main>;

  const advance = async (action) => {
    try {
      setStory(await api.takeTurn(story.id, action, story.version));
    } catch (err) {
      // Another tab moved the story on: pick up its version so the next try works.
      if (err.status === 409) api.getStory(story.id).then(setStory, () => {});
      throw err;
    }
  };
  return <Story story={story} advance={advance} onBack={onBack} />;
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined while checking the session
  const [guestStories, setGuestStories] = useState(loadStories);
  const [accountStories, setAccountStories] = useState(null);
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState({ name: 'home' });

  useEffect(() => saveStories(guestStories), [guestStories]);
  useEffect(() => window.scrollTo(0, 0), [view.name]);
  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
  }, []);

  const refreshList = useCallback(() => {
    setListError('');
    api.listStories().then(setAccountStories, (err) => setListError(err.message));
  }, []);

  useEffect(() => {
    if (user && view.name === 'home') refreshList();
  }, [user, view.name, refreshList]);

  const home = () => setView({ name: 'home' });

  const onSignedIn = async (signedIn) => {
    const toImport = guestStories.filter((s) => s.history.length > 0);
    if (toImport.length > 0) {
      try {
        const { imported } = await api.importStories(toImport);
        setGuestStories([]);
        setNotice(`Welcome, ${signedIn.displayName}. ${imported} guest ${imported === 1 ? 'story is' : 'stories are'} now saved to your account.`);
      } catch (err) {
        setNotice(`Signed in, but your guest stories couldn't be moved yet (${err.message}). They're still on this device.`);
      }
    } else {
      setNotice(`Welcome, ${signedIn.displayName}.`);
    }
    setAccountStories(null);
    setUser(signedIn);
    home();
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    setUser(null);
    setAccountStories(null);
    setNotice('');
    home();
  };

  const begin = (hero) => {
    if (user) {
      setView({ name: 'starting', hero });
      return;
    }
    const story = newStory(hero);
    setGuestStories((prev) => [story, ...prev]);
    setView({ name: 'story', id: story.id });
  };

  const removeStory = async (id) => {
    if (!user) {
      setGuestStories((prev) => prev.filter((s) => s.id !== id));
      return;
    }
    try {
      await api.deleteStory(id);
      setAccountStories((prev) => prev?.filter((s) => s.id !== id) ?? prev);
    } catch (err) {
      setNotice(err.message);
    }
  };

  const guestActive = !user && view.name === 'story' ? guestStories.find((s) => s.id === view.id) : null;
  // A guest story that no longer exists falls back to the home screen.
  const screen = view.name === 'story' && !user && !guestActive ? 'home' : view.name;

  if (user === undefined) {
    return <div className="app"><div className="sky" aria-hidden="true" /><main className="screen"><p className="loading">Lighting the lanterns…</p></main></div>;
  }

  return (
    <div className="app">
      <div className="sky" aria-hidden="true" />
      {screen === 'home' && (
        <Home
          user={user}
          stories={user ? accountStories : guestStories.map(summarize)}
          listError={listError}
          onRetryList={refreshList}
          notice={notice}
          onDismissNotice={() => setNotice('')}
          onRoll={() => setView({ name: 'reveal' })}
          onImagine={() => setView({ name: 'imagine' })}
          onOpen={(id) => setView({ name: 'story', id })}
          onDelete={removeStory}
          onSignIn={() => setView({ name: 'auth' })}
          onSignOut={signOut}
        />
      )}
      {screen === 'auth' && <Auth onSignedIn={onSignedIn} onBack={home} guestCount={guestStories.filter((s) => s.history.length > 0).length} />}
      {screen === 'reveal' && <Reveal onBegin={begin} onBack={home} />}
      {screen === 'imagine' && <Imagine onBegin={begin} onBack={home} />}
      {screen === 'starting' && <Starting hero={view.hero} onReady={(id) => setView({ name: 'story', id })} onBack={home} />}
      {screen === 'story' && user && <AccountStory key={view.id} id={view.id} onBack={home} />}
      {screen === 'story' && !user && (
        <GuestStory
          key={guestActive.id}
          story={guestActive}
          onUpdate={(patch) => setGuestStories((prev) => prev.map((s) => (s.id === guestActive.id ? { ...s, ...patch, updatedAt: Date.now() } : s)))}
          onBack={home}
        />
      )}
    </div>
  );
}
