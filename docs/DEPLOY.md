# Deploying Kindred

Kindred is one Node process: API, WebSocket and the built web app on one port. It needs:

1. **A host that keeps a process running and allows WebSockets:** Render, Fly.io, Railway, or any VPS with Docker. Serverless platforms (Vercel, Netlify functions) can't hold the realtime connections.
2. **Postgres.** SQLite works for a single machine with a persistent disk, but managed Postgres is easier to back up.
3. **One instance**, for now. Matchmaking and live delivery live in memory, so two instances would split users into two pools. Scaling out needs Redis pub/sub (see the roadmap).

## Option A: Render (simplest)

1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint** and select the repo. `render.yaml` creates the web service and a Postgres database and wires `DATABASE_URL` for you.
3. When prompted, fill in:
   - `ADMIN_EMAILS`: your email, so you can moderate. You become a moderator after confirming that email from the link Kindred sends, so set up email (below) first.
   - `PUBLIC_URL`: your site's address, e.g. `https://kindred.example.com`. It's required in production. Emailed links and Stripe redirects never trust the request's Host header.
   - `VAPID_*`: run `npm run vapid` locally and paste the three lines (optional, enables notifications).
   - `STRIPE_*`: see "Payments" below (optional; connecting is free without it).
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

## Database: Supabase or Neon

Use the connection string with SSL:

- **Neon:** `postgres://…/neondb?sslmode=require`
- **Supabase:** Project Settings → Database → connection string (session pooler or direct). Supabase uses its own certificate authority, so either append `?sslmode=no-verify` or set `DATABASE_SSL_NO_VERIFY=true`. Verifying with their CA is safer if you're comfortable downloading it.

## Email (password reset)

Create a [Resend](https://resend.com) account, verify your sending domain, and set `RESEND_API_KEY`, `MAIL_FROM` (for example `Kindred <no-reply@yourdomain.com>`) and `PUBLIC_URL` (your site's address, used in the emailed link). Without these, reset links are only printed to the server log, which is fine for testing but useless for real users.

## Payments (Connect)

1. Create a Stripe account and copy the **secret key** into `STRIPE_SECRET_KEY`.
2. Stripe Dashboard → Developers → Webhooks → **Add endpoint**: `https://<your-domain>/api/billing/webhook`, event `checkout.session.completed`. Copy its **signing secret** into `STRIPE_WEBHOOK_SECRET`.
3. Optional: `CONNECT_PRICE_CENTS` (default `999`) and `CONNECT_CURRENCY` (default `usd`).
4. Test with Stripe's test keys and card `4242 4242 4242 4242` before switching to live keys.

Both keys must be set for payments to turn on. Until then, connecting is free.

## Logs

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
| Postgres | ~710 | 254 ms | 540 ms | 807 ms |
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
- [ ] Someone is checking the moderation queue daily (reports of minors and threats first)
- [ ] Database backups enabled (Render and Neon do daily backups on paid plans)
- [ ] Privacy policy and terms published (age requirement, what's stored, 90-day retention for deleted accounts, how reports work)
- [ ] Payments tested end to end in Stripe test mode
