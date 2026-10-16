// "Leave a message for the next listener": when nobody is around, a talker can leave a short
// message and go. The next listener who looks for someone picks it up (see realtime.js), and
// the talker is notified.
const { str, badRequest } = require('../validate');
const { screenMessage } = require('../moderation');
const { asyncRoute, BOTTLE_TTL_MS } = require('./common');

module.exports = function register(app, { store, hub, classifier, messageLimiter, member }) {
  app.get('/api/bottle', member, asyncRoute(async (req, res) => {
    res.json({ bottle: await store.myOpenBottle(req.user.id, Date.now() - BOTTLE_TTL_MS) });
  }));

  app.post('/api/bottle', member, messageLimiter, asyncRoute(async (req, res) => {
    const body = str(req.body.body, 'message', 500);
    // No review queue for these, so anything a chat message would be held for is refused.
    const screen = screenMessage(body);
    let ok = screen.deliver;
    if (ok && classifier.enabled) ok = !(await classifier.classify(body))?.flags.length;
    if (!ok) throw badRequest("That can't be sent: no contact details, ages, meetups or anything personal. Just what's on your mind.");
    await store.createBottle(req.user.id, body, screen.crisis);
    hub.bottlesChanged();
    res.status(201).json({ ok: true, crisis: screen.crisis });
  }));

  app.post('/api/bottle/withdraw', member, asyncRoute(async (req, res) => {
    await store.withdrawBottle(req.user.id);
    hub.bottlesChanged();
    res.json({ ok: true });
  }));
};
