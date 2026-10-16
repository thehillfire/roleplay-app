import { useEffect, useState } from 'react';
import { HYPE_EVENT } from '../hype.js';

const TITLES = { match: 'Matched', connected: 'Connected', thanks: 'You helped' };

// Decorative: the same news is also shown or announced in the screen underneath,
// so the splash stays out of the accessibility tree and never blocks taps.
export default function Hype({ you }) {
  const [shown, setShown] = useState(null);
  useEffect(() => {
    let timer;
    const onHype = (e) => {
      clearTimeout(timer);
      setShown({ ...e.detail, key: Date.now() });
      timer = setTimeout(() => setShown(null), 1700);
    };
    window.addEventListener(HYPE_EVENT, onHype);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(HYPE_EVENT, onHype);
    };
  }, []);
  if (!shown) return null;
  return (
    <div key={shown.key} className={`hype hype-${shown.kind}`} aria-hidden="true">
      <div className="hype-slash" />
      {shown.kind === 'thanks' ? (
        <div className="hype-center">
          <span className="hype-big">+1</span>
          <span className="hype-title">{TITLES.thanks}</span>
        </div>
      ) : (
        <div className="hype-versus">
          <span className="hype-side left">{you}</span>
          <span className="hype-mark">{shown.kind === 'connected' ? '♥' : '⚡'}</span>
          <span className="hype-side right">{shown.them}</span>
          <span className="hype-title">{TITLES[shown.kind]}</span>
        </div>
      )}
    </div>
  );
}
