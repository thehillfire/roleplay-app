# Launching Kindred

What's left between this repo and real users, in order. The code side is done and tested; everything below needs your accounts, money or judgment.

## Day 1: get it running (about 2 hours)

1. **Domain.** Buy one (Namecheap, Cloudflare). You'll point it at the host in step 2.
2. **Host + database.** Render → New → Blueprint → this repo (see [DEPLOY.md](DEPLOY.md)). That creates the server and a Postgres database. Starter plans are about $7/month each.
3. **Email (Resend).** Free tier covers 3,000 emails/month. Verify your domain, then set `RESEND_API_KEY`, `MAIL_FROM` and `PUBLIC_URL`. Without email, password resets and moderator setup won't work.
4. **You as moderator.** Set `ADMIN_EMAILS` to your email, sign up, click the confirmation link, and you'll see **Moderate**.
5. **Notifications.** Run `npm run vapid` locally and paste the three values into Render.
6. **Smoke test on your phone.** Sign up on two devices (or one phone + one laptop), match, chat, report, connect. Add it to your home screen.

## Before inviting anyone (a week, mostly not code)

- **Legal review.** `/privacy` and `/terms` are drafts with bracketed gaps. An app where strangers talk about mental health, with adults only and paid reveals, needs a lawyer's eyes once, especially for the age rules, the 90-day safety retention and the refund policy. Budget a few hundred dollars for a startup-package review.
- **Company.** An LLC keeps your personal assets separate if something goes wrong. Stripe also wants a business entity.
- **Stripe.** Create the account, run a test purchase with card `4242 4242 4242 4242`, then switch to live keys. See DEPLOY.md for the webhook.
- **Moderation coverage.** Decide who checks the queue and when. Urgent reports (possible minors, people at risk) email every moderator, and someone should look at those within hours, not days. At first that's you. Plan for a second moderator before you pass about 500 daily users.
- **Crisis line partnership (optional, strong).** Organizations like Crisis Text Line partner with apps. Being able to say "we work with X" builds trust with users, app stores and press.

## Pricing: my recommendation

- **Keep talking free, forever.** The free chat is the product and the growth engine.
- **Connect at $4.99 to start, not $10.** [Guessing] At $10, few people will pay to learn the name of someone they met an hour ago. At $4.99 it's an impulse buy, and the credit comes back if they decline, which makes the "yes" feel safe. Raise it once you see demand. `CONNECT_PRICE_CENTS=499`.
- **Ads: wait.** Turn on AdSense only after you have steady traffic (AdSense often rejects new sites with little traffic), and keep it non-personalized (the default here).
- **Kindred Plus subscription: built.** $4.99/month (`PLUS_PRICE_CENTS`) for 3 connect credits a month and 3× the daily new-match limit. Subscriptions are more predictable than one-off purchases. Next idea: an annual plan at about two months free.

## Where the first users come from

- **Reddit:** communities like r/offmychest, r/lonely, r/KindVoice and r/needafriend. Follow each sub's self-promotion rules. One honest post ("I built a free, anonymous place to talk on your lunch break, adults only, moderated") beats ten ads.
- **TikTok/Reels:** short "this is what it feels like to vent to a stranger who's kind" clips. Use the share image and tagline.
- **Listeners first.** Recruit 20–50 people who like helping (nursing students, peer-support volunteers, your own friends) before you launch to talkers. The "N people are waiting for a listener" banner works best when someone answers it.

## Numbers to watch (Moderate screen)

| Metric | Healthy early sign |
| --- | --- |
| Active today / Members | 15%+ means people come back |
| Messages per new match | 10+ means real conversations happen |
| "Helped" votes this week | Growing week over week |
| Open reports | Cleared within a day |
| Connections made → Revenue | Your monetization signal |

## Biggest risks, honestly

1. **Minors getting in.** The birthdate check is self-reported. The screener, reports and auto-pause catch a lot, but not everything. If you get traction, add real age assurance (Yoti, Persona, Stripe Identity) before a journalist tests it for you.
2. **Someone in crisis.** The app shows 988 resources and alerts moderators, but listeners are strangers. Make that clear (it's in the terms and onboarding) and never market Kindred as therapy.
3. **Moderation load outgrowing you.** Watch report volume. The rules-based screener is a first line. Set `OPENAI_API_KEY` to add OpenAI's free moderation endpoint as a second opinion on every message.
4. **One server.** Fine for several thousand people chatting at once (see DEPLOY.md load test). Past that, the roadmap's Redis item is next.

## What's in the box

Everything listed in the [README](../README.md):
- **Core:** accounts, anonymous matching, realtime chat (reactions, unsend, Seen), daily check-ins, PWA install.
- **Listeners:** kind words, on-call notifications, a breathing exercise while you wait.
- **Safety:** screening, reports and appeals, a moderator dashboard with handle lookup and a support inbox.
- **Money:** paid mutual connect and Kindred Plus.
- **Privacy:** push notifications that never show message text, data export and deletion.
- **Shipping:** deployment files, 105 automated tests, and a two-browser end-to-end test running in CI.
