# Roadmap

Working order for turning LoreForge into an app a real user base can use. Each item ships tested and pushed.

## Now
- [x] Accounts: sign up / log in / log out (scrypt hashes, httpOnly session cookie). Guests keep playing locally.
- [x] Server-owned stories for signed-in players (the server holds history, so progress can't be tampered with and works across devices).
- [x] Import guest stories into an account on first sign-in.
- [x] Storage: SQLite by default (built into Node), Postgres via `DATABASE_URL` (works with Supabase/Neon/Render).

## Next
- [ ] Game depth: HP, inventory and quest log updated by the narrator; d20 checks rolled on the server for risky actions.
- [ ] Story settings: genre/tone picker (cozy fantasy, mystery, sci-fi, horror-lite).
- [ ] Streaming narration so text appears as it is written.
- [ ] Per-user daily turn quota + abuse limits.
- [ ] Share a story as a read-only link.
- [ ] Endings and an epilogue; archive finished stories.

## Polish
- [ ] PWA: manifest, icons, offline shell, installable on phones.
- [ ] Accessibility pass (focus order, contrast, reduced motion, screen reader labels).
- [ ] Client tests (Vitest) and GitHub Actions CI.
- [ ] Settings: text size, sound, account deletion and data export.
