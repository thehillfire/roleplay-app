import { useEffect, useRef } from 'react';

// Cloudflare Turnstile widget (only when the server has keys). Loads Cloudflare's script
// once, renders in place and reports the token; `resetKey` changes after a failed signup
// because each token works once.
let scriptPromise = null;
function loadScript() {
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => { scriptPromise = null; reject(new Error('Turnstile failed to load')); };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

export default function Turnstile({ siteKey, onToken, resetKey }) {
  const box = useRef(null);
  useEffect(() => {
    let widget = null;
    let cancelled = false;
    onToken('');
    loadScript().then((turnstile) => {
      if (cancelled || !box.current) return;
      widget = turnstile.render(box.current, {
        sitekey: siteKey,
        theme: 'dark',
        callback: (token) => onToken(token),
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
      });
    }, () => {});
    return () => {
      cancelled = true;
      if (widget !== null) window.turnstile?.remove(widget);
    };
  }, [siteKey, onToken, resetKey]);
  return <div className="turnstile" ref={box} />;
}
