import { useState } from 'react';
import { api } from '../api.js';

export default function ResetPassword({ token, onDone, onRequestNew }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.reset(token, password);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <main className="screen">
      <form className="card form" onSubmit={submit}>
        <h1 className="find-title">Choose a new password</h1>
        {!token && <p className="form-error">This reset link is incomplete. Request a new one from the sign-in screen.</p>}
        <label>
          <span>New password <em>(8+ characters)</em></span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={200} autoComplete="new-password" required />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        {(error && /expired|already used|request a new/i.test(error)) || !token ? (
          <button className="btn primary" type="button" onClick={onRequestNew}>Send me a new link</button>
        ) : (
          <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save and sign in'}</button>
        )}
        <p className="hint">This signs you out on every other device.</p>
      </form>
    </main>
  );
}
