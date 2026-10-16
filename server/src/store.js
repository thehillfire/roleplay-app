const crypto = require('crypto');
const { randomHandle } = require('./handles');

const newId = () => crypto.randomUUID();
const num = (v) => (v === null || v === undefined ? v : Number(v));
const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    role: row.role,
    status: row.status,
    connectCredits: num(row.connect_credits) || 0,
    createdAt: num(row.created_at),
  };
}

function messageFromRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body,
    status: row.status,
    flags: row.flags ? JSON.parse(row.flags) : [],
    createdAt: num(row.created_at),
  };
}

function reportFromRow(row) {
  return {
    id: row.id,
    reason: row.reason,
    details: row.details,
    status: row.status,
    createdAt: num(row.created_at),
    resolvedAt: num(row.resolved_at),
    resolution: row.resolution,
    conversationId: row.conversation_id,
    reporter: { id: row.reporter_id, handle: row.reporter_handle },
    reported: { id: row.reported_id, handle: row.reported_handle, status: row.reported_status },
    snapshot: JSON.parse(row.snapshot),
  };
}

function createStore(db, { now = Date.now, rng = Math.random } = {}) {
  const store = {
    // --- users & sessions ---

    async createUser({ email, passwordHash, birthdate }) {
      const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (exists.rows.length) return null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const user = { id: newId(), email, handle: randomHandle(rng), role: 'member', status: 'active', connectCredits: 0, createdAt: now() };
        try {
          await db.query(
            'INSERT INTO users (id, email, handle, password_hash, birthdate, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
            [user.id, email, user.handle, passwordHash, birthdate, user.createdAt],
          );
          return user;
        } catch (err) {
          if (!/unique|duplicate/i.test(err.message)) throw err;
          // Email raced in, or the handle was taken: retry with a new handle.
          const again = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
          if (again.rows.length) return null;
        }
      }
      throw new Error('Could not allocate a unique handle');
    },

    async findUserByEmail(email) {
      const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
      return rows[0] ? { ...userFromRow(rows[0]), passwordHash: rows[0].password_hash } : null;
    },

    async getUser(id) {
      const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
      return userFromRow(rows[0]);
    },

    async createSession(tokenHash, userId, ttlMs) {
      await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, now() + ttlMs]);
    },

    async findSessionUser(tokenHash) {
      const { rows } = await db.query(
        'SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1',
        [tokenHash],
      );
      const row = rows[0];
      if (!row) return null;
      if (num(row.expires_at) < now()) {
        await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
        return null;
      }
      return userFromRow(row);
    },

    async deleteSession(tokenHash) {
      await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    },

    // --- blocks ---

    // Everyone this user must never be matched or messaged with, in either direction.
    async blockedIds(userId) {
      const { rows } = await db.query(
        'SELECT blocked_id AS id FROM blocks WHERE blocker_id = $1 UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = $1',
        [userId],
      );
      return new Set(rows.map((r) => r.id));
    },

    async isBlocked(a, b) {
      const { rows } = await db.query(
        'SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
        [a, b],
      );
      return rows.length > 0;
    },

    async block(blockerId, blockedId) {
      await db.query(
        'INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [blockerId, blockedId, now()],
      );
    },

    // --- conversations ---

    // One thread per pair: matching with someone again continues the same conversation.
    async openConversation(a, b) {
      const key = pairKey(a, b);
      const t = now();
      const inserted = await db.query(
        `INSERT INTO conversations (id, pair_key, user_a, user_b, created_at, last_message_at)
         VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (pair_key) DO NOTHING`,
        [newId(), key, a < b ? a : b, a < b ? b : a, t],
      );
      const { rows } = await db.query('SELECT id FROM conversations WHERE pair_key = $1', [key]);
      return { id: rows[0].id, isNew: inserted.rowCount === 1 };
    },

    // Returns { id, partnerId } if the user is in the conversation, else null.
    async getMembership(userId, conversationId) {
      const { rows } = await db.query('SELECT user_a, user_b FROM conversations WHERE id = $1', [conversationId]);
      const row = rows[0];
      if (!row || (row.user_a !== userId && row.user_b !== userId)) return null;
      return { id: conversationId, partnerId: row.user_a === userId ? row.user_b : row.user_a };
    },

    async partnerIds(userId) {
      const { rows } = await db.query(
        'SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS id FROM conversations WHERE user_a = $1 OR user_b = $1',
        [userId],
      );
      return new Set(rows.map((r) => r.id));
    },

    async listConversations(userId) {
      const { rows } = await db.query(
        `SELECT c.id, c.last_message_at, c.created_at,
                CASE WHEN c.user_a = $1 THEN c.read_a ELSE c.read_b END AS my_read,
                p.id AS partner_id, p.handle AS partner_handle,
                (SELECT COUNT(*) FROM messages m
                   WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.status = 'delivered'
                     AND m.created_at > CASE WHEN c.user_a = $1 THEN c.read_a ELSE c.read_b END) AS unread,
                (SELECT m.body FROM messages m WHERE m.conversation_id = c.id AND (m.status = 'delivered' OR m.sender_id = $1)
                   ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
                (SELECT m.sender_id FROM messages m WHERE m.conversation_id = c.id AND (m.status = 'delivered' OR m.sender_id = $1)
                   ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender
           FROM conversations c
           JOIN users p ON p.id = CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END
          WHERE (c.user_a = $1 OR c.user_b = $1)
            AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = p.id) OR (b.blocker_id = p.id AND b.blocked_id = $1))
          ORDER BY c.last_message_at DESC`,
        [userId],
      );
      return rows.map((r) => ({
        id: r.id,
        partner: { id: r.partner_id, handle: r.partner_handle },
        unread: Number(r.unread),
        lastMessage: r.last_body === null || r.last_body === undefined ? null : { body: r.last_body, fromMe: r.last_sender === userId },
        lastMessageAt: num(r.last_message_at),
        createdAt: num(r.created_at),
      }));
    },

    // Messages visible to this user: everything delivered, plus their own held messages.
    async listMessages(userId, conversationId, { before, limit = 50 } = {}) {
      const params = [conversationId, userId, Math.min(Math.max(limit, 1), 100)];
      let beforeClause = '';
      if (before) {
        params.push(before);
        beforeClause = 'AND created_at < $4';
      }
      const { rows } = await db.query(
        `SELECT * FROM messages WHERE conversation_id = $1 AND (status = 'delivered' OR sender_id = $2) ${beforeClause}
         ORDER BY created_at DESC, id DESC LIMIT $3`,
        params,
      );
      return rows.map(messageFromRow).reverse();
    },

    async addMessage({ conversationId, senderId, body, status = 'delivered', flags }) {
      const t = now();
      const message = { id: newId(), conversationId, senderId, body, status, flags: flags || [], createdAt: t };
      await db.query(
        'INSERT INTO messages (id, conversation_id, sender_id, body, status, flags, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [message.id, conversationId, senderId, body, status, flags ? JSON.stringify(flags) : null, t],
      );
      if (status === 'delivered') {
        await db.query('UPDATE conversations SET last_message_at = $1 WHERE id = $2', [t, conversationId]);
      }
      return message;
    },

    async markRead(userId, conversationId, at = now()) {
      await db.query(
        `UPDATE conversations SET
           read_a = CASE WHEN user_a = $1 AND read_a < $3 THEN $3 ELSE read_a END,
           read_b = CASE WHEN user_b = $1 AND read_b < $3 THEN $3 ELSE read_b END
         WHERE id = $2`,
        [userId, conversationId, at],
      );
    },

    // --- safety ---

    async setUserStatus(userId, status) {
      await db.query('UPDATE users SET status = $1 WHERE id = $2', [status, userId]);
    },

    async setUserRole(email, role) {
      const { rowCount } = await db.query('UPDATE users SET role = $1 WHERE email = $2', [role, email]);
      return rowCount > 0;
    },

    async createReport({ reporterId, reportedId, conversationId, reason, details }) {
      // Moderators see the recent conversation as it was when reported.
      const { rows } = await db.query(
        `SELECT m.sender_id, m.body, m.status, m.created_at FROM messages m
          WHERE m.conversation_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT 30`,
        [conversationId],
      );
      const snapshot = rows.reverse().map((r) => ({
        from: r.sender_id === reportedId ? 'reported' : 'reporter',
        body: r.body,
        held: r.status !== 'delivered',
        at: num(r.created_at),
      }));
      const report = { id: newId(), createdAt: now() };
      await db.query(
        `INSERT INTO reports (id, reporter_id, reported_id, conversation_id, reason, details, snapshot, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [report.id, reporterId, reportedId, conversationId, reason, details || null, JSON.stringify(snapshot), report.createdAt],
      );
      return report;
    },

    // Distinct people who reported this user since `since`, optionally for one reason.
    async distinctReporters(reportedId, since, reason) {
      const params = [reportedId, since];
      let extra = '';
      if (reason) {
        params.push(reason);
        extra = 'AND reason = $3';
      }
      const { rows } = await db.query(
        `SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE reported_id = $1 AND created_at >= $2 ${extra}`,
        params,
      );
      return Number(rows[0].n);
    },

    async listReports({ status = 'open', limit = 50 } = {}) {
      const { rows } = await db.query(
        `SELECT r.*, a.handle AS reporter_handle, b.handle AS reported_handle, b.status AS reported_status
           FROM reports r JOIN users a ON a.id = r.reporter_id JOIN users b ON b.id = r.reported_id
          WHERE r.status = $1 ORDER BY r.created_at ASC LIMIT $2`,
        [status, limit],
      );
      return rows.map(reportFromRow);
    },

    async getReport(id) {
      const { rows } = await db.query(
        `SELECT r.*, a.handle AS reporter_handle, b.handle AS reported_handle, b.status AS reported_status
           FROM reports r JOIN users a ON a.id = r.reporter_id JOIN users b ON b.id = r.reported_id WHERE r.id = $1`,
        [id],
      );
      return rows[0] ? reportFromRow(rows[0]) : null;
    },

    async resolveReport(id, resolution) {
      const { rowCount } = await db.query(
        "UPDATE reports SET status = 'resolved', resolution = $1, resolved_at = $2 WHERE id = $3 AND status = 'open'",
        [resolution, now(), id],
      );
      return rowCount > 0;
    },

    // --- connect (mutual reveal) ---

    async getConnection(conversationId) {
      const { rows } = await db.query('SELECT * FROM connections WHERE conversation_id = $1', [conversationId]);
      const r = rows[0];
      if (!r) return null;
      return {
        conversationId: r.conversation_id,
        requesterId: r.requester_id,
        requester: { name: r.requester_name, contact: r.requester_contact },
        accepter: { name: r.accepter_name, contact: r.accepter_contact },
        status: r.status,
        paid: Number(r.paid) === 1,
        createdAt: num(r.created_at),
        respondedAt: num(r.responded_at),
      };
    },

    // Spends one credit if the user has one. Returns false otherwise (atomic).
    async spendCredit(userId) {
      const { rowCount } = await db.query(
        'UPDATE users SET connect_credits = connect_credits - 1 WHERE id = $1 AND connect_credits > 0',
        [userId],
      );
      return rowCount === 1;
    },

    async addCredits(userId, n) {
      await db.query('UPDATE users SET connect_credits = connect_credits + $1 WHERE id = $2', [n, userId]);
    },

    async createConnectRequest({ conversationId, requesterId, name, contact, paid }) {
      const { rowCount } = await db.query(
        `INSERT INTO connections (conversation_id, requester_id, requester_name, requester_contact, paid, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (conversation_id) DO NOTHING`,
        [conversationId, requesterId, name, contact || null, paid ? 1 : 0, now()],
      );
      return rowCount === 1;
    },

    async cancelConnectRequest(conversationId, requesterId) {
      const { rowCount } = await db.query(
        "DELETE FROM connections WHERE conversation_id = $1 AND requester_id = $2 AND status = 'pending'",
        [conversationId, requesterId],
      );
      return rowCount === 1;
    },

    async respondToConnect(conversationId, { accept, name, contact }) {
      const { rowCount } = await db.query(
        `UPDATE connections SET status = $1, accepter_name = $2, accepter_contact = $3, responded_at = $4
         WHERE conversation_id = $5 AND status = 'pending'`,
        [accept ? 'accepted' : 'declined', accept ? name : null, accept ? contact || null : null, now(), conversationId],
      );
      return rowCount === 1;
    },

    // Records a completed payment once (webhooks can be retried) and grants its credits.
    async recordPayment({ id, userId, amountCents, credits }) {
      const { rowCount } = await db.query(
        'INSERT INTO payments (id, user_id, amount_cents, credits, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
        [id, userId, amountCents, credits, now()],
      );
      if (rowCount === 1) await store.addCredits(userId, credits);
      return rowCount === 1;
    },

    // --- push notifications ---

    async savePushSubscription(userId, subscription) {
      // An endpoint belongs to one browser; if someone else signs in there, it moves to them.
      await db.query(
        `INSERT INTO push_subscriptions (endpoint, user_id, subscription, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = $2, subscription = $3`,
        [subscription.endpoint, userId, JSON.stringify(subscription), now()],
      );
    },

    async deletePushSubscription(endpoint, userId) {
      const params = [endpoint];
      let extra = '';
      if (userId) {
        params.push(userId);
        extra = 'AND user_id = $2';
      }
      await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 ${extra}`, params);
    },

    async pushSubscriptions(userId) {
      const { rows } = await db.query('SELECT subscription FROM push_subscriptions WHERE user_id = $1', [userId]);
      return rows.map((r) => JSON.parse(r.subscription));
    },

    // --- account lifecycle ---

    // Everything we hold about the user that they can see, as plain data.
    async exportAccount(userId) {
      const user = await store.getUser(userId);
      const { rows: [raw] } = await db.query('SELECT birthdate FROM users WHERE id = $1', [userId]);
      const conversations = await store.listConversations(userId);
      const threads = [];
      for (const c of conversations) {
        const { rows } = await db.query(
          `SELECT body, status, sender_id, created_at FROM messages WHERE conversation_id = $1 AND (status = 'delivered' OR sender_id = $2)
           ORDER BY created_at ASC, id ASC`,
          [c.id, userId],
        );
        const connection = await store.getConnection(c.id);
        threads.push({
          with: c.partner.handle,
          startedAt: new Date(c.createdAt).toISOString(),
          connection: connection ? { status: connection.status, youRequested: connection.requesterId === userId } : null,
          messages: rows.map((m) => ({
            from: m.sender_id === userId ? 'you' : c.partner.handle,
            body: m.body,
            delivered: m.status === 'delivered',
            at: new Date(num(m.created_at)).toISOString(),
          })),
        });
      }
      const { rows: reports } = await db.query('SELECT reason, details, created_at, status FROM reports WHERE reporter_id = $1', [userId]);
      return {
        exportedAt: new Date(now()).toISOString(),
        account: { handle: user.handle, email: user.email, birthdate: raw.birthdate, createdAt: new Date(user.createdAt).toISOString(), connectCredits: user.connectCredits },
        conversations: threads,
        reportsYouFiled: reports.map((r) => ({ reason: r.reason, details: r.details, status: r.status, at: new Date(num(r.created_at)).toISOString() })),
      };
    },

    // Scrubs personal data right away; messages and reports stay (for safety review)
    // until purgeDeleted() runs after the retention period.
    async deleteAccount(userId) {
      const t = now();
      await db.query(
        `UPDATE users SET email = $1, password_hash = '!', birthdate = '0000-00-00', status = 'deleted', role = 'member', deleted_at = $2
         WHERE id = $3`,
        [`deleted+${userId}@deleted.invalid`, t, userId],
      );
      await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
      await db.query("UPDATE connections SET requester_name = '(deleted)', requester_contact = NULL WHERE requester_id = $1", [userId]);
      await db.query(
        `UPDATE connections SET accepter_name = '(deleted)', accepter_contact = NULL
          WHERE requester_id <> $1 AND conversation_id IN (SELECT id FROM conversations WHERE user_a = $1 OR user_b = $1)`,
        [userId],
      );
    },

    // Fully removes accounts deleted before `before` (cascades to their messages, chats and reports).
    async purgeDeleted(before) {
      const { rowCount } = await db.query("DELETE FROM users WHERE status = 'deleted' AND deleted_at < $1", [before]);
      return rowCount;
    },

    async listHeldMessages({ limit = 50 } = {}) {
      const { rows } = await db.query(
        `SELECT m.*, u.handle AS sender_handle, u.status AS sender_status FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.status = 'held' ORDER BY m.created_at DESC LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({ ...messageFromRow(r), sender: { id: r.sender_id, handle: r.sender_handle, status: r.sender_status } }));
    },
  };
  return store;
}

module.exports = { createStore, pairKey };
