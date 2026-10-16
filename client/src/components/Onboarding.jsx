import { useState } from 'react';

const KEY = 'kindred.onboarded.v1';

const CARDS = [
  {
    title: 'Talk to someone, anytime',
    body: 'Tap Find someone and get matched with another person who wants to talk or listen. Pick a topic if you like. You can come back to anyone in your list later.',
  },
  {
    title: 'You stay anonymous',
    body: "Everyone only sees a random name like yours. Numbers, emails and socials are held back unless you both choose to connect, and nobody learns who you are unless you agree.",
  },
  {
    title: 'Be kind, get help when you need it',
    body: "Report or block anyone who makes you uncomfortable; moderators review it. If you're ever in danger, call or text 988 (US) or visit findahelpline.com.",
  },
];

export function shouldOnboard() {
  try {
    return !localStorage.getItem(KEY);
  } catch {
    return false; // storage blocked: don't nag on every visit
  }
}

export default function Onboarding({ handle, onDone }) {
  const [i, setI] = useState(0);
  const finish = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // ignore
    }
    onDone();
  };
  const card = CARDS[i];
  const last = i === CARDS.length - 1;
  return (
    <div className="sheet-backdrop onboarding">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="onboard-title" onKeyDown={(e) => e.key === 'Escape' && finish()}>
        <p className="hint">{i === 0 ? `Welcome, ${handle}.` : `${i + 1} of ${CARDS.length}`}</p>
        <h2 id="onboard-title">{card.title}</h2>
        <p className="onboard-body">{card.body}</p>
        <div className="dots" aria-hidden="true">{CARDS.map((c, n) => <span key={c.title} className={n === i ? 'on' : ''} />)}</div>
        <div className="sheet-actions">
          {!last && <button className="btn" onClick={finish}>Skip</button>}
          <button className="btn primary" onClick={() => (last ? finish() : setI(i + 1))} autoFocus>{last ? "Let's go" : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}
