// Optional Cloudflare Turnstile check at signup (free; keeps bot farms out of an
// anonymous chat app). Off unless both keys are set.
function createCaptcha({
  siteKey = process.env.TURNSTILE_SITE_KEY,
  secretKey = process.env.TURNSTILE_SECRET_KEY,
  fetchImpl = fetch,
  log = console,
} = {}) {
  const enabled = Boolean(siteKey && secretKey);

  // True when Cloudflare confirms the token. If Cloudflare itself can't be reached we let
  // the signup through (logged): a short outage shouldn't lock real people out.
  async function verify(token, ip) {
    if (!enabled) return true;
    if (typeof token !== 'string' || !token || token.length > 2048) return false;
    try {
      const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: secretKey, response: token, ...(ip ? { remoteip: ip } : {}) }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.success === true;
    } catch (err) {
      log.warn('captcha check unavailable, allowing signup', err.message);
      return true;
    }
  }

  return { enabled, siteKey: enabled ? siteKey : null, verify };
}

module.exports = { createCaptcha };
