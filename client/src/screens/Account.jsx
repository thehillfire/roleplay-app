import { useState } from 'react';
import { api } from '../api.js';
import { TEXT_SIZES, getTextSize, setTextSize } from '../textSize.js';
import { enablePush, pushSupported } from '../notifications.js';
import Support from '../components/Support.jsx';

export default function Account({ user, billing, pushKey, onUserChanged, onBack, onSignOut, onSignOutEverywhere, onDeleted, onOpenLegal }) {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [textSize, setSize] = useState(getTextSize);
  const pickSize = (size) => {
    setTextSize(size);
    setSize(size);
  };

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

  const goTo = async (call) => {
    setBusy(true);
    setError('');
    try {
      window.location.assign((await call()).url);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const money = (cents) => new Intl.NumberFormat(undefined, { style: 'currency', currency: billing?.currency || 'usd' }).format(cents / 100);

  // On call: this device needs notifications on, so ask for them when switching it on.
  const toggleOnCall = async () => {
    const on = !user.listenerAlerts;
    setBusy(true);
    setError('');
    try {
      if (on && !(await enablePush(pushKey, api.pushSubscribe))) {
        throw new Error('Allow notifications for Kindred in your browser settings first.');
      }
      await api.setListenerAlerts(on);
      await onUserChanged();
    } catch (err) {
      setError(err.message);
    } finally {
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

      {billing?.enabled && (
        <section className="card plus">
          {user.plus ? (
            <>
              <h2>Kindred Plus 💙</h2>
              <p className="hint">Active until {new Date(user.plusUntil).toLocaleDateString()} (renews automatically). Thank you for keeping Kindred free for everyone.</p>
              <button className="btn" onClick={() => goTo(api.billingPortal)} disabled={busy}>Manage subscription</button>
            </>
          ) : user.hasSubscription ? (
            <>
              <h2>Kindred Plus is paused</h2>
              <p className="hint">Your last payment didn't go through. Update your card and Plus comes right back.</p>
              <button className="btn primary" onClick={() => goTo(api.billingPortal)} disabled={busy}>Manage subscription</button>
            </>
          ) : (
            <>
              <h2>Kindred Plus</h2>
              <p className="hint">{money(billing.plusPriceCents)}/month: {billing.plusCredits} connect credits every month and more new people a day. Talking stays free for everyone.</p>
              <button className="btn primary" onClick={() => goTo(api.subscribePlus)} disabled={busy}>Get Plus</button>
            </>
          )}
        </section>
      )}

      {pushKey && pushSupported() && (
        <section className="card rows">
          <label className="row switch-row">
            <span>
              On call as a listener
              <small className="hint">A notification when someone has been waiting to talk and nobody is free. At most once every few hours, and never who it is.</small>
            </span>
            <input type="checkbox" role="switch" checked={user.listenerAlerts} onChange={toggleOnCall} disabled={busy} />
          </label>
        </section>
      )}

      <section className="card">
        <h2 className="section-title" id="text-size-label">Chat text size</h2>
        <div className="segmented" role="radiogroup" aria-labelledby="text-size-label">
          {TEXT_SIZES.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={textSize === s.id} className={textSize === s.id ? 'seg active' : 'seg'} onClick={() => pickSize(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      </section>

      <Support emailVerified={user.emailVerified} />

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
        <form className="card form" onSubmit={remove} ref={(el) => { if (el && !el.dataset.shown) { el.dataset.shown = '1'; el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.querySelector('input')?.focus({ preventScroll: true }); } }}>
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
