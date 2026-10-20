import { useState } from 'react';
import { api } from '../api.js';
import { TEXT_SIZES, getTextSize, setTextSize } from '../textSize.js';
import { ACCENTS, getAccent, setAccent } from '../accent.js';
import { enablePush, pushBlocked, pushSupported } from '../notifications.js';
import Support from '../components/Support.jsx';

export default function Account({ user, pushKey, onUserChanged, onBack, onSignOut, onSignOutEverywhere, onDeleted, onOpenLegal, reauthDone = false }) {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accent, setAccentState] = useState(getAccent);
  const pickAccent = (a) => {
    setAccent(a);
    setAccentState(a);
  };
  const [textSize, setSize] = useState(getTextSize);
  const pickSize = (size) => {
    setTextSize(size);
    setSize(size);
  };

  const [pushState, setPushState] = useState(() => (pushSupported() ? Notification.permission : 'unsupported'));
  const turnOnReplies = async () => {
    setBusy(true);
    setError('');
    try {
      await enablePush(pushKey, api.pushSubscribe);
    } catch (err) {
      setError(err.message);
    } finally {
      setPushState(Notification.permission);
      setBusy(false);
    }
  };

  // On call: this device needs notifications on, so ask for them when switching it on.
  const toggleOnCall = async () => {
    const on = !user.listenerAlerts;
    setBusy(true);
    setError('');
    try {
      if (on && !(await enablePush(pushKey, api.pushSubscribe))) {
        throw new Error(pushBlocked()
          ? 'Notifications are blocked for Kindred. Allow them in your browser\'s site settings (the icon next to the address), then try again.'
          : 'Allow notifications for Kindred first, then try again.');
      }
      setPushState(Notification.permission);
      await api.setListenerAlerts(on);
      await onUserChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // No password on this account (it signs in with Google or Apple): they confirm with that provider instead.
  const noPassword = user.signIn?.hasPassword === false;
  const provider = user.signIn?.providers?.[0];
  const providerName = provider === 'apple' ? 'Apple' : 'Google';
  const [confirmedAtProvider, setConfirmedAtProvider] = useState(reauthDone);

  const confirmWithProvider = async () => {
    setBusy(true);
    setError('');
    try {
      const { url } = await api.socialStart({ provider, mode: 'reauth' });
      window.location.assign(url);
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
      await api.deleteAccount(noPassword ? undefined : password);
      onDeleted();
    } catch (err) {
      setError(err.message);
      if (noPassword) setConfirmedAtProvider(false); // the confirmation is single-use and short-lived
      setBusy(false);
    }
  };

  return (
    <main className="screen account">
      <button className="back" onClick={onBack}>← Back</button>
      <h1 className="find-title">Account</h1>

      <section className="card rows">
        <div className="row"><span>Your anonymous name</span><strong>{user.handle}</strong></div>
        <div className="row"><span>Member since</span><span>{new Date(user.createdAt).toLocaleDateString()}</span></div>
      </section>

      {pushKey && pushSupported() && (
        <section className="card rows">
          <div className="row switch-row">
            <span>
              Notifications for replies
              <small className="hint">
                {pushState === 'granted' ? 'On for this device. They show an anonymous name, never what was written.'
                  : pushState === 'denied' ? 'Blocked in this browser. You can allow them in the site settings (the icon next to the address).'
                  : 'Get a notice when someone replies while Kindred is closed.'}
              </small>
            </span>
            {pushState === 'default' && <button className="btn" onClick={turnOnReplies} disabled={busy}>Turn on</button>}
          </div>
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
        <h2 className="section-title" id="accent-label">Your color</h2>
        <div className="swatches" role="radiogroup" aria-labelledby="accent-label">
          {ACCENTS.map((a) => (
            <button key={a.id} type="button" role="radio" aria-checked={accent === a.id} className={accent === a.id ? 'swatch active' : 'swatch'} style={{ '--swatch': a.swatch }} onClick={() => pickAccent(a.id)}>
              <span className="swatch-chip" aria-hidden="true" />
              {a.label}
            </button>
          ))}
        </div>
      </section>

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

      {(confirming || (noPassword && confirmedAtProvider)) && (
        <form className="card form" onSubmit={remove} ref={(el) => { if (el && !el.dataset.shown) { el.dataset.shown = '1'; el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.querySelector('input')?.focus({ preventScroll: true }); } }}>
          <p>Deleting removes your email, password and anything you revealed through Connect right away. People you talked to will see that you left.</p>
          <p className="hint">Messages and reports are kept for 90 days only so moderators can finish any safety review, then they're erased.</p>
          {noPassword ? (
            confirmedAtProvider
              ? <p role="status"><strong>Confirmed with {providerName}.</strong> You can delete now. This stays valid for a few minutes.</p>
              : <p>This account signs in with {providerName}, so there's no password to type. Confirm with {providerName} first.</p>
          ) : (
            <label>
              <span>Enter your password to confirm</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </label>
          )}
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={() => { setConfirming(false); setConfirmedAtProvider(false); setPassword(''); }}>Keep my account</button>
            {noPassword && !confirmedAtProvider
              ? <button type="button" className="btn primary" onClick={confirmWithProvider} disabled={busy}>{busy ? 'One moment…' : `Confirm with ${providerName}`}</button>
              : <button type="submit" className="btn danger" disabled={busy || (!noPassword && !password)}>{busy ? 'Deleting…' : 'Delete forever'}</button>}
          </div>
        </form>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}

      <p className="fine">Need support right now? Call or text <a href="tel:988">988</a> (US) or visit <a href="https://findahelpline.com" target="_blank" rel="noreferrer">findahelpline.com</a>.</p>
    </main>
  );
}
