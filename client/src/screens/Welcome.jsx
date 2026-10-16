import { useCallback, useState } from 'react';
import { api } from '../api.js';
import Turnstile from '../components/Turnstile.jsx';

const GUIDELINES = [
  'Be kind. People come here when things are hard.',
  "Stay anonymous. Don't ask for or share names, numbers, socials or locations.",
  "Adults only. Never ask someone's age or talk to anyone under 18.",
  'No harassment, hate, or sexual content.',
  'If someone is in danger, point them to real help (call or text 988 in the US).',
];

export default function Welcome({ onSignedIn, onOpenLegal, captchaSiteKey, initialMode = null, farewell = false }) {
  const [mode, setMode] = useState(initialMode); // null | 'signup' | 'login' | 'forgot'
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [birthdate, setBirthdate] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaRound, setCaptchaRound] = useState(0);
  const onCaptchaToken = useCallback((t) => setCaptchaToken(t), []);
  const signup = mode === 'signup';

  const sendReset = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.forgot(email);
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'forgot') {
    return (
      <main className="screen">
        <button className="back" onClick={() => { setMode('login'); setSent(false); setError(''); }}>← Back</button>
        <form className="card form" onSubmit={sendReset}>
          <h1 className="find-title">Reset password</h1>
          {sent ? (
            <p role="status">If an account uses <strong>{email}</strong>, a reset link is on its way. It works once, for one hour.</p>
          ) : (
            <>
              <p className="hint">Enter the email you signed up with and we'll send you a link.</p>
              <label>
                <span>Email</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
              </label>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
            </>
          )}
        </form>
      </main>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = signup ? await api.signup({ email, password, birthdate, agree, captchaToken: captchaToken || undefined }) : await api.login(email, password);
      onSignedIn(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
      if (signup && captchaSiteKey) setCaptchaRound((n) => n + 1); // tokens are single-use
    }
  };

  if (!mode) {
    return (
      <main className="screen welcome">
        {farewell && <p className="notice" role="status">Your account was deleted. Take care of yourself, and you're welcome back any time.</p>}
        <header className="hero">
          <h1>Kindred</h1>
          <p className="tagline">Talk to someone. Nobody has to know.</p>
        </header>
        <div className="card pitch">
          <p>Rough day? Money tight, work heavy, something you can't tell the people around you?</p>
          <p>Tap once and get matched with a kind stranger. Vent, or be the one who listens. You'll only ever see each other's anonymous names.</p>
        </div>
        <ul className="promises">
          <li><strong>No profiles, no photos.</strong> A random name like QuietHeron42. Phone numbers and socials are held back unless you both choose to connect.</li>
          <li><strong>Nobody around?</strong> Leave a message and go. The next person who comes to listen starts there.</li>
          <li><strong>Adults only, with rules.</strong> Every message is screened before it's delivered, and reports are read by a person.</li>
        </ul>
        <div className="stack">
          <button className="btn primary big" onClick={() => setMode('signup')}>Get started</button>
          <button className="btn big" onClick={() => setMode('login')}>I have an account</button>
        </div>
        <p className="fine">Adults 18+ only. If you're in crisis, call or text <a href="tel:988">988</a> (US) or find a line at <a href="https://findahelpline.com" target="_blank" rel="noreferrer">findahelpline.com</a>.</p>
        <p className="fine legal-links">
          <button className="link" onClick={() => onOpenLegal('privacy')}>Privacy</button> · <button className="link" onClick={() => onOpenLegal('terms')}>Terms</button>
        </p>
      </main>
    );
  }

  return (
    <main className="screen">
      <button className="back" onClick={() => { setMode(null); setError(''); }}>← Back</button>
      <form className="card form" onSubmit={submit}>
        <h1 className="sr-only">{signup ? 'Create your Kindred account' : 'Sign in to Kindred'}</h1>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={signup} className={signup ? 'tab active' : 'tab'} onClick={() => setMode('signup')}>Create account</button>
          <button type="button" role="tab" aria-selected={!signup} className={!signup ? 'tab active' : 'tab'} onClick={() => setMode('login')}>Sign in</button>
        </div>
        {signup && <p className="hint">Your email stays private. Everyone else only sees a random name like QuietHeron42.</p>}
        <label>
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label>
          <span>Password {signup && <em>(8+ characters)</em>}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={signup ? 8 : undefined}
            maxLength={200}
            autoComplete={signup ? 'new-password' : 'current-password'}
            required
          />
        </label>
        {signup && (
          <>
            <label>
              <span>Birthdate <em>(you must be 18+)</em></span>
              <input type="date" value={birthdate} onChange={(e) => setBirthdate(e.target.value)} required />
            </label>
            <div className="guidelines">
              <strong>Community guidelines</strong>
              <ul>{GUIDELINES.map((g) => <li key={g}>{g}</li>)}</ul>
            </div>
            <label className="check">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} required />
              <span>
                I'm 18 or older and I agree to the guidelines, <button type="button" className="link" onClick={() => onOpenLegal('terms')}>terms</button> and{' '}
                <button type="button" className="link" onClick={() => onOpenLegal('privacy')}>privacy policy</button>.
              </span>
            </label>
          </>
        )}
        {signup && captchaSiteKey && <Turnstile siteKey={captchaSiteKey} onToken={onCaptchaToken} resetKey={captchaRound} />}
        {error && <p className="form-error" role="alert">{error}</p>}
        {!signup && <button type="button" className="link forgot" onClick={() => { setMode('forgot'); setError(''); }}>Forgot password?</button>}
        <button className="btn primary" type="submit" disabled={busy || (signup && (!agree || (captchaSiteKey && !captchaToken)))}>
          {busy ? 'One moment…' : signup ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
