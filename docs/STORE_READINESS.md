# Store readiness: Google Play and the App Store

One checklist for both stores. "Done" means it's built and tested in this repo. "Jav" means it needs
an account, money, a key or a legal decision only the owner can provide. How-to guides:
`docs/ANDROID.md` (Play, Trusted Web Activity) and `docs/IOS.md` (App Store, Capacitor wrapper).

## How the store apps relate to the website

- Both store apps open the live site, so one deploy updates web, Android and iPhone together.
- They open it with `?app=android` / `?app=ios`. `client/src/shell.js` remembers that for the
  session and tags `<html data-shell>`. In a store app the site then:
  - hides AdSense (not allowed inside app web views; ads in the apps would need AdMob).

## Both stores

| Requirement | Status | Where |
| --- | --- | --- |
| Works on a phone: layout, touch targets, safe areas, no sideways scroll | Done, e2e checks 390×844 | `client/src/styles.css`, `e2e/smoke.mjs` |
| Doesn't break offline | Done: an offline page instead of the browser's error | `client/public/offline.html`, `sw.js` |
| Account creation and deletion in the app | Done | Account → Delete account |
| Public account-deletion page (Play requires a URL) | Done; fill in the support email | `/delete-account` |
| Privacy policy URL | Draft; needs a lawyer | `/privacy` |
| Terms / community rules accepted at signup | Done (checkbox) | Welcome signup |
| User-generated content: report, block, moderation, removal | Done | chat menu, `docs/MODERATION.md` |
| Age rating 18+ with an age gate | Done (birthdate check; under-18 refused and device-flagged) | signup |
| Crisis resources | Done (988 + findahelpline on crisis language) | `components/Safety.jsx` |
| Purchases / store billing | Not needed: Kindred sells nothing (talking and connecting are free). Play Data safety and App Store: no purchases | n/a |
| Camera permission explained before asking | Done in the game panel; the iOS Info.plist string is in `docs/IOS.md` | `NoSmile.jsx` |
| Listing screenshots (Play 1080×1920, App Store 6.5" 1284×2778) and Play feature graphic | Script: `node e2e/store-shots.mjs` against a running server (`BASE_URL`, `OUT`) | `e2e/store-shots.mjs` |
| Reviewer can test alone | Solo practice round in game modes; demo accounts go in the review notes | Practice screen |
| Real keys: email, push, Turnstile, moderation API | Jav | `docs/DEPLOY.md` |

## Google Play only

| Requirement | Status |
| --- | --- |
| Digital Asset Links (no browser bar) | Done; set `ANDROID_PACKAGE_NAME` + `ANDROID_CERT_SHA256` |
| Package + signing | Jav, via PWABuilder (start URL `/?app=android`) |
| Data safety form answers | Written in `docs/ANDROID.md` |
| Closed test: 12 testers × 14 days (new personal accounts) | Jav |

## App Store only

| Requirement | Status |
| --- | --- |
| Sign in with Apple alongside Google | Built (another session), turns on with Apple keys |
| Native push (web push doesn't run in the wrapper) | **Not built**: see `docs/IOS.md` |
| Google sign-in inside a web view | **Blocked by Google**: native plugin or hide on iOS, see `docs/IOS.md` |
| Guideline 4.2 (more than a website in a frame) | Risk; mitigations listed in `docs/IOS.md` |
| Developer account, Mac/Xcode build | Jav |
