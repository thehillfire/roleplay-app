const webpush = require('web-push');

// Web Push (VAPID). Disabled until VAPID keys are set; generate them with `npm run vapid`.
// Payloads never include message text: notifications show on lock screens.
function createPush({
  publicKey = process.env.VAPID_PUBLIC_KEY,
  privateKey = process.env.VAPID_PRIVATE_KEY,
  subject = process.env.VAPID_SUBJECT || 'mailto:support@example.com',
  sendImpl,
  log = console,
  // The browsers' push services. Anything else would let a client make the server POST
  // to any URL it likes (including internal ones) whenever they get a message.
  allowedHosts = ['fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'],
} = {}) {
  const enabled = Boolean(publicKey && privateKey);
  const send = sendImpl || ((subscription, payload) => webpush.sendNotification(subscription, payload, {
    vapidDetails: { subject, publicKey, privateKey },
    TTL: 60 * 60,
    urgency: 'high',
  }));

  // Sends to every device the user enabled; drops subscriptions the push service says are gone.
  async function notify(store, userId, payload) {
    if (!enabled) return;
    const subs = await store.pushSubscriptions(userId);
    await Promise.all(subs.map(async (sub) => {
      // Saved before the allowlist existed: drop it rather than POST to it.
      if (!endpointAllowed(sub.endpoint)) {
        await store.deletePushSubscription(sub.endpoint);
        return;
      }
      try {
        await send(sub, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await store.deletePushSubscription(sub.endpoint);
        else log.warn('push failed', err.statusCode || err.message);
      }
    }));
  }

  const endpointAllowed = (endpoint) => {
    try {
      const { protocol, hostname } = new URL(endpoint);
      return protocol === 'https:' && allowedHosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));
    } catch {
      return false;
    }
  };

  return { enabled, publicKey: enabled ? publicKey : null, notify, endpointAllowed };
}

module.exports = { createPush };
