import Bolt from './Bolt.jsx';

// The first thing anyone sees while the app checks who they are: a bolt strikes, the name slams in,
// a charge bar sweeps. (index.html carries the same markup so something shows before any script loads.)
export default function Loader({ label = 'One moment…' }) {
  return (
    <main className="boot" role="status">
      <span className="sr-only">{label}</span>
      <div className="boot-stage" aria-hidden="true">
        <Bolt className="boot-bolt" />
        <div className="boot-word">Kindred</div>
        <div className="boot-bar"><span /></div>
      </div>
    </main>
  );
}
