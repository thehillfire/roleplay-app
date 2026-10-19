// "Continue with Google / Apple". Providers that are set up are live buttons; with SOCIAL_PREVIEW on, the
// rest show as disabled "coming soon" so the layout can be seen before the keys exist.
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M23.64 12.2c0-.82-.07-1.6-.21-2.36H12v4.47h6.52a5.57 5.57 0 0 1-2.42 3.66v3.04h3.92c2.3-2.11 3.62-5.22 3.62-8.81z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.92-3.04c-1.08.72-2.46 1.15-4.03 1.15-3.1 0-5.73-2.1-6.67-4.91H1.3v3.14A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.33 14.3a7.2 7.2 0 0 1 0-4.6V6.56H1.3a12 12 0 0 0 0 10.88l4.03-3.14z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.6 4.58 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.3 6.56l4.03 3.14C6.27 6.87 8.9 4.77 12 4.77z" />
    </svg>
  );
}

function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M16.37 1.43c0 1.14-.46 2.22-1.2 3-.8.85-2.1 1.5-3.15 1.42-.13-1.1.42-2.25 1.15-3 .8-.84 2.2-1.46 3.2-1.42zM20.5 17.1c-.55 1.27-.82 1.84-1.53 2.96-1 1.56-2.4 3.5-4.14 3.52-1.55.02-1.95-1-4.05-.99-2.1.01-2.54 1.01-4.1.99-1.74-.02-3.07-1.77-4.07-3.33C-.2 15.8-.5 10.7 1.5 8.1c1.42-1.84 3.66-2.92 5.77-2.92 2.15 0 3.5 1.18 5.28 1.18 1.72 0 2.77-1.18 5.26-1.18 1.88 0 3.87 1.02 5.28 2.8-4.64 2.54-3.89 9.15.41 9.12z" />
    </svg>
  );
}

const MARKS = { google: GoogleMark, apple: AppleMark };

export default function SocialButtons({ providers = [], soon = [], disabled = false, onPick }) {
  const all = [...providers.map((p) => ({ ...p, live: true })), ...soon.map((p) => ({ ...p, live: false }))];
  if (!all.length) return null;
  return (
    <div className="social" role="group" aria-label="Continue with">
      {all.map((p) => {
        const Mark = MARKS[p.id];
        return (
          <button key={p.id} type="button" className={`btn social-btn ${p.id}`} disabled={disabled || !p.live} onClick={() => onPick(p.id)}>
            {Mark && <Mark />}
            <span>{p.live ? `Continue with ${p.label}` : `${p.label}: coming soon`}</span>
          </button>
        );
      })}
    </div>
  );
}
