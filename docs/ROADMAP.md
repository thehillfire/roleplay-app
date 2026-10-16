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
- [ ] Accessibility pass; reduced motion; text size
- [x] Deployment: Dockerfile (tested: production mode, non-root, clean SIGTERM), Render Blueprint, docs/DEPLOY.md

## Known limits
- Matchmaking and realtime run in one Node process. Past ~1 server, add Redis pub/sub.
