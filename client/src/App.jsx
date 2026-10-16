import { useEffect, useState } from 'react';
import { loadStories, saveStories } from './storage.js';
import { newStory } from './game.js';
import Home from './screens/Home.jsx';
import Reveal from './screens/Reveal.jsx';
import Imagine from './screens/Imagine.jsx';
import Story from './screens/Story.jsx';

export default function App() {
  const [stories, setStories] = useState(loadStories);
  const [view, setView] = useState({ name: 'home' });

  useEffect(() => saveStories(stories), [stories]);
  useEffect(() => window.scrollTo(0, 0), [view.name]);

  const home = () => setView({ name: 'home' });

  const begin = (hero) => {
    const story = newStory(hero);
    setStories((prev) => [story, ...prev]);
    setView({ name: 'story', id: story.id });
  };

  const updateStory = (id, patch) => {
    setStories((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s)));
  };

  const removeStory = (id) => setStories((prev) => prev.filter((s) => s.id !== id));

  const active = view.name === 'story' ? stories.find((s) => s.id === view.id) : null;
  // A story that no longer exists falls back to the home screen.
  const screen = view.name === 'story' && !active ? 'home' : view.name;

  return (
    <div className="app">
      <div className="sky" aria-hidden="true" />
      {screen === 'home' && (
        <Home
          stories={stories}
          onRoll={() => setView({ name: 'reveal' })}
          onImagine={() => setView({ name: 'imagine' })}
          onOpen={(id) => setView({ name: 'story', id })}
          onDelete={removeStory}
        />
      )}
      {screen === 'reveal' && <Reveal onBegin={begin} onBack={home} />}
      {screen === 'imagine' && <Imagine onBegin={begin} onBack={home} />}
      {screen === 'story' && (
        <Story key={active.id} story={active} onUpdate={(patch) => updateStory(active.id, patch)} onBack={home} />
      )}
    </div>
  );
}
