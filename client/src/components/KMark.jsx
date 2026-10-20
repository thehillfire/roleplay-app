// The Kindred logo: the slanted K with its yellow shadow (the same shapes as the app icon, public/icon.svg).
const K = (
  <>
    <polygon points="160,104 244,104 212,408 128,408" />
    <polygon points="236,236 336,104 436,104 304,272" />
    <polygon points="262,236 356,408 262,408 204,300" />
  </>
);

export default function KMark({ className = '' }) {
  return (
    <svg className={`kmark ${className}`} viewBox="112 88 344 352" aria-hidden="true" focusable="false">
      <g className="kmark-shadow" transform="translate(16 16)">{K}</g>
      <g className="kmark-face">{K}</g>
    </svg>
  );
}
