# Kindred: roadmap

Anonymous 1:1 texting for adults who need to talk. Tap "Talk to someone", get matched with a stranger, vent or listen. Keep chatting with past matches by their anonymous handle. Nobody learns who anyone is unless **both** people choose to connect.

Rules that don't bend: 18+ only. Reveal is mutual. Safety tooling ships before growth features.

## 1. Core (tonight, first)
- [x] Accounts with an anonymous handle (e.g. QuietHeron42), 18+ birthdate check and guidelines agreement at signup
- [x] Matchmaking queue: "I need to talk" / "I can listen" / "Either", optional topic; never re-match blocked pairs
- [x] Conversations + messages stored in the database; one thread per pair, so past matches can be continued
- [x] Realtime delivery over WebSocket (messages, typing, match found); REST for sending and history
- [x] Client: home, waiting room, chat, past conversations with unread counts

## 2. Safety
- [x] Block (ends chat, never matched again) and report (reason + conversation snapshot)
- [x] Message screening before delivery: contact info (phones, emails, @handles, links) held back until connected; age probing flagged; self-disclosed under-18 suspends the account for review
- [x] Crisis language shows the sender crisis resources (988 / findahelpline.com) without blocking them
- [x] Auto-suspend after reports from several different people; rate limits on matching and messaging
- [x] Moderator API (admin role): reports, held messages, suspend/restore; `npm run make-admin -- email`
- [x] Moderator screen in the app (reports with transcripts, held messages, suspend/restore); `ADMIN_EMAILS` config

## 3. Connect (the paid feature)
- [x] Either person can request to connect; reveal only when both have
- [x] Reveal shows a profile each person chose to share (name + optional contact), never email
- [x] Payment behind an interface; Stripe Checkout when keys exist, free in development

## 4. Polish
- [x] PWA: installable (manifest, icons, service worker) and web push for new messages and connect requests (handle only, never message text)
- [x] Back button / swipe-back navigation; load earlier messages
- [x] Account deletion (password-confirmed; personal data scrubbed now, safety data purged after 90 days) and JSON data export
- [x] Accessibility pass; reduced motion; chat text size (Account → Chat text size, per device)
- [x] Deployment: Dockerfile (tested: production mode, non-root, clean SIGTERM), Render Blueprint, docs/DEPLOY.md

## 5. Community & launch readiness
- [x] Kindred Plus subscription (monthly credits, more daily matches, Stripe customer portal); copy-paste spam detection
- [x] Optional ML screening (OpenAI moderation endpoint, free): threats, hate, sexual+minors; fails open
- [x] Link previews (Open Graph + share image); launch playbook (docs/LAUNCH.md)
- [x] "N people are waiting for someone to listen" banner with one-tap Be a listener (balances the two sides)
- [x] Message retention (MESSAGE_RETENTION_DAYS, default 365); calmer chat (actions on tap/hover)
- [x] Moderation ops: urgent-report emails to moderators, audit log of every moderator/automatic action, appeals from the paused screen
- [x] Private daily check-in (mood 1–5, two-week strip, low days offer a listener); exported, deleted with the account
- [x] Gentle reactions (💙 🫂 🙏) on the other person's messages; age-band matching preference; sign out everywhere; `npm run verify`
- [x] Unsend within 5 minutes (hidden for both; kept for moderators if reported)
- [x] Per-account login lockout; database-aware health check
- [x] First-run onboarding (3 cards, once per device) and listener tips
- [x] Owner dashboard on the Moderate screen: here now, active today, messages, matches, signups, members, "helped", connections, revenue
- [x] Conversation openers, phone-friendly Enter, "End conversation", desktop chat layout
- [x] Abuse resistance: daily cap on new matches; only reporters with day-old accounts count toward auto-pause
- [x] Texting basics: "Seen" receipts, unread count in the tab title, wait-time hint
- [x] Email confirmation (moderator rights require it)
- [x] Forgot password: emailed single-use, one-hour reset link (Resend, or the server log in development); signs out other sessions
- [x] "Did this help?" after chatting: thanks count ("You've helped 12 people") and a live thank-you for the listener
- [x] Live "people here now" count on home and in the waiting room
- [x] Privacy policy and terms pages at /privacy and /terms (DRAFTS: need legal review and the bracketed details filled in before launch)
- [x] Accessibility pass: axe-core audit of 8 screens in CI (`npm run a11y`, zero violations), dialog semantics, Escape to close, reduced motion
- [x] Ad slot on the home screen only (never inside chats), non-personalized, off unless `ADSENSE_CLIENT`/`ADSENSE_SLOT` are set; CSP opens for Google ad hosts only then
- [x] Load test (`scripts/load-test.js`): ~700 msg/s on one server; hot send path cut from 7 queries to 3
- [x] Listeners on call: opt-in push when someone has waited ~20s with nobody to listen (at most once per 3 hours per listener, never says who)
- [x] Moderator lookup by handle: status, report counts, held messages, action history, suspend/restore (no email shown)
- [x] Hide a conversation from your list (returns on a new message or a re-match)
- [x] Kind words: an optional 140-character note with "it helped", screened, shown anonymously on the listener's home screen, removable, exported
- [x] Support inbox: members write in from Account; moderators reply from Moderate → Inbox, emailed without the moderator seeing the address
- [x] Waiting room: optional paced breathing (4s in, 6s out); "Say goodbye…" drafts a kind sign-off
- [x] Ban evasion: a hashed device cookie; a new account on a suspended account's browser starts paused for review (survives the suspended account's deletion, lifted on restore)
- [x] Optional Cloudflare Turnstile bot check at signup (TURNSTILE_SITE_KEY/SECRET_KEY), verified server-side
- [ ] Scale past one server: Redis pub/sub for realtime + shared queue (only needed beyond several thousand concurrent chatters)

## Known limits
- Matchmaking and realtime run in one Node process. Past ~1 server, add Redis pub/sub.
