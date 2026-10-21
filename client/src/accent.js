// Your color: a per-device look, so it lives in localStorage like the text size
// (which can be unavailable; the default color is always fine).
const KEY = 'kindred.accent';
export const ACCENTS = [
  { id: 'volt', label: 'Volt', swatch: '#ffe14d' },
  { id: 'ion', label: 'Ion', swatch: '#3de8ff' },
  { id: 'rush', label: 'Rush', swatch: '#ff6aaa' },
  { id: 'blaze', label: 'Blaze', swatch: '#ff8a3d' },
  { id: 'toxic', label: 'Toxic', swatch: '#7dff6b' },
  { id: 'void', label: 'Void', swatch: '#b98cff' },
];

export function getAccent() {
  try {
    const v = localStorage.getItem(KEY);
    return ACCENTS.some((a) => a.id === v) ? v : 'volt';
  } catch {
    return 'volt';
  }
}

export function applyAccent(accent = getAccent()) {
  document.documentElement.dataset.accent = accent;
  // The browser/app bar picks up the color too.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0b0a10');
}

export function setAccent(accent) {
  try {
    localStorage.setItem(KEY, accent);
  } catch {
    // Still applies for this visit.
  }
  applyAccent(accent);
}
