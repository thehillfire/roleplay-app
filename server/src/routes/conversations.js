// Conversations and messages: history, sending, reactions, connect, block, report.
const { parseMessageBody, str, badRequest } = require('../validate');
const { screenMessage } = require('../moderation');
const { httpError, asyncRoute, connectionView, UNSEND_WINDOW_MS, REACTIONS, REPORT_REASONS, AUTO_PAUSE } = require('./common');

module.exports = function register(app, { store, hub, payments, classifier, push, mailer, autoPauseMinReporterAgeMs, messageLimiter, member, conversation, siteUrl }) {
  // Emails moderators about reports that can't wait (possible minors, people at risk).
  // Never includes message text: just what kind of report and where to look.
  const alertModerators = async (req, subject, line) => {
    const base = siteUrl(req);
    const emails = await store.moderatorEmails();
    await Promise.all(emails.map((to) => mailer.send({
      to,
      subject: `[Kindred] ${subject}`,
      text: `${line}\n\nOpen the moderation queue: ${base ? `${base}/` : '(set PUBLIC_URL)'} → Account menu → Moderate.`,
    }).catch((err) => console.error('moderator alert failed', err.message))));
  };
  // The same longer message pasted into 3+ different conversations within an hour is spam
  // (promos, scams). Short greetings are exempt; everyone says "hi" to everyone.
  const recentBodies = new Map(); // userId -> Map(normalized body -> { convos: Set, first })
  const SPAM = { minLength: 25, conversations: 3, windowMs: 60 * 60 * 1000 };
  const isCopyPasteSpam = (userId, conversationId, body) => {
    const key = body.toLowerCase().replace(/\s+/g, ' ').trim();
    if (key.length < SPAM.minLength) return false;
    const t = Date.now();
    let mine = recentBodies.get(userId);
    if (!mine) {
      if (recentBodies.size > 20000) recentBodies.clear(); // memory bound; worst case a spammer gets a fresh hour
      mine = new Map();
      recentBodies.set(userId, mine);
    }
    for (const [k, v] of mine) if (t - v.first > SPAM.windowMs) mine.delete(k);
    const entry = mine.get(key) || { convos: new Set(), first: t };
    entry.convos.add(conversationId);
    mine.set(key, entry);
    if (mine.size > 50) mine.delete(mine.keys().next().value);
    return entry.convos.size >= SPAM.conversations;
  };

  // At most one alert per person and reason per hour, and never in the request's way.
  const recentAlerts = new Map();
  const alertOnce = (key, send) => {
    const t = Date.now();
    if (recentAlerts.get(key) > t - 60 * 60 * 1000) return;
    recentAlerts.set(key, t);
    if (recentAlerts.size > 5000) for (const [k, v] of recentAlerts) if (v < t - 60 * 60 * 1000) recentAlerts.delete(k);
    Promise.resolve().then(send).catch((err) => console.error('moderator alert failed', err.message));
  };

  // --- Conversations ---

  app.get('/api/conversations', member, asyncRoute(async (req, res) => {
    const conversations = await store.listConversations(req.user.id);
    res.json({
      conversations: conversations.map(({ partner, ...c }) => ({
        ...c,
        partner: { handle: partner.handle, online: hub.isOnline(partner.id) },
      })),
    });
  }));

  app.get('/api/conversations/:id', member, conversation, asyncRoute(async (req, res) => {
    const partner = await store.getUser(req.conversation.partnerId);
    const blocked = await store.isBlocked(req.user.id, partner.id);
    if (blocked) throw httpError(404, 'Conversation not found.');
    const before = Number(req.query.before) || undefined;
    const beforeId = typeof req.query.beforeId === 'string' ? req.query.beforeId.slice(0, 64) : undefined;
    const messages = await store.listMessages(req.user.id, req.conversation.id, { before, beforeId });
    const [connection, counts, feedback, partnerReadAt] = await Promise.all([
      store.getConnection(req.conversation.id).then((c) => connectionView(c, req.user.id)),
      store.messageCounts(req.conversation.id, req.user.id),
      store.myFeedback(req.conversation.id, req.user.id),
      req.conversation.partnerReadAt,
    ]);
    // Ask "did this help?" once a real exchange has happened.
    const canRate = counts.mine >= 2 && counts.theirs >= 2;
    res.json({
      conversation: {
        id: req.conversation.id,
        partner: { handle: partner.handle, online: hub.isOnline(partner.id) },
        connection,
        partnerReadAt,
        feedback: { canRate, helpful: feedback },
      },
      // Flags are only shown to the sender, to explain why a message was held.
      messages: messages.map(({ senderId, flags, ...m }) => ({ ...m, fromMe: senderId === req.user.id, ...(senderId === req.user.id && m.status === 'held' ? { flags } : {}) })),
    });
  }));

  app.post('/api/conversations/:id/messages', member, messageLimiter, asyncRoute(async (req, res) => {
    const body = parseMessageBody(req.body.body);
    // One query for membership, partner status, blocks and connect state (this is the hot path).
    const ctx = await store.sendContext(req.user.id, req.params.id);
    if (!ctx) throw httpError(404, 'Conversation not found.');
    const { id, partnerId } = ctx;
    if (ctx.blocked) throw httpError(403, "You can't message this person.");
    if (ctx.partnerStatus === 'deleted') throw httpError(403, 'This person has left Kindred.');

    const screen = screenMessage(body, { connected: ctx.connected });
    if (isCopyPasteSpam(req.user.id, id, body)) {
      screen.deliver = false;
      screen.flags.push('spam');
    }
    // Optional ML second opinion for what rules can't see (only when the rules let it through).
    if (screen.deliver && classifier.enabled) {
      const verdict = await classifier.classify(body);
      if (verdict) {
        if (verdict.flags.length) {
          screen.deliver = false;
          screen.flags.push(...verdict.flags.filter((f) => !screen.flags.includes(f)));
        }
        if (verdict.crisis && !screen.crisis) {
          screen.crisis = true;
          screen.flags.push('crisis');
        }
      }
    }
    const message = await store.addMessage({
      conversationId: id,
      senderId: req.user.id,
      body,
      status: screen.deliver ? 'delivered' : 'held',
      flags: screen.flags.length ? screen.flags : undefined,
    });
    const { senderId, flags, ...out } = message; // eslint-disable-line no-unused-vars

    if (screen.suspend) {
      // Someone said they're under 18: pause the account until a moderator looks.
      await store.setUserStatus(req.user.id, 'review');
      await store.logModAction({ targetId: req.user.id, action: 'auto_pause', detail: 'Message said they are under 18' });
      alertOnce(`${req.user.id}:auto_minor`, () => alertModerators(req, 'Possible minor paused', `An account was paused after saying they're under 18 (${req.user.handle}).`));
      hub.push(partnerId, { type: 'conversation.ended', conversationId: id });
      setImmediate(() => hub.disconnect(req.user.id));
    } else if (!screen.deliver && screen.flags.includes('minor_sexual')) {
      alertOnce(`${req.user.id}:minor_sexual`, () => alertModerators(req, 'Held: sexual content involving minors', `A message from ${req.user.handle} was held as sexual content involving minors. Review it now.`));
    } else if (screen.deliver) {
      hub.push(partnerId, { type: 'message', message: { ...out, fromMe: false, ...(screen.crisis ? { crisis: true } : {}) } });
      // Not looking at the app: notify their devices (handle only, never the text).
      if (!hub.isOnline(partnerId)) {
        push.notify(store, partnerId, { title: 'Kindred', body: `New message from ${req.user.handle}`, conversationId: id, tag: id })
          .catch((err) => console.warn('push notify failed', err.message));
      }
    }
    res.status(201).json({ message: { ...out, fromMe: true, flags }, crisis: screen.crisis, paused: screen.suspend || undefined });
  }));

  app.post('/api/conversations/:id/feedback', member, conversation, asyncRoute(async (req, res) => {
    if (typeof req.body.helpful !== 'boolean') throw badRequest('helpful must be true or false');
    const { id, partnerId } = req.conversation;
    const counts = await store.messageCounts(id, req.user.id);
    if (counts.mine < 2 || counts.theirs < 2) throw httpError(409, 'Chat a little first.');
    const newThanks = await store.saveFeedback({ conversationId: id, raterId: req.user.id, rateeId: partnerId, helpful: req.body.helpful });
    if (newThanks) hub.push(partnerId, { type: 'thanks', conversationId: id, from: req.user.handle });
    res.json({ helpful: req.body.helpful });
  }));

  // --- Connect: mutual reveal. Requesting costs a credit (when payments are on); accepting is free. ---

  const parseReveal = (body = {}) => ({
    name: str(body.name, 'name', 40),
    contact: str(body.contact, 'contact', 100, { required: false }),
  });

  const pushConnection = async (conversationId, userIds) => {
    const c = await store.getConnection(conversationId);
    for (const uid of userIds) {
      hub.push(uid, { type: 'connect.updated', conversationId, connection: connectionView(c, uid) });
      if (c?.status === 'pending' && !hub.isOnline(uid)) {
        push.notify(store, uid, { title: 'Kindred', body: 'Someone would like to connect with you', conversationId, tag: `connect-${conversationId}` })
          .catch(() => {});
      }
    }
  };

  app.post('/api/conversations/:id/connect', member, conversation, asyncRoute(async (req, res) => {
    const { id, partnerId } = req.conversation;
    if (await store.isBlocked(req.user.id, partnerId)) throw httpError(403, "You can't connect with this person.");
    const reveal = parseReveal(req.body);
    const existing = await store.getConnection(id);

    if (existing?.status === 'pending' && existing.requesterId === partnerId) {
      // They asked first: accepting is free and reveals both sides.
      if (!(await store.respondToConnect(id, { accept: true, ...reveal }))) throw httpError(409, 'That request was just withdrawn.');
    } else if (existing?.status === 'accepted') {
      throw httpError(409, "You're already connected.");
    } else if (existing?.status === 'pending') {
      throw httpError(409, 'Your request is waiting for their answer.');
    } else if (existing?.status === 'declined') {
      throw httpError(409, "They chose to stay anonymous. Let's respect that.");
    } else {
      const paid = payments.enabled;
      if (paid && !(await store.spendCredit(req.user.id))) {
        return res.status(402).json({ error: 'Connecting needs a credit.', needsCredit: true });
      }
      if (!(await store.createConnectRequest({ conversationId: id, requesterId: req.user.id, ...reveal, paid }))) {
        if (paid) await store.addCredits(req.user.id, 1); // lost a race with their request; refund
        throw httpError(409, 'They just sent you a request. Open it to accept.');
      }
    }
    await pushConnection(id, [partnerId]);
    res.json({ connection: connectionView(await store.getConnection(id), req.user.id) });
  }));

  app.post('/api/conversations/:id/connect/decline', member, conversation, asyncRoute(async (req, res) => {
    const { id, partnerId } = req.conversation;
    const c = await store.getConnection(id);
    if (!c || c.status !== 'pending' || c.requesterId !== partnerId) throw httpError(404, 'No request to decline.');
    // Only the request that actually flips it from pending refunds (no double refunds on races).
    if (!(await store.respondToConnect(id, { accept: false }))) throw httpError(409, 'That request was already answered.');
    if (c.paid) await store.addCredits(partnerId, 1); // their credit comes back
    await pushConnection(id, [partnerId]);
    res.json({ connection: connectionView(await store.getConnection(id), req.user.id) });
  }));

  app.post('/api/conversations/:id/connect/cancel', member, conversation, asyncRoute(async (req, res) => {
    const { id, partnerId } = req.conversation;
    const c = await store.getConnection(id);
    if (!c || !(await store.cancelConnectRequest(id, req.user.id))) throw httpError(404, 'No request to cancel.');
    if (c.paid) await store.addCredits(req.user.id, 1);
    await pushConnection(id, [partnerId]);
    res.json({ connection: { status: 'none' } });
  }));

  app.post('/api/conversations/:id/block', member, conversation, asyncRoute(async (req, res) => {
    await store.block(req.user.id, req.conversation.partnerId);
    hub.push(req.conversation.partnerId, { type: 'conversation.ended', conversationId: req.conversation.id });
    res.json({ ok: true });
  }));

  app.post('/api/conversations/:id/report', member, messageLimiter, conversation, asyncRoute(async (req, res) => {
    const reason = req.body.reason;
    if (!REPORT_REASONS.includes(reason)) throw badRequest('Choose a reason for the report');
    const details = str(req.body.details, 'details', 1000, { required: false });
    const { id, partnerId } = req.conversation;
    await store.createReport({ reporterId: req.user.id, reportedId: partnerId, conversationId: id, reason, details });
    if (req.body.block !== false) {
      await store.block(req.user.id, partnerId);
      hub.push(partnerId, { type: 'conversation.ended', conversationId: id });
    }
    const since = Date.now() - AUTO_PAUSE.window;
    const [all, minor] = await Promise.all([
      store.distinctReporters(partnerId, since, { minReporterAgeMs: autoPauseMinReporterAgeMs }),
      // Child safety outranks brigading: every reporter counts for "under 18" (a pause is reversible).
      store.distinctReporters(partnerId, since, { reason: 'minor' }),
    ]);
    if (reason === 'minor' || reason === 'self_harm') {
      const label = reason === 'minor' ? 'Report: possibly under 18' : 'Report: someone may be at risk';
      alertOnce(`${partnerId}:${reason}`, () => store.getUser(partnerId).then((u) => alertModerators(req, label, `New urgent report (${reason}) about ${u?.handle}.`)));
    }
    if (all >= AUTO_PAUSE.reporters || minor >= AUTO_PAUSE.minorReporters) {
      const reported = await store.getUser(partnerId);
      if (reported.status === 'active') {
        await store.setUserStatus(partnerId, 'review');
        await store.logModAction({ targetId: partnerId, action: 'auto_pause', detail: `${all} reporters (${minor} for under 18) in a week` });
        hub.disconnect(partnerId);
      }
    }
    res.status(201).json({ ok: true });
  }));

  app.post('/api/conversations/:id/messages/:messageId/react', member, conversation, asyncRoute(async (req, res) => {
    const reaction = req.body.reaction ?? null;
    if (reaction !== null && !REACTIONS.includes(reaction)) throw badRequest('Unknown reaction');
    if (!(await store.setReaction(req.user.id, req.conversation.id, req.params.messageId, reaction))) {
      throw httpError(404, 'Message not found.');
    }
    hub.push(req.conversation.partnerId, { type: 'message.reacted', conversationId: req.conversation.id, messageId: req.params.messageId, reaction });
    res.json({ reaction });
  }));

  app.post('/api/conversations/:id/messages/:messageId/unsend', member, conversation, asyncRoute(async (req, res) => {
    const ok = await store.unsendMessage(req.user.id, req.conversation.id, req.params.messageId, UNSEND_WINDOW_MS);
    if (!ok) throw httpError(409, 'Messages can only be unsent for 5 minutes after sending.');
    hub.push(req.conversation.partnerId, { type: 'message.unsent', conversationId: req.conversation.id, messageId: req.params.messageId });
    res.json({ ok: true });
  }));

  app.post('/api/conversations/:id/read', member, conversation, asyncRoute(async (req, res) => {
    const at = await store.markRead(req.user.id, req.conversation.id);
    // Lets the other person show "Seen" under their latest message.
    hub.push(req.conversation.partnerId, { type: 'read', conversationId: req.conversation.id, at });
    res.json({ ok: true });
  }));
};
