import { useState } from 'react';
import { api } from '../api.js';

export default function Account({ user, billing, onBack, onSignOut, onSignOutEverywhere, onDeleted, onOpenLegal }) {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const buy = async () => {
    setBusy(true);
    setError('');
    try {
      window.location.assign((await api.checkout()).url);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const remove = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.deleteAccount(password);
      onDeleted();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <main className="screen account">
      <button className="back" onClick={onBack}>← Back</button>
      <h1 className="find-title">Account</h1>

      <section className="card rows">
        <div className="row"><span>Your anonymous name</span><strong>{user.handle}</strong></div>
        {billing?.enabled && (
          <div className="row">
            <span>Connect credits</span>
            <span className="row-end"><strong>{user.connectCredits}</strong><button className="link" onClick={buy} disabled={busy}>Buy one</button></span>
          </div>
        )}
        <div className="row"><span>Member since</span><span>{new Date(user.createdAt).toLocaleDateString()}</span></div>
      </section>

      <section className="card rows">
        <a className="row link-row" href="/api/account/export" download>Download my data</a>
        <button className="row link-row" onClick={() => onOpenLegal('privacy')}>Privacy policy</button>
        <button className="row link-row" onClick={() => onOpenLegal('terms')}>Terms</button>
        <button className="row link-row" onClick={onSignOut}>Sign out</button>
        <button className="row link-row" onClick={() => window.confirm('Sign out on every phone and computer, including this one?') && onSignOutEverywhere()}>
          Sign out everywhere
        </button>
        <button className="row link-row danger-text" onClick={() => setConfirming(true)}>Delete account</button>
      </section>

      {confirming && (
        <form className="card form" onSubmit={remove}>
          <p>Deleting removes your email, password and anything you revealed through Connect right away. People you talked to will see that you left.</p>
          <p className="hint">Messages and reports are kept for 90 days only so moderators can finish any safety review, then they're erased.</p>
          <label>
            <span>Enter your password to confirm</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={() => { setConfirming(false); setPassword(''); }}>Keep my account</button>
            <button type="submit" className="btn danger" disabled={busy || !password}>{busy ? 'Deleting…' : 'Delete forever'}</button>
          </div>
        </form>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}

      <p className="fine">Need support right now? Call or text <a href="tel:988">988</a> (US) or visit <a href="https://findahelpline.com" target="_blank" rel="noreferrer">findahelpline.com</a>.</p>
    </main>
  );
}
