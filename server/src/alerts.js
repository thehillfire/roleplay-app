// Optional: post server errors to a Slack or Discord incoming webhook (ERROR_WEBHOOK_URL), so a
// small team hears about breakage without watching logs. Only the error's type, message and the
// route (ids collapsed) are sent: never request bodies, message text, emails or user ids.
// Rate-limited: the same error at most once every 10 minutes, and 20 alerts an hour in total.
function createErrorAlerts({ url = process.env.ERROR_WEBHOOK_URL, fetchImpl = fetch, now = Date.now, log = console } = {}) {
  const enabled = /^https:\/\//.test(url || '');
  const lastSent = new Map(); // signature -> time
  let hourStart = 0;
  let sentThisHour = 0;

  function report(err, where = '') {
    if (!enabled) return;
    const t = now();
    const route = String(where).replace(/\/[0-9a-f-]{20,}/gi, '/:id').slice(0, 120);
    const firstLine = String(err?.message || err).split('\n')[0].slice(0, 300);
    const signature = `${err?.name || 'Error'}|${firstLine}|${route}`;
    if (lastSent.get(signature) > t - 10 * 60 * 1000) return;
    if (t - hourStart > 60 * 60 * 1000) { hourStart = t; sentThisHour = 0; }
    if (sentThisHour >= 20) return;
    sentThisHour += 1;
    if (lastSent.size > 500) lastSent.clear();
    lastSent.set(signature, t);
    const text = `Kindred server error${route ? ` on ${route}` : ''}: ${err?.name || 'Error'}: ${firstLine}`;
    // Slack reads `text`, Discord reads `content`.
    fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(5000),
    }).catch((e) => log.warn('error alert failed', e.message));
  }

  return { enabled, report };
}

module.exports = { createErrorAlerts };
