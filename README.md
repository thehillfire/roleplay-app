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
| `npm run verify` | Everything CI checks, in one go: tests, build, a throwaway server, e2e and accessibility |
| `npm test` | Server tests on in-memory SQLite |
| `npm run test:pg` | Same tests on Postgres (`TEST_DATABASE_URL=postgres://…`) |
| `npm run e2e` | Two-browser smoke test against a running server (`BASE_URL`, `CHROMIUM_PATH`) |
| `npm run a11y` | axe-core accessibility audit of every main screen against a running server |

## How it works

```
client/   React + Vite web app (mobile-first)
server/   Express API + WebSocket server, matchmaking, storage
e2e/      Playwright test: two strangers sign up, match and chat
```

- **Accounts:** email + password (scrypt), 18+ birthdate check and guidelines agreement at signup. Each user gets a random anonymous handle. Email is never sent to other users or back to the client. Sessions are random tokens in an httpOnly cookie, stored hashed.
- **Password reset:** "Forgot password?" emails a single-use link valid for one hour, via Resend if `RESEND_API_KEY` is set, otherwise printed to the server log. The answer is the same whether or not the email has an account. The token travels after `#`, so it never reaches server logs. Resetting signs out every other session.
- **Matching:** `I need to talk` pairs with `I can listen`; `Either` pairs with anyone. Two talkers (or two listeners) pair up after 30 seconds so nobody waits forever. Shared topics are preferred, then people in the same age band (18–24, 25–34, 35–49, 50+; never shown to anyone), and new people over past partners. Blocked pairs never match.
- **Conversations:** one thread per pair, so matching someone again (or opening them from your list) continues where you left off. Messages are sent over REST and pushed live over the WebSocket, along with typing and match events.
- **Daily check-in:** a private "How are you feeling today?" (1–5) on home with a two-week strip. Only the person sees it. A rough day offers "Talk to someone now". It's included in exports and deleted with the account.
- **Encouragement:** once both people have sent at least two messages, each sees "Did talking with them help?". A yes sends the listener a live thank-you, and home shows "You've helped N people" (distinct people). Home also shows how many people are here right now. When people are waiting to talk, it says so with a one-tap **Be a listener**, which helps keep enough listeners around.
- **Safety:** every message is screened before delivery (`server/src/moderation.js`). Contact details are held back until both people connect. Asking someone's age and sexual solicitation are held. A message saying the sender is under 18 is held and pauses their account for review. Crisis language is still delivered, but the sender gets 988 / findahelpline resources and the listener gets guidance. Held messages are shown to the sender with the reason, and to moderators. Block ends a chat for good. Report snapshots the last 30 messages, blocks, and auto-pauses anyone reported by 3 different people in a week (2 for "under 18"). Only reporters whose accounts were at least a day old count toward that, so throwaway accounts can't brigade. Everyone can meet at most `DAILY_MATCH_LIMIT` (default 40) new people a day, so trolls can't cycle through strangers.
- **Connect (paid, mutual):** either person can ask to connect by entering what they'd share (first name, optional contact). Nothing is revealed unless the other person accepts with their own details. "Stay anonymous" is final. Once connected, contact details are no longer held back. With Stripe configured, sending a request uses one credit bought through Stripe Checkout (default $9.99). Accepting is free, and a declined or cancelled request returns the credit. Without Stripe keys, connecting is free.
- **Email confirmation:** signup emails a confirmation link (valid 7 days). People can chat before confirming. Completing a password reset also counts as confirming.
- **Moderation:** list moderator emails in `ADMIN_EMAILS`. They become moderators only once that email is **confirmed**, so registering the owner's address first gets an attacker nothing. Or run `npm run make-admin -- you@example.com`. Moderators see a **Moderate** link with today's numbers (here now, active today, messages, matches, signups, members, "helped", connections, revenue), open reports (the full recent transcript), held messages, appeals from paused accounts, an audit log of every moderator and automatic action, and suspend/restore buttons. Urgent reports ("under 18", "worried about their safety") and automatic pauses email every confirmed moderator right away. The email never includes message text. They also get the API: `GET /api/admin/stats`, `GET /api/admin/log`, `GET /api/admin/appeals`, `POST /api/admin/appeals/:id/resolve { restore }`, `GET /api/admin/reports`, `POST /api/admin/reports/:id/resolve { resolution: dismissed|warned|suspended }`, `GET /api/admin/held` and `POST /api/admin/users/:id/status`.
- **Phone app:** Kindred is a PWA. "Add to Home Screen" installs it with its own icon. With VAPID keys set (`npm run vapid`), people can turn on notifications. When someone isn't in the app, a new message or connect request triggers a push that shows only "New message from QuietHeron42", never the text, because lock screens are visible to anyone nearby. Signing out unsubscribes that device.
- **Your data:** Account → *Download my data* exports everything you can see as JSON. *Delete account* (password-confirmed) immediately scrubs email, password, birthdate and anything revealed through Connect, signs out everywhere, and tells chat partners you left. Messages and reports are kept for `DELETED_RETENTION_DAYS` (default 90) so moderators can finish safety reviews, then a daily job purges them.
- **Ads:** set `ADSENSE_CLIENT` and `ADSENSE_SLOT` to show one AdSense unit on the home screen. Ads never appear inside conversations, and they're requested non-personalized, so visits aren't used to build ad profiles of people having a hard time. The Content Security Policy only allows Google's ad hosts while ads are configured.
- **Security:** login attempts are limited per IP and per account (10 wrong passwords lock that account for 15 minutes, from any IP). `/api/health` checks the database, so load balancers stop sending traffic to a server that lost it. JSON-only mutating requests (CSRF guard), origin check on the WebSocket handshake, rate limits on auth and messages, per-socket flood guard, and conversation membership checked on every read and write.

## API

- `POST /api/auth/signup { email, password, birthdate, agree }`, `POST /api/auth/login | logout`, `GET /api/auth/me`
- `POST /api/auth/forgot { email }`, `POST /api/auth/reset { token, password }`, `POST /api/auth/verify { token }`, `POST /api/auth/resend-verification`
- `GET /api/conversations`: your threads, with partner handle, online flag, last message and unread count
- `GET /api/conversations/:id?before=<ms>&beforeId=<id>`: messages, newest 50 (cursor is the oldest message you have)
- `POST /api/conversations/:id/messages { body }`, `POST /api/conversations/:id/read`, `POST /api/conversations/:id/messages/:messageId/unsend` (within 5 minutes), `POST /api/conversations/:id/messages/:messageId/react { reaction: 💙|🫂|🙏|null }`
- `POST /api/conversations/:id/feedback { helpful }`, `GET /api/presence`, `GET/POST /api/checkins { day, mood }`
- `POST /api/conversations/:id/block`, `POST /api/conversations/:id/report { reason, details? }`
- `POST /api/conversations/:id/connect { name, contact? }` (request or accept), `…/connect/decline`, `…/connect/cancel`
- `GET /api/account/export`, `POST /api/account/delete { password }`, `GET/POST /api/appeal { message }` (paused accounts)
- `POST /api/billing/checkout` → Stripe Checkout URL. `POST /api/billing/webhook` (Stripe, signature-verified, idempotent)
- WebSocket `/ws`. Send `match.join { role, topic }`, `match.leave`, `typing { conversationId }`. Receive `match.waiting`, `match.found`, `presence`, `message`, `message.unsent`, `message.reacted`, `typing`, `read`, `conversation.ended`, `connect.updated`, `thanks`, `credits.updated`.

## Deploying

Kindred needs a host that keeps a Node process running with WebSockets (Render, Fly.io, Railway, any Docker host) plus Postgres. A `Dockerfile` and a Render Blueprint (`render.yaml`) are included. See **[docs/DEPLOY.md](docs/DEPLOY.md)** for step-by-step setup, Stripe, Supabase/Neon, and a pre-launch checklist.
