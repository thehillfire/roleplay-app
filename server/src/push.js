const webpush = require('web-push');

// Web Push (VAPID). Disabled until VAPID keys are set; generate them with `npm run vapid`.
// Payloads never include message text: notifications show on lock screens.
function createPush({
  publicKey = process.env.VAPID_PUBLIC_KEY,
  privateKey = process.env.VAPID_PRIVATE_KEY,
  subject = process.env.VAPID_SUBJECT || 'mailto:support@example.com',
  sendImpl,
  log = console,
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
      try {
        await send(sub, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await store.deletePushSubscription(sub.endpoint);
        else log.warn('push failed', err.statusCode || err.message);
      }
    }));
  }

  return { enabled, publicKey: enabled ? publicKey : null, notify };
}

module.exports = { createPush };
