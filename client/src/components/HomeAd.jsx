import { useEffect, useRef } from 'react';

const SCRIPT_ID = 'adsbygoogle-js';

// One AdSense unit, shown only on the home screen (never inside conversations).
// Ads are requested non-personalized: people here are often having a hard time,
// and their visits shouldn't feed an ad profile.
export default function HomeAd({ ads }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!ads) return;
    window.adsbygoogle = window.adsbygoogle || [];
    window.adsbygoogle.requestNonPersonalizedAds = 1;
    if (!document.getElementById(SCRIPT_ID)) {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ads.client)}`;
      document.head.appendChild(script);
    }
    try {
      window.adsbygoogle.push({});
    } catch {
      // Ad blockers or a not-yet-approved account: the slot just stays empty.
    }
  }, [ads]);

  if (!ads) return null;
  return (
    <aside className="home-ad" aria-label="Sponsored">
      <span className="home-ad-label">Sponsored</span>
      <ins
        ref={ref}
        className="adsbygoogle"
        style={{ display: 'block' }}
        data-ad-client={ads.client}
        data-ad-slot={ads.slot}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </aside>
  );
}
