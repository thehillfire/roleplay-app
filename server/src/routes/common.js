// Shared constants and small helpers for the route modules.

const RESET_TTL_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNSEND_WINDOW_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PLUS_MONTHLY_CREDITS = 3;
// Gentle on purpose: support, a hug, thanks. Nothing that could read as mocking.
const REACTIONS = ['💙', '🫂', '🙏'];

const REPORT_REASONS = ['harassment', 'sexual', 'minor', 'hate', 'spam', 'self_harm', 'other'];
// Auto-pause (pending human review) when this many different people report someone within a week.
const AUTO_PAUSE = { window: 7 * 24 * 60 * 60 * 1000, reporters: 3, minorReporters: 2, minReporterAgeMs: 24 * 60 * 60 * 1000 };

function createRateLimiter({ max, windowMs, now = Date.now, key = (req) => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const k = key(req);
    const t = now();
    const entry = hits.get(k);
    if (!entry || t > entry.resetAt) {
      // Opportunistic cleanup keeps the map from growing without bound.
      if (hits.size > 10000) for (const [hk, hv] of hits) if (t > hv.resetAt) hits.delete(hk);
      hits.set(k, { count: 1, resetAt: t + windowMs });
      return next();
    }
    if (entry.count >= max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - t) / 1000)));
      return res.status(429).json({ error: 'Slow down a little and try again shortly.' });
    }
    entry.count += 1;
    return next();
  };
}

const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const publicUser = ({ id, handle, role, status, connectCredits, emailVerified, plusUntil, plusSubscriptionId, listenerAlerts, createdAt }) => ({
  id, handle, role, status, connectCredits, emailVerified, listenerAlerts: Boolean(listenerAlerts), plusUntil: plusUntil || 0, plus: (plusUntil || 0) > Date.now(), hasSubscription: Boolean(plusSubscriptionId), createdAt,
});

// What one side of a conversation may see about its connect state.
function connectionView(c, userId) {
  if (!c) return { status: 'none' };
  const mine = c.requesterId === userId;
  if (c.status === 'accepted') {
    const me = mine ? c.requester : c.accepter;
    const them = mine ? c.accepter : c.requester;
    return { status: 'accepted', me, partner: them };
  }
  return { status: c.status, mine };
}

module.exports = {
  RESET_TTL_MS, VERIFY_TTL_MS, UNSEND_WINDOW_MS, DAY_MS, PLUS_MONTHLY_CREDITS, REACTIONS, REPORT_REASONS, AUTO_PAUSE,
  createRateLimiter, httpError, asyncRoute, publicUser, connectionView,
};
