# Kindred on the App Store (iOS)

Apple doesn't accept Trusted Web Activities, so iOS needs a thin native wrapper. This repo is set up
for **Capacitor** in "remote URL" mode: the iOS app opens the live site (`capacitor.config.json` →
`server.url`), so website updates reach iPhone users instantly. Nothing here is submitted yet; this
is the checklist for when Jav has an Apple Developer account ($99/year) and a Mac.

## Build it (on a Mac with Xcode)

```bash
npm i -D @capacitor/cli@7 && npm i @capacitor/core@7 @capacitor/ios@7
# edit capacitor.config.json: server.url → https://YOUR-DOMAIN/?app=ios
npm run build && npx cap add ios && npx cap open ios
```

In Xcode (`ios/App/App/Info.plist`) add:
- `NSCameraUsageDescription`: "Don't Smile uses your camera on this phone only, to notice when you smile. Nothing is recorded or sent."
- `WKAppBoundDomains`: your domain (pairs with `limitsNavigationsToAppBoundDomains`).
- App icon: export `client/public/icon.svg` at 1024×1024, no transparency.

## What the app already does for Apple's rules

| Guideline | Status |
| --- | --- |
| 1.2 User-generated content: terms agreed at signup, filtering, report, block, timely moderation | Done (screener, report in every chat menu, block, moderator queue, `docs/MODERATION.md`) |
| 1.4.1 / mental health: no medical claims | Copy says "peer support", 988 shown on crisis language. Keep it that way in the listing |
| 3.1.1 In-app purchase: digital goods must use IAP | Nothing is sold (talking and connecting are free), so no IAP is needed. AdSense is hidden when opened with `?app=ios` (`client/src/shell.js`) |
| 4.8 Sign in with Apple when other social logins exist | Built (server side), turns on with Apple keys; see `docs/DEPLOY.md` |
| 5.1.1(v) Account deletion in the app | Account → Delete account; public steps at `/delete-account` |
| 5.1.2 Privacy: policy URL, App Privacy answers | `/privacy` (still marked Draft; needs a lawyer). Data list is in it |
| Age rating | 18+ (unrestricted user chat). The signup age gate stays |

## Must fix before submitting

1. **Push notifications.** Web push doesn't work inside an iOS app wrapper. Add
   `@capacitor/push-notifications` and send via APNs (server: a second sender next to
   `server/src/push.js`). Without it, iPhone users of the app get no reply notifications.
2. **Google sign-in inside the app.** Google blocks its sign-in page in embedded web views
   ("disallowed_useragent"). Either use a native Google sign-in plugin, or hide the Google button
   when `appShell() === 'ios'` and rely on Apple + email.
3. **Guideline 4.2 (minimum functionality).** A site in a frame can be rejected. What helps: native
   push (above), the camera game, and haptics on match. Mention them in the review notes.
4. **Reviewer access.** Reviewers test alone. Give them two demo accounts in App Store Connect's
   review notes and point them to the solo practice round in the game modes, so they can see
   matching and chat without a second person.

## Not needed

- No tracking, so no App Tracking Transparency prompt (AdSense stays off in the iOS app unless
  that changes; if ads are added, ATT and the privacy answers change too).
