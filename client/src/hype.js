// Big moments (a match, a connection, a thank-you) get a short full-screen splash.
// Anything can fire one; the overlay in App shows it.
export const HYPE_EVENT = 'kindred:hype';
export const hype = (detail) => window.dispatchEvent(new CustomEvent(HYPE_EVENT, { detail }));
