const { WebSocketServer } = require('ws');
const { createMatchmaker } = require('./matchmaker');
const { readCookie, hashToken, COOKIE } = require('./auth');

const TOPIC_MAX = 30;

// Tracks which sockets belong to which user so any part of the server can push events.
function createHub() {
  const sockets = new Map(); // userId -> Set<WebSocket>
  return {
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
    push(userId, event) {
      const data = JSON.stringify(event);
      for (const ws of sockets.get(userId) || []) if (ws.readyState === ws.OPEN) ws.send(data);
    },
    disconnect(userId) {
      for (const ws of sockets.get(userId) || []) ws.close(4003, 'Account unavailable');
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

function attachRealtime({ server, hub, store, allowedOrigins = [], sameRoleAfterMs, sweepMs = 5000, log = console }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  const matchmaker = createMatchmaker({
    sameRoleAfterMs,
    onMatch: (a, b) => {
      (async () => {
        const [ua, ub] = await Promise.all([store.getUser(a.userId), store.getUser(b.userId)]);
        const convo = await store.openConversation(a.userId, b.userId);
        hub.push(a.userId, { type: 'match.found', conversationId: convo.id, partner: { handle: ub.handle }, isNew: convo.isNew });
        hub.push(b.userId, { type: 'match.found', conversationId: convo.id, partner: { handle: ua.handle }, isNew: convo.isNew });
      })().catch((err) => {
        log.error('match failed', err);
        for (const id of [a.userId, b.userId]) hub.push(id, { type: 'match.error', error: 'Matching hiccuped. Try again.' });
      });
    },
  });
  const sweep = setInterval(() => matchmaker.sweep(), sweepMs);
  sweep.unref();

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

    ws.on('message', async (raw) => {
      const t = Date.now();
      if (t - windowStart > 10000) { windowStart = t; count = 0; }
      if (++count > 30) return ws.close(4008, 'Slow down');

      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try {
        if (msg.type === 'match.join') {
          const role = typeof msg.role === 'string' ? msg.role : 'either';
          const topic = typeof msg.topic === 'string' ? msg.topic.trim().toLowerCase().slice(0, TOPIC_MAX) : '';
          const [blocked, known] = await Promise.all([store.blockedIds(user.id), store.partnerIds(user.id)]);
          ws.send(JSON.stringify({ type: 'match.waiting' }));
          matchmaker.join({ userId: user.id, role, topic, blocked, known });
        } else if (msg.type === 'match.leave') {
          matchmaker.leave(user.id);
          ws.send(JSON.stringify({ type: 'match.left' }));
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
      if (hub.remove(user.id, ws) === 0) matchmaker.leave(user.id);
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
      clearInterval(sweep);
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

module.exports = { createHub, attachRealtime };
