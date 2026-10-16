import { useState } from 'react';

export const HELD_NOTES = {
  contact: "Not sent. Contact details (numbers, emails, socials, links) can't be shared unless you both choose to connect.",
  age_probe: "Not sent. Kindred is 18+ only, so please don't ask people their age.",
  sexual: "Not sent. Sexual content isn't allowed on Kindred.",
  minor: 'Not sent.',
};

export function heldNote(flags = []) {
  const key = ['minor', 'sexual', 'age_probe', 'contact'].find((f) => flags.includes(f));
  return HELD_NOTES[key] || 'Not sent. This message breaks the community guidelines.';
}

export function CrisisCard({ role, onDismiss }) {
  return (
    <aside className="crisis" role="note">
      {role === 'sender' ? (
        <p><strong>You matter.</strong> If you're thinking about ending your life or hurting yourself, you can call or text <a href="tel:988">988</a> (US) any time, or find a line near you at <a href="https://findahelpline.com" target="_blank" rel="noreferrer">findahelpline.com</a>. You can keep talking here too.</p>
      ) : (
        <p><strong>They may be going through something heavy.</strong> Listen without judging. Gently mention that they can call or text <a href="tel:988">988</a> (US) or visit <a href="https://findahelpline.com" target="_blank" rel="noreferrer">findahelpline.com</a>. If they're in immediate danger, encourage them to contact emergency services.</p>
      )}
      <button className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </aside>
  );
}

const REASONS = [
  ['harassment', 'Harassment or bullying'],
  ['sexual', 'Sexual messages'],
  ['minor', 'I think they are under 18'],
  ['hate', 'Hate or threats'],
  ['spam', 'Spam or scam'],
  ['self_harm', "I'm worried about their safety"],
  ['other', 'Something else'],
];

export function ReportSheet({ handle, onSubmit, onClose }) {
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit(reason, details.trim() || undefined);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Report ${handle}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <form className="sheet-form" onSubmit={submit}>
        <h2>Report {handle}</h2>
        <p className="hint">A moderator will review the recent messages. You won't be matched with them again.</p>
        <fieldset className="reasons">
          {REASONS.map(([id, label]) => (
            <label key={id} className={reason === id ? 'reason active' : 'reason'}>
              <input type="radio" name="reason" value={id} checked={reason === id} onChange={() => setReason(id)} autoFocus={id === 'harassment'} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} rows={3} placeholder="Anything else we should know? (optional)" aria-label="Details" />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn danger" disabled={!reason || busy}>{busy ? 'Sending…' : 'Report and block'}</button>
        </div>
        </form>
      </div>
    </div>
  );
}
