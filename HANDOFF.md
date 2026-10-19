# Handoff: Kindred

**Repo:** `thehillfire/roleplay-app` · **Branch:** `ccr-2e9faa94-hbk5np` · **PR:** #1 (draft, CI green on `7e20a23`)
`main` still holds the old roleplay app. All Kindred work lives on the branch above until PR #1 is merged.

## What it is

Kindred: anonymous 1:1 texting with strangers, 18+ only. The owner is Jav.
- **Talk it out (support):** talk/listen/either roles, topics, listeners on call, a message left for the next listener.
- **Game modes:** Cringe Duel (shared awkward-scenario cards) and Don't Smile (on-device smile check via MediaPipe; the camera never leaves the phone).
- **Matching** only within the same mode. You can keep chatting with past matches. "Connect" (a mutual name reveal) is the paid feature.
- **Strong moderation:** a screener (EN/ES), reports, held queue, appeals, device bans and a moderator screen.
- **Look:** fighting-game HUD (2XKO-*inspired*, no Riot assets). Each person picks their color in Account (Volt, Ion, Rush, Blaze, Toxic, Void). Splashes on match, connect and thanks. Crisis and report screens stay calm on purpose.

## Stack

- **Server:** Node 22, Express 5, `ws`. Database is `node:sqlite` locally, or Postgres when `DATABASE_URL` is set; migrations 1–29 are in `server/src/db.js`.
- **Client:** React 19 + Vite 6, a PWA. The MediaPipe wasm is served from `/mediapipe` (copied at build by `vite.config.js`); the model is at `client/public/models/`.
- **Single process:** matchmaking and live delivery are in memory, so run **one instance only**. Scaling out needs Redis pub/sub.
- **Docs:** `docs/DEPLOY.md`, `docs/ANDROID.md` (Play Store via Trusted Web Activity/PWABuilder), `docs/MODERATION.md`, `docs/LAUNCH.md`, `docs/ROADMAP.md`.

## How to verify (gate every commit on this)

```bash
npm install
CHROMIUM_PATH=/opt/pw-browsers/chromium npm run verify   # tests + build + 4-browser e2e + axe audit
TEST_DATABASE_URL=postgres://postgres@localhost:5433/loreforge_test npm run test:pg
```
- `test:pg` refuses to run without `TEST_DATABASE_URL`. It once silently fell back to SQLite; that's why the guard exists.
- If you need a local Postgres:
  ```bash
  D=/var/tmp/kd-pgdata
  mkdir -p $D && chown postgres $D
  su postgres -c "/usr/lib/postgresql/16/bin/initdb -D $D -A trust -U postgres"
  su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $D -o '-p 5433 -k /tmp' -l $D/log start"
  psql -h localhost -p 5433 -U postgres -c 'CREATE DATABASE loreforge_test'
  ```
- Current state: 161 server tests pass on both SQLite and Postgres; e2e passes (26 steps); axe audit is clean.

## Where things stand right now

1. **Not live anywhere yet. This is the top priority.** Jav is setting up **Render** from his phone:
   - Web Service, branch `ccr-2e9faa94-hbk5np`, Docker, Free plan.
   - Env: `NODE_ENV=production`, `ADMIN_EMAILS=<his email>`, then `PUBLIC_URL=<the onrender URL>`.
   - Optional: a free Render Postgres, with `DATABASE_URL` set to its internal URL.

   When he sends the URL, test it from outside: sign up, match two accounts, both games, connect.
2. **Vercel connector:** it is connected, but its token has no usable account. `/v2/user` returns 404, there are no projects, and `create_project` returns 403.
   - Vercel can't host Kindred anyway: serverless can't hold the WebSockets.
   - A Vercel *Sandbox* could give a temporary test link, but only after Jav reconnects the connector with project-create rights at https://claude.ai/customize/connectors and starts a new session.
3. **Android:** the groundwork is done.
   - `/.well-known/assetlinks.json` is served from `ANDROID_PACKAGE_NAME` + `ANDROID_CERT_SHA256`; `android/twa-manifest.json` exists.
   - Next: once the site is live, package it with PWABuilder, then the Play Console ($25). New personal accounts need a 12-tester, 14-day closed test.
   - Steps are in `docs/ANDROID.md`.

## Decisions waiting on Jav

- **Email-first signup:** today, signup reveals whether an email already has an account.
- **Spanish UI:** the screener already handles Spanish.
- **A real age-assurance vendor.**
- **Pricing:** see `docs/LAUNCH.md`.
- **Legal review:** the privacy and terms pages are still marked Draft.
- **Real keys before launch:** Stripe, Resend (email), Turnstile, VAPID push, AdSense, OpenAI moderation, `ERROR_WEBHOOK_URL`, Android signing fingerprint.

## Known gaps / next ideas

- **Don't Smile:** detection is untested on a real face (CI uses a black fake camera). Add a round timer ("first to crack in 60s").
- **More modes:** Hot Takes, Two Truths and a Lie. Add the id to `MODES` in `server/src/matchmaker.js` and `client/src/games.js`, plus a panel component.
- **MediaPipe** pings `odml.pa.googleapis.com` with usage stats. The CSP blocks it on purpose, and e2e ignores that console line.
- **Re-sign-in** lands on home, not the chat you were in.

## Working with Jav

- He calls the assistant **Lidia**; call him **Jav**.
- Act as an advisor, not an assistant. Open by challenging an assumption, never with agreement.
- Tag claims [Certain]/[Likely]/[Guessing].
- Never say "Great question", "You're absolutely right", "That makes a lot of sense", "Absolutely" or "Definitely".
- He's usually on his phone: give short, numbered steps, and don't assume he has a terminal.
- Keep safety intact when he asks for edgy features. Reframe them; don't just refuse. For example, "make each other uncomfortable" became Cringe Duel, and the camera became on-device only.
