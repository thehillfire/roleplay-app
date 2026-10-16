// Moderator tools: reports, held messages, appeals, account status, stats.
const { badRequest } = require('../validate');
const { httpError, asyncRoute } = require('./common');

module.exports = function register(app, { store, hub, mailer, member }) {
  // --- Moderation (admins) ---

  const admin = (req, res, next) => member(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Moderators only.' });
    return next();
  });

  app.get('/api/admin/log', admin, asyncRoute(async (req, res) => {
    res.json({ actions: await store.listModActions() });
  }));

  app.get('/api/admin/appeals', admin, asyncRoute(async (req, res) => {
    res.json({ appeals: await store.listAppeals() });
  }));

  app.post('/api/admin/appeals/:id/resolve', admin, asyncRoute(async (req, res) => {
    const userId = await store.resolveAppeal(req.params.id);
    if (!userId) throw httpError(404, 'Open appeal not found (it may have just been answered).');
    const restore = req.body.restore === true;
    const restored = restore ? await store.setUserStatus(userId, 'active') : false;
    const action = !restore ? 'appeal_denied' : restored ? 'appeal_granted' : 'appeal_closed_account_deleted';
    await store.logModAction({ moderatorId: req.user.id, targetId: userId, action });
    res.json({ ok: true, action });
  }));

  app.get('/api/admin/support', admin, asyncRoute(async (req, res) => {
    res.json({ requests: await store.listSupportRequests() });
  }));

  // Closing a request can include a reply, which is emailed; the moderator never sees the address.
  app.post('/api/admin/support/:id/resolve', admin, asyncRoute(async (req, res) => {
    const reply = typeof req.body.reply === 'string' ? req.body.reply.trim().slice(0, 4000) : '';
    const closed = await store.resolveSupportRequest(req.params.id, reply);
    if (!closed) throw httpError(404, 'Open request not found (it may have just been answered).');
    if (reply && !closed.deleted) {
      mailer.send({
        to: closed.email,
        subject: 'Kindred support: a reply to your message',
        text: `Hi ${closed.handle},\n\n${reply}\n\nThe Kindred team\n\n(You wrote to us about: ${closed.topic}. Reply in the app under Account → Contact support.)`,
      }).catch((err) => console.error('support reply failed', err.message));
    }
    await store.logModAction({ moderatorId: req.user.id, targetId: closed.userId, action: reply ? 'support_replied' : 'support_closed', detail: closed.topic });
    res.json({ ok: true, emailed: Boolean(reply && !closed.deleted) });
  }));

  app.get('/api/admin/stats', admin, asyncRoute(async (req, res) => {
    res.json({ ...(await store.adminStats()), ...hub.stats() });
  }));

  app.get('/api/admin/reports', admin, asyncRoute(async (req, res) => {
    const status = req.query.status === 'resolved' ? 'resolved' : 'open';
    res.json({ reports: await store.listReports({ status }) });
  }));

  app.post('/api/admin/reports/:id/resolve', admin, asyncRoute(async (req, res) => {
    const { resolution } = req.body;
    if (!['dismissed', 'warned', 'suspended'].includes(resolution)) throw badRequest('resolution must be dismissed, warned or suspended');
    const report = await store.getReport(req.params.id);
    if (!report || !(await store.resolveReport(report.id, resolution))) throw httpError(404, 'Open report not found.');
    if (resolution === 'suspended') {
      await store.setUserStatus(report.reported.id, 'suspended');
      hub.disconnect(report.reported.id);
    }
    await store.logModAction({ moderatorId: req.user.id, targetId: report.reported.id, action: `report_${resolution}`, detail: report.reason });
    res.json({ ok: true });
  }));

  app.get('/api/admin/held', admin, asyncRoute(async (req, res) => {
    res.json({ messages: await store.listHeldMessages() });
  }));

  app.get('/api/admin/users', admin, asyncRoute(async (req, res) => {
    const handle = typeof req.query.handle === 'string' ? req.query.handle.trim().replace(/^@/, '') : '';
    if (!handle || handle.length > 40) throw badRequest('Enter a handle.');
    const user = await store.adminUserByHandle(handle);
    if (!user) throw httpError(404, `Nobody is called ${handle}.`);
    res.json({ user });
  }));

  app.post('/api/admin/users/:id/status', admin, asyncRoute(async (req, res) => {
    const { status } = req.body;
    if (!['active', 'suspended'].includes(status)) throw badRequest('status must be active or suspended');
    const user = await store.getUser(req.params.id);
    if (!user) throw httpError(404, 'User not found.');
    if (!(await store.setUserStatus(user.id, status))) throw httpError(409, 'This account was deleted by its owner.');
    await store.logModAction({ moderatorId: req.user.id, targetId: user.id, action: status === 'active' ? 'restore' : 'suspend' });
    if (status !== 'active') hub.disconnect(user.id);
    res.json({ ok: true });
  }));
};
