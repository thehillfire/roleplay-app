# Deploying Kindred

Kindred is one Node process: API, WebSocket and the built web app on one port. It needs:

1. **A host that keeps a process running and allows WebSockets:** Render, Fly.io, Railway, or any VPS with Docker. Serverless platforms (Vercel, Netlify functions) can't hold the realtime connections.
2. **Postgres.** SQLite works for a single machine with a persistent disk, but managed Postgres is easier to back up.
3. **One instance**, for now. Matchmaking and live delivery live in memory, so two instances would split users into two pools. Scaling out needs Redis pub/sub (see the roadmap).

## Option A: Render (simplest)

1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint** and select the repo. `render.yaml` creates the web service and a Postgres database and wires `DATABASE_URL` for you.
3. When prompted, fill in:
   - `ADMIN_EMAILS`: your email, so you can moderate.
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

## Payments (Connect)

1. Create a Stripe account and copy the **secret key** into `STRIPE_SECRET_KEY`.
2. Stripe Dashboard → Developers → Webhooks → **Add endpoint**: `https://<your-domain>/api/billing/webhook`, event `checkout.session.completed`. Copy its **signing secret** into `STRIPE_WEBHOOK_SECRET`.
3. Optional: `CONNECT_PRICE_CENTS` (default `999`) and `CONNECT_CURRENCY` (default `usd`).
4. Test with Stripe's test keys and card `4242 4242 4242 4242` before switching to live keys.

Both keys must be set for payments to turn on. Until then, connecting is free.

## Before inviting real users

- [ ] HTTPS on your domain
- [ ] `ADMIN_EMAILS` set, and you've signed in and seen **Moderate**
- [ ] Someone is checking the moderation queue daily (reports of minors and threats first)
- [ ] Database backups enabled (Render and Neon do daily backups on paid plans)
- [ ] Privacy policy and terms published (age requirement, what's stored, 90-day retention for deleted accounts, how reports work)
- [ ] Payments tested end to end in Stripe test mode
