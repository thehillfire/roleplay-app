// Appeals, data export and deletion, daily check-ins, push subscriptions.
const { verifyPassword } = require('../auth');
const { str, badRequest } = require('../validate');
const { httpError, asyncRoute } = require('./common');

module.exports = function register(app, { store, hub, auth, push, authLimiter, member }) {
  // --- Appeals: paused or suspended people can explain their side ---

  const paused = (req, res, next) => auth.requireUser(req, res, () => {
    if (!['review', 'suspended'].includes(req.user.status)) return res.status(409).json({ error: 'Your account is active.' });
    return next();
  });

  app.get('/api/appeal', paused, asyncRoute(async (req, res) => {
    res.json({ appeal: await store.openAppeal(req.user.id) });
  }));

  app.post('/api/appeal', paused, authLimiter, asyncRoute(async (req, res) => {
    const message = str(req.body.message, 'message', 1000);
    await store.createAppeal(req.user.id, message);
    res.status(201).json({ appeal: await store.openAppeal(req.user.id) });
  }));

  // --- Account ---

  app.get('/api/account/export', member, asyncRoute(async (req, res) => {
    const data = await store.exportAccount(req.user.id);
    res.set('Content-Disposition', `attachment; filename="kindred-${req.user.handle}.json"`);
    res.json(data);
  }));

  app.post('/api/account/delete', auth.requireUser, authLimiter, asyncRoute(async (req, res) => {
    const found = await store.findUserByEmail(req.user.email);
    if (typeof req.body.password !== 'string' || !(await verifyPassword(req.body.password, found?.passwordHash))) {
      throw httpError(401, 'Password is incorrect.');
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
    const valid = sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000
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
