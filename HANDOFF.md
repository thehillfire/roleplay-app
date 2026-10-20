# Handoff: Kindred

**Repo:** `thehillfire/roleplay-app` · **Branch:** `ccr-2e9faa94-hbk5np` · **PR:** #1 (draft, CI green on `7e20a23`)
`main` still holds the old roleplay app. All Kindred work lives on the branch above until PR #1 is merged.

## What it is

Kindred: anonymous 1:1 texting with strangers, 18+ only. The owner is Jav.
- **Talk it out (support):** talk/listen/either roles, topics, listeners on call, a message left for the next listener.
- **Game modes:** Cringe Duel (shared awkward-scenario cards) and Don't Smile (on-device smile check via MediaPipe; the camera never leaves the phone).
- **Matching** only within the same mode. You can keep chatting with past matches. "Connect" (a mutual name reveal) is the paid feature.
- **Strong moderation:** a screener (EN/ES), reports, held queue, appeals, device bans and a moderator screen.
- **Sign-in:** email + password, or Continue with Google / Apple (each appears only when its keys are set; see `docs/DEPLOY.md`). Provider accounts stay anonymous: only the provider's account id and the verified email are kept, the 18+ gate still applies, and a provider account is never merged into an existing email account.
- **Look:** fighting-game HUD (2XKO-*inspired*, no Riot assets). Animated loader (`Loader.jsx`), and a lightning "strike" after sign-in or sign-up (`Strike.jsx`; one flash only, still and short under reduced motion). Each person picks their color in Account (Volt, Ion, Rush, Blaze, Toxic, Void). Splashes on match, connect and thanks. Crisis and report screens stay calm on purpose.

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

0. **Social sign-in is built but dormant until keys exist.** Tested end to end against a fake Google (`e2e/social.mjs`, `server/test/social.test.js`); never run against the real Google or Apple, which the test environment can't reach. The first real sign-in must be tried by hand. Google needs only a free Cloud Console client ID. Apple needs the paid Developer Program. `SOCIAL_PREVIEW=1` shows the providers that aren't set up as disabled "coming soon" buttons.
   - Single instance matters here too: in-progress sign-ins are held in memory (10 minutes), like matchmaking.
   - Accounts that only sign in through a provider have no password. Deleting one asks them to confirm with the provider again first.

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

4. **Store readiness (2026-10-19, session 017tKMDq):** the checklist for both stores is `docs/STORE_READINESS.md`; the iOS guide is `docs/IOS.md`.
   - Store apps open the site with `?app=android` / `?app=ios`. `client/src/shell.js` remembers that for the session (sessionStorage, because Chrome shares storage between a TWA and the browser) and sets `<html data-shell>`.
   - In a store app, every purchase button and AdSense are hidden (Play Payments policy / App Store 3.1.1). Credits and Plus bought on the web still apply.
   - New public page `/delete-account` (required by Play). It has a `[support email]` placeholder to fill in.
   - Privacy policy now covers Google/Apple sign-in and the on-device camera.
   - The service worker caches `offline.html` and serves it when a page can't load. Verified by killing the server under a live page. Playwright's `setOffline` doesn't reach service-worker fetches, so e2e checks the cache instead.
   - `sw.js` is served with `no-cache`.
   - `capacitor.config.json` is ready for the iOS wrapper (remote-URL mode); nothing native is generated or installed.
   - **iOS blockers before submitting:** native push (APNs); Google sign-in is refused inside web views (needs a native plugin, or hide the button on iOS); guideline 4.2 risk. Details in `docs/IOS.md`.
   - **QA pass 4 (whole app, phone sizes, landscape, 320px)**: fixed in the commit after b398105.
     - A failed session check on first load (offline, server waking) no longer shows the landing page: the loader says it can't reach Kindred and retries every 4 s and on `online`. Only a server answer means signed out.
     - A blocked/ended chat no longer shows the partner as online and no longer offers Unsend/React.
     - Don't Smile keeps its score per conversation on the device (reload-safe; the two players can still disagree if one misses an event while offline). "I smiled" shows "Counted ✓" during the 4 s cooldown.
     - Landscape: game panels shrink to one row so the chat and composer stay on screen. Color picker fits 320px. Tap targets ≥44px for links, icon buttons and chips. Rush is brighter (#ff6aaa) for small-text contrast.
     - A bad `/verify#…` link explains itself on the sign-in screen. The paused screen links to the community rules. The topic survives a cancelled search. Support needs 5+ characters. The moderator stats fold away so the queues are first, and the tabs wrap.
     - Left as is: re-matching the same person in another mode reuses one thread (by design: one thread per pair; ask Jav if modes should get separate threads). The strike-over-onboarding and preview-mode social copy went to the other session (fixed in 4d81c4d).

5. **Staying signed in (2026-10-20, session 017tKMDq):** sessions now last 180 days and slide: the first request each day pushes the expiry back out (`server/src/auth.js`, `store.renewSession`). Sign out, sign out everywhere, a password reset or a suspension still end sessions at once. A device that has had an account (a `kindred.returning` flag in localStorage, never the email) opens on the Sign in tab after signing out; deleting the account clears the flag. **On Render, sessions only survive restarts with a real database (`DATABASE_URL`).** The free SQLite setup wipes accounts and sessions on every restart, which looks like being logged out.

## Decisions waiting on Jav

- **Email-first signup:** today, signup reveals whether an email already has an account.
- **Spanish UI:** the screener already handles Spanish.
- **A real age-assurance vendor.**
- **Pricing:** see `docs/LAUNCH.md`.
- **Legal review:** the privacy and terms pages are still marked Draft.
- **Store purchases:** keep connect credits web-only inside the store apps (current: hidden there), or add Play Billing / StoreKit.
- **Real keys before launch:** Stripe, Resend (email), Turnstile, VAPID push, AdSense, OpenAI moderation, `ERROR_WEBHOOK_URL`, Android signing fingerprint.

## Known gaps / next ideas

- **Game modes need two people at once.** On a quiet server a lone tester waits forever on the searching screen (it said nothing for 45 s, which looked like a black screen). After 6 s it now says so and offers a solo practice round and an invite link. Don't Smile's camera preview was a black box (stream attached to a different `<video>` than the one shown); fixed, and `e2e/smoke.mjs` now checks the preview really has the stream.
- **Linking a provider to an existing account** from Account is not built (sign in with the password instead). Also not built: Discord/Microsoft; the provider table in `server/src/social.js` is where they'd go.

- **Don't Smile:** detection is untested on a real face (CI uses a black fake camera). Add a round timer ("first to crack in 60s").
- **More modes:** Hot Takes, Two Truths and a Lie. Add the id to `MODES` in `server/src/matchmaker.js` and `client/src/games.js`, plus a panel component.
- **MediaPipe** pings `odml.pa.googleapis.com` with usage stats. The CSP blocks it on purpose, and e2e ignores that console line.
- **Re-sign-in** lands on home, not the chat you were in.

## Sandbox gotchas

- `pkill -f <pattern>` kills your own shell if the command line contains the pattern (exit 144). `ss -p` can't show pids here: find a stale local server with `ps -eo pid,args | grep server/src/index.js` and kill by pid. A stale server also serves an old `index.html` that points at deleted asset hashes (a blank page): restart it after every build.
- Outbound network is allow-listed, so the real Google/Apple/APIs can't be reached; use the fakes.

## Working with Jav

- He calls the assistant **Lidia**; call him **Jav**.
- Act as an advisor, not an assistant. Open by challenging an assumption, never with agreement.
- Tag claims [Certain]/[Likely]/[Guessing].
- Never say "Great question", "You're absolutely right", "That makes a lot of sense", "Absolutely" or "Definitely".
- He's usually on his phone: give short, numbered steps, and don't assume he has a terminal.
- Keep safety intact when he asks for edgy features. Reframe them; don't just refuse. For example, "make each other uncomfortable" became Cringe Duel, and the camera became on-device only.
