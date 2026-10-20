// Which "shell" Kindred is running in: the plain website/PWA, or a store-installed app
// (Google Play's Trusted Web Activity, or the iOS App Store wrapper). Kindred sells nothing,
// but AdSense isn't allowed inside app web views, so ads are hidden there.
//
// Store builds open the site with ?app=android or ?app=ios (see docs/ANDROID.md, docs/IOS.md).
// That first launch is remembered for the session (in-app navigation drops the query string).
// sessionStorage, not localStorage: Chrome shares storage between a TWA and the browser, and
// the website itself should keep its ads.
const KEY = 'kindred.shell';
const SHELLS = ['android', 'ios'];

function detect() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('app');
    if (SHELLS.includes(fromUrl)) {
      sessionStorage.setItem(KEY, fromUrl);
      return fromUrl;
    }
  } catch { /* private mode: fall through */ }
  // A Trusted Web Activity's first page load has the app as its referrer.
  if (document.referrer.startsWith('android-app://')) return 'android';
  // A native wrapper (Capacitor) exposes itself.
  const cap = window.Capacitor;
  if (cap?.isNativePlatform?.()) return cap.getPlatform?.() === 'android' ? 'android' : 'ios';
  try {
    const saved = sessionStorage.getItem(KEY);
    if (SHELLS.includes(saved)) return saved;
  } catch { /* unavailable */ }
  return 'web';
}

const shell = detect();
document.documentElement.dataset.shell = shell;

export const appShell = () => shell;
export const isStoreApp = () => shell !== 'web';
