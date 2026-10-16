# Kindred on Google Play

Kindred ships to Android as a **Trusted Web Activity (TWA)**: a small Android app that opens the
live site full-screen in Chrome's engine. It's Google's recommended way to put a web app in the
Play Store. Push notifications, sign-in and the installable-app features keep working, and every
update to the site reaches the app instantly, with no new Play release needed.

(A plain WebView wrapper would lose web push, and a React Native rewrite would take weeks. The TWA is
the right first version.)

## What you need

- The site deployed on HTTPS with its real domain (see `DEPLOY.md`). The app opens that URL.
- A **Google Play developer account**: one-time $25 at <https://play.google.com/console/signup>.
  New personal accounts must run a closed test with at least 12 testers for 14 days before
  production. Plan for that.
- About an hour.

## 1. Build the Android package (no Android Studio needed)

Easiest: **PWABuilder** (Microsoft's free tool).

1. Go to <https://www.pwabuilder.com>, enter your site URL, and pick **Package for stores → Android**.
2. Settings:
   - Package ID: `app.kindred.twa` (or your own; it can never change after the first upload).
   - App name: Kindred · Launcher name: Kindred.
   - Theme and background color: `#0b0a10`. Navigation bar color: `#0b0a10`.
   - Display: standalone · Orientation: portrait.
   - **Signing key: "Create new".** Download the zip and **keep the `.keystore` file and its passwords
     somewhere safe.** Losing it means you can't update the app (Play App Signing softens this, but
     still back it up).
3. The zip contains an `.aab` (for Play) and an `.apk` (to try on your own phone) plus
   `assetlinks.json`.

Alternative for developers: Google's Bubblewrap CLI with `android/twa-manifest.json` in this repo
(`npx @bubblewrap/cli init --manifest https://YOUR-DOMAIN/manifest.webmanifest`, then `build`).
It needs a JDK and the Android SDK, which it offers to install.

## 2. Prove the app and the site belong together

Without this step the app shows a browser address bar at the top.

1. In Play Console, after the first upload: **Setup → App integrity → App signing**. Copy the
   **SHA-256 certificate fingerprint** of the *app signing key* (Google re-signs your upload).
2. On the server, set:
   - `ANDROID_PACKAGE_NAME=app.kindred.twa`
   - `ANDROID_CERT_SHA256=<that fingerprint>` (add the upload key's fingerprint too, comma-separated,
     so the APK you sideload also works).
3. Check <https://YOUR-DOMAIN/.well-known/assetlinks.json> shows them. Reinstall the app; the bar is gone.

## 3. The Play listing

Play Console asks for these. Kindred already has what the policies require; here's where:

| Play asks for | Answer |
| --- | --- |
| Privacy policy URL | `https://YOUR-DOMAIN/privacy` (still marked Draft: get it reviewed first) |
| Account deletion | In the app: Account → Delete account. Web link Play requires: `https://YOUR-DOMAIN/privacy` (it explains how to delete; add a sentence naming the in-app path) |
| Target audience | 18+ only |
| Content rating | Users can talk to each other; no sharing of photos or location; moderated |
| User-generated content policy | In-app report (every chat menu), block, a moderation team, terms that ban abuse. All present |
| Ads | "Yes, contains ads" only if you turn AdSense on |
| Data safety | Collected: email, birthdate (age check), messages, hashed device ID (ban evasion), purchase history. Encrypted in transit. Users can request deletion. Not sold, not shared for ads |
| Health/mental-health claims | Don't describe it as therapy or treatment. "Peer support", "someone to talk to" |

Screenshots: phone screenshots 1080×1920 or similar. Run the app and capture the home screen, the
match splash, a chat, connect, and Your color.

Feature graphic: 1024×500. App icon: 512×512, use `client/public/icon-512.png`.

## 4. Release

1. **Testing → Closed testing**: upload the `.aab`, add 12+ testers by email, run it 14 days.
2. Fix what testers report. Site updates reach them immediately.
3. **Production**: promote the same build. Review usually takes a few days.

## iPhone later

Apple's App Store doesn't accept TWAs. The site already installs to the iPhone home screen
(Share → Add to Home Screen) with notifications on iOS 16.4+. A real App Store app would mean a
Capacitor wrapper with native push (Apple requires more than a website in a frame), so leave it until
the Android version proves people want it.
