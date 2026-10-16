const KEY = 'loreforge.stories.v1';

export function loadStories() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveStories(stories) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stories));
  } catch {
    // Storage can be unavailable (private mode, quota); the session still works.
  }
}
