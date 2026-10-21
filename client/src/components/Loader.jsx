import KMark from './KMark.jsx';

// The first thing anyone sees while the app loads (at least 2 s): the K logo slams in, the name
// follows, a charge bar sweeps. (index.html carries the same markup so something shows before any script loads.)
export default function Loader({ label = 'One moment…' }) {
  return (
    <main className="boot" role="status">
      <span className="sr-only">{label}</span>
      <div className="boot-stage" aria-hidden="true">
        <KMark className="boot-mark" />
        <div className="boot-word">Kindred</div>
        <div className="boot-bar"><span /></div>
      </div>
    </main>
  );
}
