// Stripe checkout, Kindred Plus and the customer portal.
const { httpError, asyncRoute } = require('./common');

module.exports = function register(app, { payments, member, siteUrl }) {
  // --- Billing ---

  app.post('/api/billing/plus', member, asyncRoute(async (req, res) => {
    if (!payments.enabled) throw httpError(503, "Payments aren't set up yet.");
    const base = siteUrl(req);
    if (!base) throw httpError(503, 'Payments need PUBLIC_URL to be configured.');
    // One subscription at a time, including one whose renewal is failing (Stripe still retries it).
    if (req.user.plusSubscriptionId || (req.user.plusUntil > Date.now() && req.user.stripeCustomerId)) {
      throw httpError(409, 'You already have a Kindred Plus subscription. Use Manage subscription to update it.');
    }
    res.json(await payments.createSubscriptionCheckout({ userId: req.user.id, returnUrl: `${base}/`, customerId: req.user.stripeCustomerId }));
  }));

  app.post('/api/billing/portal', member, asyncRoute(async (req, res) => {
    if (!payments.enabled || !req.user.stripeCustomerId) throw httpError(404, 'No subscription to manage.');
    const base = siteUrl(req);
    if (!base) throw httpError(503, 'Payments need PUBLIC_URL to be configured.');
    res.json(await payments.createPortal({ customerId: req.user.stripeCustomerId, returnUrl: `${base}/` }));
  }));

  app.post('/api/billing/checkout', member, asyncRoute(async (req, res) => {
    if (!payments.enabled) throw httpError(503, "Payments aren't set up yet. Connecting is free for now.");
    const base = siteUrl(req);
    if (!base) throw httpError(503, 'Payments need PUBLIC_URL to be configured.');
    res.json(await payments.createCheckout({ userId: req.user.id, returnUrl: `${base}/` }));
  }));
};
