import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const REASON_LABELS = {
  harassment: 'Harassment', sexual: 'Sexual messages', minor: 'Possibly under 18', hate: 'Hate or threats',
  spam: 'Spam or scam', self_harm: 'Safety concern', other: 'Other',
};
const FLAG_LABELS = {
  contact: 'Contact info', location: 'Asked location', meetup: 'Meetup or photos', age_probe: 'Asked age', minor: 'Said under 18', minor_maybe: 'Maybe under 18',
  sexual: 'Sexual', crisis: 'Crisis', minor_sexual: 'Sexual + minors', threat: 'Threat', hate: 'Hate', harassment: 'Harassment', spam: 'Copy-paste spam',
};

const when = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function StatusTag({ status }) {
  const label = { review: 'paused for review', deleted: 'deleted by owner' }[status] || status;
  return <span className={`tag ${status}`}>{label}</span>;
}

const ACTION_LABELS = {
  report_dismissed: 'Dismissed a report',
  report_warned: 'Warned after a report',
  report_suspended: 'Suspended after a report',
  suspend: 'Suspended',
  restore: 'Restored',
  auto_pause: 'Paused automatically',
  held_released: 'Delivered a held message',
  held_kept: 'Kept a message held',
  appeal_granted: 'Granted an appeal',
  appeal_denied: 'Kept paused after an appeal',
  appeal_closed_account_deleted: 'Closed an appeal (account deleted)',
  support_replied: 'Replied to a support request',
  support_closed: 'Closed a support request',
};
// "Suspended after a report (Harassment)" rather than "report suspended (harassment)".
function actionLabel(e) {
  const label = ACTION_LABELS[e.action] || e.action.replace(/_/g, ' ');
  const detail = e.action.startsWith('report_') ? REASON_LABELS[e.detail] || e.detail
    : e.action.startsWith('held_') && e.detail ? e.detail.split(', ').map((f) => FLAG_LABELS[f] || f).join(', ')
    : e.detail;
  return detail ? `${label} (${detail})` : label;
}

export default function Moderate({ onBack }) {
  const [tab, setTab] = useState('reports');
  const [reports, setReports] = useState(null);
  const [held, setHeld] = useState(null);
  const [stats, setStats] = useState(null);
  const [appeals, setAppeals] = useState(null);
  const [log, setLog] = useState(null);
  const [error, setError] = useState('');
  // A failed action shows its error inside the card it came from, not at the top of a long list.
  const [cardError, setCardError] = useState(null);
  const errorIn = (...keys) => cardError && keys.includes(cardError.key)
    ? <p className="form-error" role="alert">{cardError.message}</p>
    : null;
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const [inbox, setInbox] = useState(null);
  const [replies, setReplies] = useState({});
  const [appealNotes, setAppealNotes] = useState({});
  const [found, setFound] = useState(null);

  const lookup = async (e) => {
    e?.preventDefault();
    setError('');
    try {
      setFound(await api.admin.lookup(query.trim()));
    } catch (err) {
      setFound(null);
      setError(err.message);
    }
  };

  const load = useCallback(() => {
    setError('');
    Promise.all([api.admin.reports(), api.admin.held(), api.admin.appeals()]).then(([r, h, a]) => {
      setReports(r);
      setHeld(h);
      setAppeals(a);
    }, (err) => setError(err.message));
    api.admin.log().then(setLog, () => setLog([]));
    api.admin.support().then(setInbox, () => setInbox([]));
    // Stats are nice to have; they must never keep the queues from loading.
    api.admin.stats().then(setStats, () => setStats(null));
  }, []);
  useEffect(load, [load]);

  const act = async (key, fn) => {
    setBusy(key);
    setError('');
    setCardError(null);
    try {
      await fn();
      load();
      if (found) setFound(await api.admin.lookup(found.handle));
    } catch (err) {
      setCardError({ key, message: err.message });
    } finally {
      setBusy('');
    }
  };

  return (
    <main className="screen moderate">
      <button className="back" onClick={onBack}>← Back</button>
      <h1 className="find-title">Moderation</h1>
      {/* Folded by default so the queues (the actual work) are on the first screen of a phone. */}
      {stats && (
        <details className="stats-fold">
        <summary>Today at a glance · {stats.heldToReview} held · {stats.supportOpen} support</summary>
        <section className="stats-grid" aria-label="Today at a glance">
          {[
            ['Here now', stats.online],
            ['Active today', stats.activeDay],
            ['Messages today', stats.messagesDay],
            ['New matches today', stats.matchesDay],
            ['Signups today', stats.signupsDay],
            ['Signups this week', stats.signupsWeek],
            ['Members', stats.users],
            ['"Helped" this week', stats.helpfulWeek],
            ['Connections made', stats.connectsAccepted],
            ['Held to review', stats.heldToReview],
            ['Messages waiting for a listener', stats.messagesWaiting],
            ['Support requests open', stats.supportOpen],
          ].map(([label, value]) => (
            <div key={label} className="stat"><span>{label}</span><strong>{value}</strong></div>
          ))}
        </section>
        </details>
      )}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'reports'} className={tab === 'reports' ? 'tab active' : 'tab'} onClick={() => setTab('reports')}>
          Reports {reports ? `(${reports.length})` : ''}
        </button>
        <button role="tab" aria-selected={tab === 'held'} className={tab === 'held' ? 'tab active' : 'tab'} onClick={() => setTab('held')}>
          Held {held ? `(${held.length})` : ''}
        </button>
        <button role="tab" aria-selected={tab === 'appeals'} className={tab === 'appeals' ? 'tab active' : 'tab'} onClick={() => setTab('appeals')}>
          Appeals {appeals ? `(${appeals.length})` : ''}
        </button>
        <button role="tab" aria-selected={tab === 'inbox'} className={tab === 'inbox' ? 'tab active' : 'tab'} onClick={() => setTab('inbox')}>
          Inbox {inbox ? `(${inbox.length})` : ''}
        </button>
        <button role="tab" aria-selected={tab === 'lookup'} className={tab === 'lookup' ? 'tab active' : 'tab'} onClick={() => setTab('lookup')}>
          Look up
        </button>
        <button role="tab" aria-selected={tab === 'log'} className={tab === 'log' ? 'tab active' : 'tab'} onClick={() => setTab('log')}>
          Log
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}

      {tab === 'reports' && reports?.length === 0 && <p className="empty">No open reports. 🌿</p>}
      {tab === 'reports' && reports?.map((r) => (
        <article key={r.id} className="card report">
          <header>
            <strong>{REASON_LABELS[r.reason] || r.reason}</strong>
            <small>{when(r.createdAt)}</small>
          </header>
          <p className="meta">
            <span>Reported: <strong>{r.reported.handle}</strong> <StatusTag status={r.reported.status} /></span>
            <span>By: {r.reporter.handle}</span>
          </p>
          {r.details && <p className="details">“{r.details}”</p>}
          <ol className="transcript">
            {r.snapshot.map((m, i) => (
              <li key={i} className={m.from}>
                <span className="who-line">{m.from === 'reported' ? r.reported.handle : r.reporter.handle}{m.held ? ' · held' : ''}{m.unsent ? ' · unsent by sender' : ''}</span>
                {m.body}
              </li>
            ))}
            {r.snapshot.length === 0 && <li className="empty">No messages in this conversation.</li>}
          </ol>
          <div className="actions">
            <button className="btn" disabled={!!busy} onClick={() => act(r.id, () => api.admin.resolve(r.id, 'dismissed'))}>Dismiss</button>
            <button className="btn" disabled={!!busy} onClick={() => act(r.id, () => api.admin.resolve(r.id, 'warned'))}>Warn</button>
            <button className="btn danger" disabled={!!busy} onClick={() => window.confirm(`Suspend ${r.reported.handle}?`) && act(r.id, () => api.admin.resolve(r.id, 'suspended'))}>Suspend {r.reported.handle}</button>
          </div>
          {(r.reported.status === 'review' || r.reported.status === 'suspended') && (
            <button className="link" disabled={!!busy} onClick={() => act(`u-${r.reported.id}`, () => api.admin.setStatus(r.reported.id, 'active'))}>
              Restore {r.reported.handle}'s account
            </button>
          )}
          {errorIn(r.id, `u-${r.reported.id}`)}
        </article>
      ))}

      {tab === 'held' && held?.length === 0 && <p className="empty">Nothing held right now.</p>}
      {tab === 'held' && held?.map((m) => (
        <article key={m.id} className="card report">
          <header>
            <strong>{m.sender.handle} <StatusTag status={m.sender.status} /></strong>
            <small>{when(m.createdAt)}</small>
          </header>
          {m.context?.length > 0 && <p className="hint">Just before:</p>}
          {m.context?.length > 0 && (
            <ol className="transcript context">
              {m.context.map((c, i) => (
                <li key={i} className={c.fromSender ? 'reported' : 'reporter'}>
                  <span className="who-line">{c.fromSender ? m.sender.handle : 'the other person'}{c.unsent ? ' · unsent by sender' : ''}</span>
                  {c.body}
                </li>
              ))}
            </ol>
          )}
          <p className="details">{m.body}</p>
          <p className="meta">{m.flags.map((f) => <span key={f} className="tag flag">{FLAG_LABELS[f] || f}</span>)}</p>
          <div className="actions">
            <button className="btn" disabled={!!busy} onClick={() => act(m.id, () => api.admin.reviewHeld(m.id, true))}>Deliver anyway</button>
            <button className="btn" disabled={!!busy} onClick={() => act(m.id, () => api.admin.reviewHeld(m.id, false))}>Keep held</button>
            {m.sender.status === 'active' && <button className="btn danger" disabled={!!busy} onClick={() => window.confirm(`Suspend ${m.sender.handle}? Their devices are banned too.`) && act(m.id, () => api.admin.setStatus(m.sender.id, 'suspended'))}>Suspend sender</button>}
            {(m.sender.status === 'review' || m.sender.status === 'suspended') && (
              <button className="btn" disabled={!!busy} onClick={() => act(m.id, () => api.admin.setStatus(m.sender.id, 'active'))}>Restore sender</button>
            )}
          </div>
          {errorIn(m.id)}
        </article>
      ))}
      {tab === 'appeals' && appeals?.length === 0 && <p className="empty">No open appeals.</p>}
      {tab === 'appeals' && appeals?.map((a) => (
        <article key={a.id} className="card report">
          <header>
            <strong>{a.user.handle} <StatusTag status={a.user.status} /></strong>
            <small>{when(a.createdAt)}</small>
          </header>
          {a.pausedBy && <p className="meta"><span>Paused: {actionLabel(a.pausedBy)}</span></p>}
          <p className="details">“{a.message}”</p>
          <div className="actions">
            <textarea
              className="reply-box"
              aria-label={`Note to ${a.user.handle} (optional)`}
              value={appealNotes[a.id] || ''}
              onChange={(e) => setAppealNotes((m) => ({ ...m, [a.id]: e.target.value }))}
              placeholder="Optional note they'll see, e.g. why the pause stays"
              maxLength={500}
            />
            {(appealNotes[a.id] || '').length > 400 && <small className="hint">{500 - appealNotes[a.id].length} characters left</small>}
            {a.user.status === 'deleted' ? (
              <button className="btn" disabled={!!busy} onClick={() => act(a.id, () => api.admin.resolveAppeal(a.id, true))}>Close (account deleted)</button>
            ) : (
              <>
                <button className="btn primary" disabled={!!busy} onClick={() => act(a.id, () => api.admin.resolveAppeal(a.id, true, appealNotes[a.id]))}>Restore account</button>
                <button className="btn" disabled={!!busy} onClick={() => act(a.id, () => api.admin.resolveAppeal(a.id, false, appealNotes[a.id]))}>Keep paused</button>
              </>
            )}
          </div>
          {errorIn(a.id)}
        </article>
      ))}

      {tab === 'inbox' && inbox?.length === 0 && <p className="empty">No support requests waiting.</p>}
      {tab === 'inbox' && inbox?.map((r) => (
        <article key={r.id} className="card report">
          <header>
            <strong>{r.topic} · {r.user.handle} <StatusTag status={r.user.status} /></strong>
            <small>{when(r.createdAt)}</small>
          </header>
          <p className="details">{r.message}</p>
          <textarea
            className="reply-box"
            aria-label={`Reply to ${r.user.handle}`}
            value={replies[r.id] || ''}
            onChange={(e) => setReplies((m) => ({ ...m, [r.id]: e.target.value }))}
            placeholder="Your reply is emailed to them. You won't see their address."
            maxLength={4000}
          />
          <div className="actions">
            {r.user.status !== 'deleted' && (
              <button className="btn primary" disabled={!!busy || !(replies[r.id] || '').trim()} onClick={() => act(r.id, () => api.admin.resolveSupport(r.id, replies[r.id]))}>Send reply</button>
            )}
            <button className="btn" disabled={!!busy} onClick={() => act(r.id, () => api.admin.resolveSupport(r.id, ''))}>Close without reply</button>
          </div>
          {errorIn(r.id)}
        </article>
      ))}

      {tab === 'lookup' && (
        <form className="lookup" onSubmit={lookup}>
          <input aria-label="Handle" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Handle, e.g. QuietHeron42" autoComplete="off" spellCheck={false} />
          <button className="btn" type="submit" disabled={!query.trim()}>Look up</button>
        </form>
      )}
      {tab === 'lookup' && found && (
        <article className="card report">
          <header>
            <strong>{found.handle} <StatusTag status={found.status} /></strong>
            <small>joined {when(found.createdAt)}</small>
          </header>
          <p className="meta">
            <span>Reports against: <strong>{found.reportsOpen} open</strong> · {found.reportsTotal} total</span>
            <span>Reports made: {found.reportsMade}</span>
            <span>Held messages: {found.held}</span>
            {found.role === 'admin' && <span>Moderator</span>}
          </p>
          {found.actions.length > 0 && (
            <ol className="modlog">
              {found.actions.map((e) => (
                <li key={e.id}>
                  <small>{when(e.createdAt)}</small>
                  <span><strong>{e.moderator}</strong> · {actionLabel(e)}</span>
                </li>
              ))}
            </ol>
          )}
          <div className="actions">
            {found.status === 'active' && found.role !== 'admin' && (
              <button className="btn danger" disabled={!!busy} onClick={() => window.confirm(`Suspend ${found.handle}?`) && act(`l-${found.id}`, () => api.admin.setStatus(found.id, 'suspended'))}>Suspend</button>
            )}
            {['review', 'suspended'].includes(found.status) && (
              <button className="btn" disabled={!!busy} onClick={() => act(`l-${found.id}`, () => api.admin.setStatus(found.id, 'active'))}>Restore</button>
            )}
          </div>
          {errorIn(`l-${found.id}`)}
        </article>
      )}

      {tab === 'log' && (
        <ol className="modlog">
          {log?.length === 0 && <li className="empty">No moderation actions yet.</li>}
          {log?.map((e) => (
            <li key={e.id}>
              <small>{when(e.createdAt)}</small>
              <span><strong>{e.moderator}</strong> · {actionLabel(e)}{e.target ? ` · ${e.target}` : ''}</span>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
