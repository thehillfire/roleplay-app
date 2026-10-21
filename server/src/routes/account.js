// Appeals, data export and deletion, daily check-ins, push subscriptions.
const { verifyPassword } = require('../auth');
const { str, badRequest } = require('../validate');
const { httpError, asyncRoute } = require('./common');

const APPEAL_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
const SUPPORT_TOPICS = ['account', 'safety', 'feedback', 'other'];

module.exports = function register(app, { store, hub, auth, push, mailer, social, siteUrl, authLimiter, member }) {
  // Moderators hear about new support requests at most once an hour (topic only, never the text).
  let lastSupportAlert = 0;
  const alertSupport = async (req, topic) => {
    if (Date.now() - lastSupportAlert < 60 * 60 * 1000) return;
    lastSupportAlert = Date.now();
    const base = siteUrl(req);
    const emails = await store.moderatorEmails();
    await Promise.all(emails.map((to) => mailer.send({
      to,
      subject: '[Kindred] New support request',
      text: `Someone wrote in about: ${topic}.\n\nOpen the inbox: ${base ? `${base}/` : '(set PUBLIC_URL)'} → Account menu → Moderate → Inbox.`,
    }).catch((err) => console.error('support alert failed', err.message))));
  };

  // The app shows a moderator notice once, then clears it.
  app.post('/api/account/notice/dismiss', auth.requireUser, asyncRoute(async (req, res) => {
    await store.setNotice(req.user.id, null);
    res.json({ ok: true });
  }));

  // --- Support: write to the team; replies arrive by email ---

  app.get('/api/support', member, asyncRoute(async (req, res) => {
    res.json({ requests: await store.mySupportRequests(req.user.id) });
  }));

  app.post('/api/support', member, authLimiter, asyncRoute(async (req, res) => {
    const topic = SUPPORT_TOPICS.includes(req.body.topic) ? req.body.topic : 'other';
    const message = str(req.body.message, 'message', 2000);
    // "x" or "?" leaves a moderator nothing to act on.
    if (message.replace(/\s/g, '').length < 5) throw httpError(400, 'Tell us a little more: a sentence is plenty.');
    if (!(await store.createSupportRequest(req.user.id, topic, message))) {
      throw httpError(429, "You have a few requests waiting already. We'll get back to you soon.");
    }
    alertSupport(req, topic).catch(() => {});
    res.status(201).json({ ok: true, emailVerified: req.user.emailVerified });
  }));

  // --- Appeals: paused or suspended people can explain their side ---

  const paused = (req, res, next) => auth.requireUser(req, res, () => {
    if (!['review', 'suspended'].includes(req.user.status)) return res.status(409).json({ error: 'Your account is active.' });
    return next();
  });

  app.get('/api/appeal', paused, asyncRoute(async (req, res) => {
    const appeal = await store.latestAppeal(req.user.id);
    res.json({ appeal: appeal && appeal.decision === 'denied' ? { ...appeal, nextAppealAt: appeal.decidedAt + APPEAL_WAIT_MS } : appeal });
  }));

  app.post('/api/appeal', paused, authLimiter, asyncRoute(async (req, res) => {
    const message = str(req.body.message, 'message', 1000);
    // After a "no", one new note a week: enough to add context, not to wear moderators down.
    const last = await store.latestAppeal(req.user.id);
    if (last?.decision === 'denied' && last.decidedAt + APPEAL_WAIT_MS > Date.now()) {
      throw httpError(429, `You can send another note after ${new Date(last.decidedAt + APPEAL_WAIT_MS).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.`);
    }
    await store.createAppeal(req.user.id, message);
    res.status(201).json({ appeal: await store.latestAppeal(req.user.id) });
  }));

  // --- Account ---

  app.get('/api/account/export', member, asyncRoute(async (req, res) => {
    const data = await store.exportAccount(req.user.id);
    res.set('Content-Disposition', `attachment; filename="kindred-${req.user.handle}.json"`);
    res.json(data);
  }));

  app.post('/api/account/delete', auth.requireUser, authLimiter, asyncRoute(async (req, res) => {
    const found = await store.findUserByEmail(req.user.email);
    if (String(found?.passwordHash || '').startsWith('scrypt$')) {
      if (typeof req.body.password !== 'string' || !(await verifyPassword(req.body.password, found.passwordHash))) {
        throw httpError(401, 'Password is incorrect.');
      }
    } else if (!social.consumeReauth(req.user.id)) {
      // No password to ask for (the account signs in through Google or Apple): they confirm with the provider.
      throw httpError(401, 'Confirm with your sign-in provider first, then try again.');
    }
    const conversations = await store.listConversations(req.user.id);
    await store.deleteAccount(req.user.id);
    for (const c of conversations) hub.push(c.partner.id, { type: 'conversation.ended', conversationId: c.id });
    hub.disconnect(req.user.id);
    await auth.endSession(req, res);
    res.json({ ok: true });
  }));

  // --- Private daily check-in ---

  app.get('/api/checkins', member, asyncRoute(async (req, res) => {
    res.json({ checkins: await store.recentCheckins(req.user.id) });
  }));

  app.post('/api/checkins', member, asyncRoute(async (req, res) => {
    const { day, mood } = req.body;
    if (!Number.isInteger(mood) || mood < 1 || mood > 5) throw badRequest('mood must be 1-5');
    // The client's local date, sanity-checked to be within a day of the server's.
    const parsed = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T12:00:00Z`) : NaN;
    if (!Number.isFinite(parsed) || Math.abs(parsed - Date.now()) > 36 * 60 * 60 * 1000) throw badRequest('day must be your local date');
    await store.saveCheckin(req.user.id, day, mood);
    res.json({ checkins: await store.recentCheckins(req.user.id) });
  }));

  // --- Push notifications ---

  app.post('/api/push/subscribe', member, asyncRoute(async (req, res) => {
    if (!push.enabled) throw httpError(503, 'Notifications are not set up on this server.');
    const sub = req.body.subscription;
    const valid = sub && typeof sub.endpoint === 'string' && sub.endpoint.length < 1000 && push.endpointAllowed(sub.endpoint)
      && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
    if (!valid) throw badRequest('Invalid push subscription');
    await store.savePushSubscription(req.user.id, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
    res.status(201).json({ ok: true });
  }));

  app.post('/api/push/unsubscribe', member, asyncRoute(async (req, res) => {
    if (typeof req.body.endpoint === 'string') await store.deletePushSubscription(req.body.endpoint, req.user.id);
    res.json({ ok: true });
  }));

  // "On call": a push when someone has been waiting to talk with nobody to listen.
  app.post('/api/account/listener-alerts', member, asyncRoute(async (req, res) => {
    if (typeof req.body.on !== 'boolean') throw httpError(400, 'Say on or off.');
    if (req.body.on && !push.enabled) throw httpError(503, "Notifications aren't set up yet.");
    await store.setListenerAlerts(req.user.id, req.body.on);
    res.json({ listenerAlerts: req.body.on });
  }));
};
