import { useEffect } from 'react';

const DURATION_MS = 1900;

// The full-screen "you're in" for signing in or signing up: lightning, a flash, a slash and your name.
// Decorative and click-through (the screen under it is ready the whole time), like the match splash.
// One flash only, so it stays inside the safe limit for flashing content.
export default function Strike({ name, isNew, onDone }) {
  useEffect(() => {
    const timer = setTimeout(onDone, DURATION_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="strike" aria-hidden="true">
      <div className="strike-flash" />
      <svg className="strike-bolts" viewBox="0 0 100 200" preserveAspectRatio="none" focusable="false">
        <polyline className="b1" points="52,0 44,38 58,58 40,96 56,118 38,160 50,200" />
        <polyline className="b2" points="20,0 29,30 14,54 31,82 17,116" />
        <polyline className="b3" points="82,0 74,26 88,52 70,80 81,108" />
      </svg>
      <div className="strike-slash" />
      <div className="strike-stage">
        <span className="strike-name">{name}</span>
        <span className="strike-title">{isNew ? "You're in" : 'Welcome back'}</span>
      </div>
    </div>
  );
}
