// Chat text size: a per-device reading preference, so it lives in localStorage
// (which can be unavailable; the default size is always fine).
const KEY = 'kindred.textSize';
export const TEXT_SIZES = [
  { id: 'normal', label: 'Normal' },
  { id: 'large', label: 'Large' },
  { id: 'larger', label: 'Larger' },
];

export function getTextSize() {
  try {
    const v = localStorage.getItem(KEY);
    return TEXT_SIZES.some((s) => s.id === v) ? v : 'normal';
  } catch {
    return 'normal';
  }
}

export function applyTextSize(size = getTextSize()) {
  document.documentElement.dataset.textSize = size;
}

export function setTextSize(size) {
  try {
    localStorage.setItem(KEY, size);
  } catch {
    // Still applies for this visit.
  }
  applyTextSize(size);
}
