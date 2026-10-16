const { WebSocketServer } = require('ws');
const { createMatchmaker, MODES } = require('./matchmaker');

// Live game moves a client may send: deal the next Cringe Duel card, or "I smiled" in Don't Smile.
const GAME_EVENTS = new Set(['card', 'smiled']);
const { readCookie, hashToken, COOKIE } = require('./auth');
const { envInt } = require('./env');

const TOPIC_MAX = 30;

// Tracks which sockets belong to which user so any part of the server can push events.
function createHub() {
  const sockets = new Map(); // userId -> Set<WebSocket>
  let waiting = () => ({ talk: 0, listen: 0, either: 0 });
  let bottles = 0; // messages left for the next listener
  let onBottles = () => {};
  let onDisconnect = () => {};
  return {
    // People with the app open, and how many are waiting for a match right now (by role).
    stats: () => {
      const byRole = waiting();
      return { online: sockets.size, waiting: byRole.talk + byRole.listen + byRole.either, waitingToTalk: byRole.talk + bottles };
    },
    setBottleCount(n) {
      bottles = n;
    },
    // The HTTP side calls this when a message for the next listener is left or withdrawn.
    bottlesChanged: () => onBottles(),
    onBottlesChanged(fn) {
      onBottles = fn;
    },
    setWaitingCounter(fn) {
      waiting = fn;
    },
    add(userId, ws) {
      if (!sockets.has(userId)) sockets.set(userId, new Set());
      sockets.get(userId).add(ws);
    },
    remove(userId, ws) {
      const set = sockets.get(userId);
      if (!set) return 0;
      set.delete(ws);
      if (set.size === 0) sockets.delete(userId);
      return set.size;
    },
    broadcast(event) {
      const data = JSON.stringify(event);
      for (const set of sockets.values()) for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
    },
    push(userId, event) {
      const data = JSON.stringify(event);
      for (const ws of sockets.get(userId) || []) if (ws.readyState === ws.OPEN) ws.send(data);
    },
    // Suspended, paused or deleted: out of the queue right away (a sleeping phone may take
    // ~30s to answer a close), and the sockets closed.
    disconnect(userId) {
      onDisconnect(userId);
      for (const ws of sockets.get(userId) || []) ws.close(4003, 'Account unavailable');
    },
    onDisconnect(fn) {
      onDisconnect = fn;
    },
    isOnline: (userId) => sockets.has(userId),
  };
}

function originAllowed(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients; they still need a valid session cookie
  try {
    const { host } = new URL(origin);
    return host === req.headers.host || allowedOrigins.includes(origin);
  } catch {
    return false;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const { BOTTLE_TTL_MS } = require('./routes/common');

function attachRealtime({
  server, hub, store, allowedOrigins = [], sameRoleAfterMs, sweepMs = 5000, log = console,
  // New people per day, so nobody can cycle through hundreds of strangers.
  dailyMatchLimit = envInt('DAILY_MATCH_LIMIT', 40),
  presenceThrottleMs = 2000,
  push = null,
  // Listeners "on call" get a push when a talker has waited this long with nobody to listen.
  // Each listener hears at most once per cooldown; each talker triggers at most one alert per perTalkerMs.
  listenerAlert = { afterMs: envInt('LISTENER_ALERT_AFTER_MS', 20000), cooldownMs: 3 * 60 * 60 * 1000, perTalkerMs: 15 * 60 * 1000, batch: 3 },
}) {
  const joining = new Set(); // users with a match.join in flight (several tabs, double taps)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  const matchmaker = createMatchmaker({
    sameRoleAfterMs,
    onMatch: (a, b) => {
      presenceChanged(); // defined below; runs later, once matching is live
      (async () => {
        const [ua, ub] = await Promise.all([store.getUser(a.userId), store.getUser(b.userId)]);
        // Someone paused or suspended while queued never gets matched; the other person searches on.
        const inactive = [ua, ub].filter((u) => u?.status !== 'active');
        if (inactive.length) {
          for (const [entry, u] of [[a, ua], [b, ub]]) {
            if (u?.status === 'active') hub.push(entry.userId, { type: 'match.error', error: 'They left before you met. Tap Find someone to try again.' });
          }
          return;
        }
        const convo = await store.openConversation(a.userId, b.userId, { mode: a.mode });
        // Matched live: any message either left for the next listener is no longer needed
        // (only now, so a failed match doesn't throw their message away).
        const withdrawn = await Promise.all([store.withdrawBottle(a.userId), store.withdrawBottle(b.userId)]);
        if (withdrawn.some(Boolean)) refreshBottles();
        hub.push(a.userId, { type: 'match.found', conversationId: convo.id, partner: { handle: ub.handle }, isNew: convo.isNew, mode: a.mode });
        hub.push(b.userId, { type: 'match.found', conversationId: convo.id, partner: { handle: ua.handle }, isNew: convo.isNew, mode: a.mode });
      })().catch((err) => {
        log.error('match failed', err);
        for (const id of [a.userId, b.userId]) hub.push(id, { type: 'match.error', error: 'Matching hiccuped. Try again.' });
      });
    },
  });
  hub.setWaitingCounter(() => matchmaker.waitingByRole());
  hub.onDisconnect((userId) => {
    if (matchmaker.leave(userId)) presenceChanged();
    // Paused, suspended or deleted (not just signed out everywhere): tell their chat partners why
    // the conversation stopped, instead of leaving them typing to no one.
    (async () => {
      const u = await store.getUser(userId);
      if (!u || u.status === 'active') return;
      const reason = u.status === 'deleted' ? 'left' : 'unavailable';
      for (const c of await store.listConversations(userId)) hub.push(c.partner.id, { type: 'conversation.ended', conversationId: c.id, reason });
    })().catch((err) => log.error('notifying partners failed', err));
  });
  // match.leave can arrive while a join is still looking things up: count leaves per user so the
  // join notices and doesn't queue someone who already said stop.
  const leaves = new Map(); // userId -> number of leaves seen

  // Tell everyone when the queue changes (at most every 2s), so "someone is waiting for a
  // listener" shows up right away instead of on the next poll.
  let presenceTimer = null;
  const presenceChanged = () => {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      hub.broadcast({ type: 'presence', ...hub.stats() });
    }, presenceThrottleMs);
  };
  const sweep = setInterval(() => matchmaker.sweep(), sweepMs);
  sweep.unref();

  // Messages left for the next listener count as people waiting to talk (the home banner).
  const refreshBottles = () => store.openBottleCount(Date.now() - BOTTLE_TTL_MS).then((n) => {
    hub.setBottleCount(n);
    presenceChanged();
  }, (err) => log.error('bottle count failed', err));
  hub.onBottlesChanged(refreshBottles);
  refreshBottles();
  const bottleTimer = setInterval(refreshBottles, 60000);
  bottleTimer.unref();

  // A listener nobody is waiting for live picks up the oldest message left for the next listener.
  const underDailyCap = async (userId) => {
    const [today, u] = await Promise.all([store.conversationsStartedSince(userId, Date.now() - DAY_MS), store.getUser(userId)]);
    return today < (u?.plusUntil > Date.now() ? dailyMatchLimit * 3 : dailyMatchLimit);
  };
  const answerBottle = async (listener, blocked) => {
    const candidates = await store.openBottleCandidates(listener.id, Date.now() - BOTTLE_TTL_MS);
    for (const b of candidates) {
      if (blocked.has(b.userId)) continue;
      if (matchmaker.isQueued(b.userId)) continue; // they're searching live right now; live matching handles them
      if (!(await underDailyCap(b.userId))) continue; // the daily new-people cap applies to messages too
      if (!(await store.claimBottle(b.id, listener.id))) continue; // another listener got it
      if (matchmaker.isQueued(b.userId) || !matchmaker.leave(listener.id)) { // either side matched/joined live meanwhile: put it back
        await store.releaseBottle(b.id);
        return;
      }
      let convo;
      try {
        convo = await store.openConversation(b.userId, listener.id);
        await store.addMessage({ conversationId: convo.id, senderId: b.userId, body: b.body, flags: b.crisis ? ['crisis'] : undefined });
        await store.setBottleConversation(b.id, convo.id);
      } catch (err) {
        log.error('answering a waiting message failed', err);
        await store.releaseBottle(b.id).catch(() => {});
        hub.push(listener.id, { type: 'match.error', error: 'Matching hiccuped. Try again.' });
        return;
      }
      hub.push(listener.id, { type: 'match.found', conversationId: convo.id, partner: { handle: b.handle }, isNew: convo.isNew, fromMessage: true });
      hub.push(b.userId, { type: 'bottle.answered', conversationId: convo.id, partner: { handle: listener.handle } });
      if (!hub.isOnline(b.userId) && push?.enabled) {
        push.notify(store, b.userId, { title: 'Kindred', body: 'Someone is here to listen to your message', conversationId: convo.id, tag: convo.id })
          .catch((err) => log.error('push failed', err));
      }
      refreshBottles();
      return;
    }
  };

  const alertTimers = new Map(); // talker -> pending timer
  const lastAlertFor = new Map(); // talker -> when their wait last alerted listeners
  const alertListeners = async (talkerId, blocked) => {
    const now = Date.now();
    const before = now - listenerAlert.cooldownMs;
    const ids = await store.listenerAlertCandidates({ before, limit: listenerAlert.batch * 5 });
    let sent = 0;
    for (const id of ids) {
      if (sent >= listenerAlert.batch) break;
      // People with the app open already see the "waiting for a listener" banner.
      if (id === talkerId || blocked.has(id) || hub.isOnline(id)) continue;
      if (!(await store.claimListenerAlert(id, before, now))) continue;
      sent += 1;
      // Nothing about who is waiting: lock screens are public.
      push.notify(store, id, { title: 'Someone needs a listener', body: 'A person on Kindred is waiting to talk. Open the app if you have a few minutes.', tag: 'listener-needed' })
        .catch((err) => log.error('listener alert failed', err));
    }
  };
  const scheduleListenerAlert = (talkerId, blocked) => {
    if (!push?.enabled || alertTimers.has(talkerId)) return;
    if (Date.now() - (lastAlertFor.get(talkerId) || 0) < listenerAlert.perTalkerMs) return;
    const timer = setTimeout(() => {
      alertTimers.delete(talkerId);
      if (!matchmaker.isQueued(talkerId)) return; // matched or left meanwhile
      const t = Date.now();
      if (lastAlertFor.size > 10000) for (const [k, v] of lastAlertFor) if (t - v > listenerAlert.perTalkerMs) lastAlertFor.delete(k);
      lastAlertFor.set(talkerId, t);
      alertListeners(talkerId, blocked).catch((err) => log.error('listener alert failed', err));
    }, listenerAlert.afterMs);
    timer.unref();
    alertTimers.set(talkerId, timer);
  };

  server.on('upgrade', async (req, socket, head) => {
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      if (new URL(req.url, 'http://x').pathname !== '/ws') return reject(404, 'Not Found');
      // Cookies ride along on cross-site WebSocket handshakes, so check the origin.
      if (!originAllowed(req, allowedOrigins)) return reject(403, 'Forbidden');
      const token = readCookie(req, COOKIE);
      const user = token ? await store.findSessionUser(hashToken(token)) : null;
      if (!user) return reject(401, 'Unauthorized');
      if (user.status !== 'active') return reject(403, 'Forbidden');
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, user));
    } catch (err) {
      log.error('upgrade failed', err);
      reject(500, 'Internal Server Error');
    }
  });

  wss.on('connection', (ws, user) => {
    hub.add(user.id, ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Simple flood guard: at most 30 events per 10 seconds per socket.
    let windowStart = Date.now();
    let count = 0;

    // Joins the match queue unless today's cap is reached or the socket went away meanwhile.
    const handleJoin = async (msg) => {
      const leavesAtStart = leaves.get(user.id) || 0;
      const role = typeof msg.role === 'string' ? msg.role : 'either';
      const mode = MODES.includes(msg.mode) ? msg.mode : 'talk';
      const topic = typeof msg.topic === 'string' ? msg.topic.trim().toLowerCase().slice(0, TOPIC_MAX) : '';
      const [blocked, known, today, ageBand] = await Promise.all([
        store.blockedIds(user.id),
        store.partnerIds(user.id),
        store.conversationsStartedSince(user.id, Date.now() - DAY_MS),
        store.ageBand(user.id),
      ]);
      // Kindred Plus members can meet more new people a day.
      const fresh = await store.getUser(user.id);
      const limit = fresh?.plusUntil > Date.now() ? dailyMatchLimit * 3 : dailyMatchLimit;
      if (today >= limit) {
        ws.send(JSON.stringify({ type: 'match.error', error: "You've met a lot of new people today. You can keep talking with anyone in your list, and matching opens again tomorrow." }));
        return;
      }
      // The socket may have closed while we looked those up; never queue someone who's gone.
      if (ws.readyState !== ws.OPEN) return;
      if ((leaves.get(user.id) || 0) !== leavesAtStart) return; // they pressed Cancel meanwhile
      ws.send(JSON.stringify({ type: 'match.waiting' }));
      const matched = matchmaker.join({ userId: user.id, role, mode, topic, ageBand, blocked, known });
      presenceChanged();
      // Listener alerts and messages left for a listener belong to the support mode only.
      if (mode !== 'talk') return;
      if (!matched && role === 'talk') scheduleListenerAlert(user.id, blocked);
      if (!matched && (role === 'listen' || role === 'either')) await answerBottle(user, blocked);
    };

    ws.on('message', async (raw) => {
      const t = Date.now();
      if (t - windowStart > 10000) { windowStart = t; count = 0; }
      if (++count > 30) return ws.close(4008, 'Slow down');

      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try {
        if (msg.type === 'match.join') {
          if (joining.has(user.id)) return;
          joining.add(user.id);
          try {
            await handleJoin(msg);
          } finally {
            joining.delete(user.id);
          }
        } else if (msg.type === 'match.leave') {
          if (leaves.size > 50000) leaves.clear();
          leaves.set(user.id, (leaves.get(user.id) || 0) + 1);
          if (matchmaker.leave(user.id)) presenceChanged();
          ws.send(JSON.stringify({ type: 'match.left' }));
        } else if (msg.type === 'game' && typeof msg.conversationId === 'string' && GAME_EVENTS.has(msg.kind)) {
          // Game moves (next card, "I smiled") go to the partner as-is; nothing is stored.
          const m = await store.getMembership(user.id, msg.conversationId);
          if (m && !(await store.isBlocked(user.id, m.partnerId))) {
            const card = Number.isInteger(msg.card) && msg.card >= 0 && msg.card < 1000 ? msg.card : undefined;
            hub.push(m.partnerId, { type: 'game', conversationId: m.id, kind: msg.kind, card });
          }
        } else if (msg.type === 'typing' && typeof msg.conversationId === 'string') {
          const m = await store.getMembership(user.id, msg.conversationId);
          if (m && !(await store.isBlocked(user.id, m.partnerId))) {
            hub.push(m.partnerId, { type: 'typing', conversationId: m.id });
          }
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (err) {
        log.error('ws message failed', err);
      }
    });

    ws.on('close', () => {
      if (hub.remove(user.id, ws) === 0 && matchmaker.leave(user.id)) presenceChanged();
    });
  });

  // Drop connections that stopped answering (phones going to sleep, dead networks).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  return {
    matchmaker,
    close() {
      clearTimeout(presenceTimer);
      for (const timer of alertTimers.values()) clearTimeout(timer);
      clearInterval(bottleTimer);
      clearInterval(sweep);
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

module.exports = { createHub, attachRealtime };
