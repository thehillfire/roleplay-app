import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const REASON_LABELS = {
  harassment: 'Harassment', sexual: 'Sexual messages', minor: 'Possibly under 18', hate: 'Hate or threats',
  spam: 'Spam or scam', self_harm: 'Safety concern', other: 'Other',
};
const FLAG_LABELS = { contact: 'Contact info', age_probe: 'Asked age', minor: 'Said under 18', minor_maybe: 'Maybe under 18', sexual: 'Sexual', crisis: 'Crisis' };

const when = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function StatusTag({ status }) {
  const label = { review: 'paused for review', deleted: 'deleted by owner' }[status] || status;
  return <span className={`tag ${status}`}>{label}</span>;
}

export default function Moderate({ onBack }) {
  const [tab, setTab] = useState('reports');
  const [reports, setReports] = useState(null);
  const [held, setHeld] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    setError('');
    Promise.all([api.admin.reports(), api.admin.held()]).then(([r, h]) => {
      setReports(r);
      setHeld(h);
    }, (err) => setError(err.message));
    // Stats are nice to have; they must never keep the queues from loading.
    api.admin.stats().then(setStats, () => setStats(null));
  }, []);
  useEffect(load, [load]);

  const act = async (key, fn) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <main className="screen moderate">
      <button className="back" onClick={onBack}>← Back</button>
      <h1 className="find-title">Moderation</h1>
      {stats && (
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
            ['Revenue', new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(stats.revenueCents / 100)],
          ].map(([label, value]) => (
            <div key={label} className="stat"><span>{label}</span><strong>{value}</strong></div>
          ))}
        </section>
      )}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'reports'} className={tab === 'reports' ? 'tab active' : 'tab'} onClick={() => setTab('reports')}>
          Reports {reports ? `(${reports.length})` : ''}
        </button>
        <button role="tab" aria-selected={tab === 'held'} className={tab === 'held' ? 'tab active' : 'tab'} onClick={() => setTab('held')}>
          Held messages {held ? `(${held.length})` : ''}
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
                <span className="who-line">{m.from === 'reported' ? r.reported.handle : r.reporter.handle}{m.held ? ' · held' : ''}</span>
                {m.body}
              </li>
            ))}
            {r.snapshot.length === 0 && <li className="empty">No messages in this conversation.</li>}
          </ol>
          <div className="actions">
            <button className="btn" disabled={!!busy} onClick={() => act(r.id, () => api.admin.resolve(r.id, 'dismissed'))}>Dismiss</button>
            <button className="btn" disabled={!!busy} onClick={() => act(r.id, () => api.admin.resolve(r.id, 'warned'))}>Warn</button>
            <button className="btn danger" disabled={!!busy} onClick={() => act(r.id, () => api.admin.resolve(r.id, 'suspended'))}>Suspend {r.reported.handle}</button>
          </div>
          {(r.reported.status === 'review' || r.reported.status === 'suspended') && (
            <button className="link" disabled={!!busy} onClick={() => act(`u-${r.reported.id}`, () => api.admin.setStatus(r.reported.id, 'active'))}>
              Restore {r.reported.handle}'s account
            </button>
          )}
        </article>
      ))}

      {tab === 'held' && held?.length === 0 && <p className="empty">Nothing held right now.</p>}
      {tab === 'held' && held?.map((m) => (
        <article key={m.id} className="card report">
          <header>
            <strong>{m.sender.handle} <StatusTag status={m.sender.status} /></strong>
            <small>{when(m.createdAt)}</small>
          </header>
          <p className="details">{m.body}</p>
          <p className="meta">{m.flags.map((f) => <span key={f} className="tag flag">{FLAG_LABELS[f] || f}</span>)}</p>
          <div className="actions">
            {m.sender.status === 'active' && <button className="btn danger" disabled={!!busy} onClick={() => act(m.id, () => api.admin.setStatus(m.sender.id, 'suspended'))}>Suspend sender</button>}
            {(m.sender.status === 'review' || m.sender.status === 'suspended') && (
              <button className="btn" disabled={!!busy} onClick={() => act(m.id, () => api.admin.setStatus(m.sender.id, 'active'))}>Restore sender</button>
            )}
          </div>
        </article>
      ))}
    </main>
  );
}
