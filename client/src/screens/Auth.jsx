import { useState } from 'react';
import { api } from '../api.js';

export default function Auth({ onSignedIn, onBack, guestCount }) {
  const [mode, setMode] = useState('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signup = mode === 'signup';

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = signup ? await api.signup(email, password, displayName) : await api.login(email, password);
      await onSignedIn(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <main className="screen">
      <button className="back" onClick={onBack}>← Back</button>
      <form className="card form" onSubmit={submit}>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={signup} className={signup ? 'tab active' : 'tab'} onClick={() => setMode('signup')}>Create account</button>
          <button type="button" role="tab" aria-selected={!signup} className={!signup ? 'tab active' : 'tab'} onClick={() => setMode('login')}>Sign in</button>
        </div>
        <p className="hint">
          {signup ? 'Keep your stories safe and play them on any device.' : 'Welcome back, traveler.'}
          {guestCount > 0 && ` Your ${guestCount} guest ${guestCount === 1 ? 'story' : 'stories'} will come with you.`}
        </p>
        {signup && (
          <label>
            <span>Display name</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} autoComplete="nickname" required />
          </label>
        )}
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
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'One moment…' : signup ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
