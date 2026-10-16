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

  return { enabled, priceCents, currency, createCheckout, verifyWebhook, sign };
}

module.exports = { createPayments };
