import { useState } from 'react';
import { api } from '../api.js';

const money = (cents, currency) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);

// Shown above the messages: the state of a connect request in this conversation.
export function ConnectBanner({ connection, handle, onAccept, onDecline, onCancel }) {
  if (!connection || connection.status === 'none') return null;
  if (connection.status === 'accepted') {
    const { name, contact } = connection.partner;
    return (
      <aside className="connect-banner accepted" role="status">
        <p><strong>You're connected.</strong> {handle} is <strong>{name}</strong>{contact ? <> · {contact}</> : null}</p>
      </aside>
    );
  }
  if (connection.status === 'pending' && connection.mine) {
    return (
      <aside className="connect-banner" role="status">
        <p>Connect request sent. If {handle} agrees, you'll both see what you chose to share.</p>
        <button className="link" onClick={onCancel}>Cancel</button>
      </aside>
    );
  }
  if (connection.status === 'pending') {
    return (
      <aside className="connect-banner incoming" role="status">
        <p><strong>{handle} would like to connect.</strong> If you accept, you'll both see each other's first name and anything else you choose to share.</p>
        <div className="connect-actions">
          <button className="btn" onClick={onDecline}>Stay anonymous</button>
          <button className="btn primary" onClick={onAccept}>Accept…</button>
        </div>
      </aside>
    );
  }
  if (connection.status === 'declined' && connection.mine) {
    return <aside className="connect-banner" role="status"><p>{handle} chose to stay anonymous. You can keep talking as you are.</p></aside>;
  }
  return null;
}

// Collects what to reveal; buys a credit first when payments are on and none is left.
export function ConnectSheet({ handle, accepting, billing, credits, onSubmit, onClose }) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needsPurchase = !accepting && billing?.enabled && credits < 1;

  const buy = async () => {
    setBusy(true);
    setError('');
    try {
      const { url } = await api.checkout();
      window.location.assign(url);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (needsPurchase) return buy();
    setBusy(true);
    setError('');
    try {
      await onSubmit(name.trim(), contact.trim());
    } catch (err) {
      if (err.status === 402) setError('You need a connect credit first.');
      else setError(err.message);
      setBusy(false);
    }
    return undefined;
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Connect with ${handle}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <form className="sheet-form" onSubmit={submit}>
        <h2>{accepting ? `Connect with ${handle}` : `Ask ${handle} to connect`}</h2>
        <p className="hint">
          {accepting
            ? 'You will both see what you each chose to share. Nothing else about you is revealed.'
            : `Nothing is revealed unless ${handle} says yes too. If they'd rather stay anonymous, that's final, and you can keep chatting as you are.`}
        </p>
        <label>
          <span>First name or nickname</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus />
        </label>
        <label>
          <span>A way to reach you <em>(optional: number, email, social)</em></span>
          <input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={100} />
        </label>
        {!accepting && billing?.enabled && (
          <p className="price">
            {credits > 0
              ? `Uses 1 of your ${credits} connect ${credits === 1 ? 'credit' : 'credits'}. You get it back if they decline.`
              : `A connect request costs ${money(billing.priceCents, billing.currency)}. If they decline, you keep the credit for someone else.`}
          </p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || (!needsPurchase && !name.trim())}>
            {busy ? 'One moment…' : needsPurchase ? `Buy for ${money(billing.priceCents, billing.currency)}` : accepting ? 'Accept and connect' : 'Send request'}
          </button>
        </div>
        </form>
      </div>
    </div>
  );
}
