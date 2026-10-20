# Deploying Kindred

Kindred is one Node process: API, WebSocket and the built web app on one port. It needs:

1. **A host that keeps a process running and allows WebSockets:** Render, Fly.io, Railway, or any VPS with Docker. Serverless platforms (Vercel, Netlify functions) can't hold the realtime connections.
2. **Postgres.** SQLite works for a single machine with a persistent disk, but managed Postgres is easier to back up.
3. **One instance**, for now. Matchmaking and live delivery live in memory, so two instances would split users into two pools. Scaling out needs Redis pub/sub (see the roadmap).

## Option A: Render (simplest)

1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint** and select the repo. `render.yaml` creates the web service and a Postgres database and wires `DATABASE_URL` for you.
3. When prompted, fill in:
   - `ADMIN_EMAILS`: your email, so you can moderate. Sign up, then use **Forgot password?** once. Completing that reset makes you a moderator, so set up email (below) first. Without email, run `npm run make-admin -- you@example.com` from the server's shell instead.
   - `PUBLIC_URL`: your site's address, e.g. `https://kindred.example.com`. It's required in production. Emailed links never trust the request's Host header.
   - `VAPID_*`: run `npm run vapid` locally and paste the three lines (optional, enables notifications).
   - `TEST_LOGINS` (testing only): e.g. `a:a,b:b` lets you sign in with the name `a` and password `a` (and `b`/`b` on a second phone, to match with yourself). Each name is an ordinary member account. Anyone who knows it can use it, so **delete this variable before launch**. Also handy for store reviewers' demo accounts, with long random passwords.
4. Deploy. Tables are created on first start. Open the URL, sign up with your admin email, and you'll see **Moderate** on the home screen.

Plan names and prices change. If Render rejects `plan: starter` or `plan: basic-256mb`, pick the current equivalents in the dashboard.

## Option B: Docker anywhere

```bash
docker build -t kindred .
docker run -d --name kindred -p 3000:3000 \
  -e DATABASE_URL='postgres://…' \
  -e ADMIN_EMAILS='you@example.com' \
  kindred
```

Without `DATABASE_URL`, data goes to SQLite at `/app/data/kindred.db`. Mount a volume (`-v kindred-data:/app/data`) or it's lost when the container is replaced. Put it behind HTTPS (Caddy, nginx, or your platform's load balancer). Sessions use `Secure` cookies in production, and browsers only allow notifications and installs over HTTPS.

`TRUST_PROXY` (default `1`) is how many proxies sit in front of Node. Keep 1 behind one proxy (Caddy, nginx, Render). If port 3000 is reachable directly from the internet, set `TRUST_PROXY=0`. Otherwise anyone can send a fake `X-Forwarded-For` header and slip past the rate limits.

## Database: Supabase or Neon

Use the connection string with SSL:

- **Neon:** `postgres://…/neondb?sslmode=require`
- **Supabase:** Project Settings → Database → connection string (session pooler or direct). Supabase uses its own certificate authority, so either append `?sslmode=no-verify` or set `DATABASE_SSL_NO_VERIFY=true`. Verifying with their CA is safer if you're comfortable downloading it.

## Email (password reset)

Create a [Resend](https://resend.com) account, verify your sending domain, and set `RESEND_API_KEY`, `MAIL_FROM` (for example `Kindred <no-reply@yourdomain.com>`) and `PUBLIC_URL` (your site's address, used in the emailed link). Without these, emails are printed to the server log in development. In production they are dropped with a warning, since they contain sign-in links.

## Bot protection (recommended)

Anonymous chat apps attract spam bots. Kindred supports Cloudflare Turnstile at signup, which is free and usually invisible to people.
1. In the Cloudflare dashboard, open **Turnstile** and add a widget for your domain.
2. Set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.

The signup form then shows the check, the server verifies every token, and the Content Security Policy opens for `challenges.cloudflare.com` only. If Cloudflare can't be reached, signups are let through and a warning is logged.

## Sign in with Google / Apple

Each provider switches on when its keys are set. Until then, production shows it as a disabled "coming soon" button with its logo (`SOCIAL_PREVIEW=0` hides those). `PUBLIC_URL` must be set too, because the provider sends people back to `PUBLIC_URL/auth/callback/<provider>`.

**Google** (free)
1. In [Google Cloud Console](https://console.cloud.google.com), create a project, then **APIs & Services → OAuth consent screen** (External; app name Kindred; your support email).
2. **Credentials → Create credentials → OAuth client ID → Web application.** Under **Authorised redirect URIs** add `https://YOUR-SITE/auth/callback/google` (exactly; it must match `PUBLIC_URL`).
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. While the consent screen is in *Testing*, only test users you add can sign in; **Publish app** when you're ready (email-only scopes need no review).

**Apple** (needs the paid Apple Developer Program, $99/year)
1. Create an **App ID** with Sign in with Apple, then a **Services ID** (this is `APPLE_CLIENT_ID`). Under it, add your domain and the return URL `https://YOUR-SITE/auth/callback/apple`.
2. Create a **Key** with Sign in with Apple and download the `.p8` once.
3. Set `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` (the `.p8` text; `\n` for line breaks is fine).

Kindred only ever stores the provider's account id and the verified email; never a name, photo or token. Rules the code enforces:
- **18+ still applies.** A new account sends its birthdate and agreement before leaving for the provider; an under-18 answer is refused and the device flagged, exactly like email sign-up.
- **No merging.** If the email already belongs to an account, the person is told to sign in with their password. Nothing is linked automatically.
- **No moderator rights from a provider sign-in.** `ADMIN_EMAILS` are still only granted after a password reset.
- **Deleting an account without a password** asks the person to confirm with the provider again first.

`SOCIAL_PREVIEW` controls the "coming soon" buttons for providers without keys: on by default in production, off elsewhere; `1` forces them on, `0` off. Not verified against the real Google and Apple services (they can't be reached from the test environment): the browser test `e2e/social.mjs` drives the whole flow against a fake provider, so the first real sign-in is the one thing left to try by hand.

## Payments

None. Kindred sells nothing: talking and connecting are free, so there are no payment keys to set up. The only revenue is optional AdSense on the website's home screen (`ADSENSE_CLIENT` / `ADSENSE_SLOT`), which the store apps hide.

## Logs

**Error alerts (recommended):** create a Slack or Discord *incoming webhook* and set `ERROR_WEBHOOK_URL`. Server errors (5xx, failed background jobs) post a one-line alert with the error type and route, never request data or message text. The same error posts at most once every 10 minutes, and at most 20 alerts are sent per hour.


Each API request logs one JSON line: time, method, route (ids collapsed to `:id`), status and duration. Bodies and query strings are never logged, because they can contain message text or reset tokens. Set `REQUEST_LOG=off` to silence it.

## App stores

Kindred is an installable web app (PWA), so people can already "Add to Home Screen". To list it in the stores without writing a native app:

- **Google Play:** go to [PWABuilder](https://www.pwabuilder.com), enter your live URL, and download the Android package (a Trusted Web Activity). Upload it in the Play Console. PWABuilder also produces the `assetlinks.json` file. Serve it at `/.well-known/assetlinks.json` (put it in `client/public/.well-known/`).
- **Apple App Store:** Apple rejects apps that are just a website in a wrapper, so a store listing there needs a native shell with real native features (push via APNs, etc.). Until then, iPhone users install from Safari (Share → Add to Home Screen), which supports web push on iOS 16.4+.
- Both stores require in-app account deletion (done: Account → Delete account) and a privacy policy URL (`/privacy`, once it's been reviewed). Both rate dating and "chat with strangers" apps strictly. Expect questions about moderation, and point to the report flow, held-message filters and 18+ checks.

## How much one server handles

`scripts/load-test.js` signs up N simulated people, matches them in pairs and has everyone send messages as fast as they can. On a small cloud container (one server process, local Postgres with a 10-connection pool), 200 people sending 2,000 messages flat out gave:

| Database | Messages/second | Median send | p95 | p99 |
| --- | --- | --- | --- | --- |
| Postgres | ~714 | 262 ms | 400 ms | 598 ms |
| SQLite (WAL) | ~780 | 165 ms | 334 ms | ~2 s (checkpoint stalls) |

That's a worst case. Real people send about one message every 10 seconds, so one server comfortably covers **several thousand people chatting at the same time**. Use Postgres in production (no stalls, backups, managed). If median send time creeps up under load, raise `DATABASE_POOL_MAX` (default 5) to 10–20. Run it yourself:

```bash
DAILY_MATCH_LIMIT=1000 npm start            # in one terminal
node scripts/load-test.js http://localhost:3000 200 10
```

## Before inviting real users

- [ ] HTTPS on your domain
- [ ] Password reset email arrives (`RESEND_API_KEY`, `MAIL_FROM`, `PUBLIC_URL`)
- [ ] `ADMIN_EMAILS` set, and you've signed in and seen **Moderate**
- [ ] `TEST_LOGINS` removed (or only long random reviewer passwords left)
- [ ] Someone is checking the moderation queue daily (reports of minors and threats first)
- [ ] Database backups enabled (Render and Neon do daily backups on paid plans)
- [ ] Privacy policy and terms published (age requirement, what's stored, 90-day retention for deleted accounts, how reports work)
