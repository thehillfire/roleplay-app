// Stripe webhook. Mounted before the JSON body parser: signatures need the raw body.
const express = require('express');
const { httpError, asyncRoute, DAY_MS, PLUS_MONTHLY_CREDITS } = require('./common');

module.exports = function register(app, { store, hub, payments }) {
  // A paid Plus invoice (first month or renewal): extend Plus to the end of the period and
  // grant the month's connect credits once (keyed by invoice id, so retries are harmless).
  // Reads both pre- and post-2025 Stripe invoice shapes.
  async function handlePlusInvoice(inv) {
    const details = inv.parent?.subscription_details || inv.subscription_details || {};
    const subscriptionId = inv.subscription || details.subscription;
    if (!subscriptionId) return;
    let user = await store.userBySubscription(subscriptionId);
    const metaUserId = details.metadata?.user_id;
    if (!user && metaUserId && (user = await store.getUser(metaUserId))) {
      await store.linkSubscription(user.id, { customerId: inv.customer, subscriptionId }); // invoice beat checkout
    }
    if (!user) return;
    const periodEnd = Math.max(0, ...((inv.lines?.data || []).map((l) => Number(l.period?.end) || 0)));
    await store.extendPlus(user.id, (periodEnd || Math.floor(Date.now() / 1000) + 31 * 86400) * 1000);
    await store.recordPayment({ id: inv.id, userId: user.id, amountCents: inv.amount_paid || 0, credits: PLUS_MONTHLY_CREDITS });
    await store.flush();
    hub.push(user.id, { type: 'credits.updated' });
  }

  // Stripe webhook needs the raw body for signature checks, so it's mounted before the JSON parser.
  app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '256kb' }), asyncRoute(async (req, res) => {
    if (!payments.enabled) throw httpError(404, 'Not found');
    const event = payments.verifyWebhook(req.body.toString('utf8'), req.get('stripe-signature'));
    const obj = event.data?.object || {};
    if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
      // Plus started: remember the subscription; the first invoice.paid grants the month.
      const userId = obj.client_reference_id || obj.metadata?.user_id;
      if (userId && obj.subscription && (await store.getUser(userId))) {
        await store.linkSubscription(userId, { customerId: obj.customer, subscriptionId: obj.subscription });
      }
    } else if (event.type === 'invoice.paid') {
      await handlePlusInvoice(obj);
    } else if (event.type === 'customer.subscription.deleted') {
      const user = await store.userBySubscription(obj.id);
      const end = Number(obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end) || 0;
      if (user) {
        await store.endPlus(user.id, Math.min(end * 1000 || Date.now(), Date.now() + 31 * DAY_MS));
        hub.push(user.id, { type: 'credits.updated' });
      }
    } else if (event.type === 'checkout.session.completed') {
      const session = obj;
      const userId = session.client_reference_id || session.metadata?.user_id;
      if (session.payment_status === 'paid' && userId && (await store.getUser(userId))) {
        const credits = Math.max(1, Math.min(10, Number(session.metadata?.credits) || 1));
        const granted = await store.recordPayment({ id: session.id, userId, amountCents: session.amount_total || 0, credits });
        // Money: make sure it's on disk before telling Stripe we have it (Stripe won't retry a 200).
        await store.flush();
        if (granted) hub.push(userId, { type: 'credits.updated' });
      }
    }
    res.json({ received: true });
  }));
};
