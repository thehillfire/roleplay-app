const crypto = require('crypto');

// Stripe Checkout for connect credits, with no SDK: one REST call to create a
// session and HMAC verification for webhooks. Disabled (connect is free) until
// STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set.

function createPayments({
  secretKey = process.env.STRIPE_SECRET_KEY,
  webhookSecret = process.env.STRIPE_WEBHOOK_SECRET,
  priceCents = Number(process.env.CONNECT_PRICE_CENTS) || 999,
  currency = process.env.CONNECT_CURRENCY || 'usd',
  fetchImpl = fetch,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const enabled = Boolean(secretKey && webhookSecret);
  const plusPriceCents = Number(process.env.PLUS_PRICE_CENTS) || 499;

  async function stripe(path, form) {
    const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw Object.assign(new Error(`Stripe ${path} failed (${res.status})`), { status: 502 });
    return { url: data.url };
  }

  // Monthly Kindred Plus. The user id rides along on the subscription so renewals can be
  // matched to the account even if Stripe delivers events out of order.
  function createSubscriptionCheckout({ userId, returnUrl, customerId }) {
    const form = new URLSearchParams({
      mode: 'subscription',
      success_url: `${returnUrl}?checkout=plus`,
      cancel_url: `${returnUrl}?checkout=cancelled`,
      client_reference_id: userId,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': currency,
      'line_items[0][price_data][unit_amount]': String(plusPriceCents),
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][product_data][name]': 'Kindred Plus',
      'metadata[user_id]': userId,
      'metadata[kind]': 'plus',
      'subscription_data[metadata][user_id]': userId,
    });
    if (customerId) form.set('customer', customerId);
    return stripe('checkout/sessions', form);
  }

  // Cancels a subscription right away (account deletion). Already gone counts as done.
  async function cancelSubscription(subscriptionId) {
    const res = await fetchImpl(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok && res.status !== 404) throw Object.assign(new Error(`Stripe cancel failed (${res.status})`), { status: 502 });
  }

  // Stripe-hosted page to update the card or cancel.
  function createPortal({ customerId, returnUrl }) {
    return stripe('billing_portal/sessions', new URLSearchParams({ customer: customerId, return_url: returnUrl }));
  }

  async function createCheckout({ userId, returnUrl }) {
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: `${returnUrl}?checkout=success`,
      cancel_url: `${returnUrl}?checkout=cancelled`,
      client_reference_id: userId,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': currency,
      'line_items[0][price_data][unit_amount]': String(priceCents),
      'line_items[0][price_data][product_data][name]': 'Kindred Connect',
      'line_items[0][price_data][product_data][description]': 'One mutual connect request. Returned if they decline.',
      'metadata[user_id]': userId,
      'metadata[credits]': '1',
    });
    const res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      throw Object.assign(new Error(`Stripe checkout failed (${res.status})`), { status: 502 });
    }
    return { url: data.url };
  }

  // Verifies the Stripe-Signature header (t=timestamp, v1=hmac) over `${t}.${rawBody}`.
  function verifyWebhook(rawBody, header, toleranceSec = 300) {
    const parts = Object.fromEntries((header || '').split(',').map((kv) => kv.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v]));
    const signatures = (header || '').split(',').filter((kv) => kv.trim().startsWith('v1=')).map((kv) => kv.trim().slice(3));
    const t = Number(parts.t);
    if (!t || signatures.length === 0) throw Object.assign(new Error('Missing signature'), { status: 400 });
    if (Math.abs(now() - t) > toleranceSec) throw Object.assign(new Error('Signature too old'), { status: 400 });
    const expected = crypto.createHmac('sha256', webhookSecret).update(`${t}.${rawBody}`).digest();
    const ok = signatures.some((sig) => {
      const given = Buffer.from(sig, 'hex');
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
    if (!ok) throw Object.assign(new Error('Bad signature'), { status: 400 });
    return JSON.parse(rawBody);
  }

  // For tests and local tooling: builds a valid Stripe-Signature header.
  function sign(rawBody, t = now()) {
    const v1 = crypto.createHmac('sha256', webhookSecret).update(`${t}.${rawBody}`).digest('hex');
    return `t=${t},v1=${v1}`;
  }

  return { enabled, priceCents, plusPriceCents, currency, createCheckout, createSubscriptionCheckout, createPortal, cancelSubscription, verifyWebhook, sign };
}

module.exports = { createPayments };
