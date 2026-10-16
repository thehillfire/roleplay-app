# Kindred

Anonymous 1:1 texting for adults who need to talk. Tap **Talk to someone**, get matched with a kind stranger, vent or listen. Keep chatting with past matches by their anonymous handle (like `QuietHeron42`). Nobody learns who anyone is unless both people choose to connect.

Roadmap and status: [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Quick start

```bash
npm install
npm run dev        # API + WebSocket on :3000, app on http://localhost:5173
```

No keys needed (see `.env.example` for optional Postgres and Stripe settings). Data goes to SQLite at `data/kindred.db` unless `DATABASE_URL` points at Postgres.

| Script | What it does |
| --- | --- |
| `npm run dev` | Server (auto-restart) + Vite dev server, proxying `/api` and `/ws` |
| `npm run build` | Builds the web app into `dist/` |
| `npm start` | Serves API, WebSocket and the built app on one port (3000) |
| `npm test` | Server tests on in-memory SQLite |
| `npm run test:pg` | Same tests on Postgres (`TEST_DATABASE_URL=postgres://…`) |
| `npm run e2e` | Two-browser smoke test against a running server (`BASE_URL`, `CHROMIUM_PATH`) |

## How it works

```
client/   React + Vite web app (mobile-first)
server/   Express API + WebSocket server, matchmaking, storage
e2e/      Playwright test: two strangers sign up, match and chat
```

- **Accounts:** email + password (scrypt), 18+ birthdate check and guidelines agreement at signup. Each user gets a random anonymous handle. Email is never sent to other users or back to the client. Sessions are random tokens in an httpOnly cookie, stored hashed.
- **Matching:** `I need to talk` pairs with `I can listen`; `Either` pairs with anyone. Two talkers (or two listeners) pair up after 30 seconds so nobody waits forever. Shared topics are preferred, new people are preferred over past partners, and blocked pairs never match.
- **Conversations:** one thread per pair, so matching someone again (or opening them from your list) continues where you left off. Messages are sent over REST and pushed live over the WebSocket, along with typing and match events.
- **Safety:** every message is screened before delivery (`server/src/moderation.js`). Contact details are held back until both people connect. Asking someone's age and sexual solicitation are held. A message saying the sender is under 18 is held and pauses their account for review. Crisis language is still delivered, but the sender gets 988 / findahelpline resources and the listener gets guidance. Held messages are shown to the sender with the reason, and to moderators. Block ends a chat for good. Report snapshots the last 30 messages, blocks, and auto-pauses anyone reported by 3 different people in a week (2 for "under 18").
- **Connect (paid, mutual):** either person can ask to connect by entering what they'd share (first name, optional contact). Nothing is revealed unless the other person accepts with their own details. "Stay anonymous" is final. Once connected, contact details are no longer held back. With Stripe configured, sending a request uses one credit bought through Stripe Checkout (default $9.99). Accepting is free, and a declined or cancelled request returns the credit. Without Stripe keys, connecting is free.
- **Moderation:** list moderator emails in `ADMIN_EMAILS` (or run `npm run make-admin -- you@example.com`). Moderators see a **Moderate** link with open reports (the full recent transcript), held messages, and suspend/restore buttons. They also get the API: `GET /api/admin/reports`, `POST /api/admin/reports/:id/resolve { resolution: dismissed|warned|suspended }`, `GET /api/admin/held` and `POST /api/admin/users/:id/status`.
- **Phone app:** Kindred is a PWA. "Add to Home Screen" installs it with its own icon. With VAPID keys set (`npm run vapid`), people can turn on notifications. When someone isn't in the app, a new message or connect request triggers a push that shows only "New message from QuietHeron42", never the text, because lock screens are visible to anyone nearby. Signing out unsubscribes that device.
- **Your data:** Account → *Download my data* exports everything you can see as JSON. *Delete account* (password-confirmed) immediately scrubs email, password, birthdate and anything revealed through Connect, signs out everywhere, and tells chat partners you left. Messages and reports are kept for `DELETED_RETENTION_DAYS` (default 90) so moderators can finish safety reviews, then a daily job purges them.
- **Security:** JSON-only mutating requests (CSRF guard), origin check on the WebSocket handshake, rate limits on auth and messages, per-socket flood guard, and conversation membership checked on every read and write.

## API

- `POST /api/auth/signup { email, password, birthdate, agree }`, `POST /api/auth/login | logout`, `GET /api/auth/me`
- `GET /api/conversations`: your threads, with partner handle, online flag, last message and unread count
- `GET /api/conversations/:id?before=<ms>`: messages, newest 50
- `POST /api/conversations/:id/messages { body }`, `POST /api/conversations/:id/read`
- `POST /api/conversations/:id/block`, `POST /api/conversations/:id/report { reason, details? }`
- `POST /api/conversations/:id/connect { name, contact? }` (request or accept), `…/connect/decline`, `…/connect/cancel`
- `GET /api/account/export`, `POST /api/account/delete { password }`
- `POST /api/billing/checkout` → Stripe Checkout URL. `POST /api/billing/webhook` (Stripe, signature-verified, idempotent)
- WebSocket `/ws`. Send `match.join { role, topic }`, `match.leave`, `typing { conversationId }`. Receive `match.waiting`, `match.found`, `message`, `typing`, `conversation.ended`.

## Deploying

Kindred needs a host that keeps a Node process running with WebSockets, such as Render, Fly.io or Railway. Serverless platforms like Vercel can't hold the sockets. Set `DATABASE_URL` to a Postgres database (Supabase, Neon, Render Postgres). Tables are created on first start. Matchmaking and live delivery run inside one server process; to run several, add Redis pub/sub (see roadmap).
