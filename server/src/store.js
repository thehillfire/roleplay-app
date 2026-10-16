const crypto = require('crypto');
const { randomHandle } = require('./handles');
const { ageOn } = require('./validate');

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
    emailVerified: Boolean(row.email_verified_at),
    plusUntil: num(row.plus_until) || 0,
    listenerAlerts: Boolean(num(row.listener_alerts)),
    notice: row.notice || null,
    stripeCustomerId: row.stripe_customer_id || null,
    plusSubscriptionId: row.plus_subscription_id || null,
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
    reaction: row.reaction || null,
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
    async ping() {
      await db.query('SELECT 1');
    },

    // --- users & sessions ---

    async createUser({ email, passwordHash, birthdate }) {
      const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (exists.rows.length) return null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const user = { id: newId(), email, handle: randomHandle(rng), role: 'member', status: 'active', connectCredits: 0, emailVerified: false, createdAt: now() };
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

    // Coarse age band used only for matching preference: '18-24' | '25-34' | '35-49' | '50+'.
    async ageBand(userId) {
      const { rows } = await db.query('SELECT birthdate FROM users WHERE id = $1', [userId]);
      const age = ageOn(rows[0]?.birthdate, new Date(now()));
      if (!Number.isFinite(age)) return '';
      return age < 25 ? '18-24' : age < 35 ? '25-34' : age < 50 ? '35-49' : '50+';
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

    async deleteAllSessions(userId) {
      await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    },

    async deleteSession(tokenHash) {
      await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    },

    // --- email verification ---

    async createEmailVerification(tokenHash, userId, ttlMs) {
      await db.query('DELETE FROM email_verifications WHERE user_id = $1', [userId]); // only the newest link works
      await db.query('INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, now() + ttlMs]);
    },

    // Consumes a verification token. Returns the verified user, or null if invalid/expired.
    async useEmailVerification(tokenHash) {
      const { rows } = await db.query('SELECT user_id, expires_at FROM email_verifications WHERE token_hash = $1', [tokenHash]);
      await db.query('DELETE FROM email_verifications WHERE token_hash = $1', [tokenHash]);
      const row = rows[0];
      if (!row || num(row.expires_at) < now()) return null;
      if (!(await store.markEmailVerified(row.user_id))) return null;
      return store.getUser(row.user_id);
    },

    async markEmailVerified(userId) {
      const { rowCount } = await db.query(
        "UPDATE users SET email_verified_at = COALESCE(email_verified_at, $1) WHERE id = $2 AND status <> 'deleted'",
        [now(), userId],
      );
      return rowCount > 0;
    },

    // --- password reset ---

    async createPasswordReset(tokenHash, userId, ttlMs) {
      await db.query('DELETE FROM password_resets WHERE user_id = $1', [userId]); // only the newest link works
      await db.query('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, now() + ttlMs]);
    },

    // Consumes a reset token: sets the new password, signs out every session. Returns the user id or null.
    async usePasswordReset(tokenHash, passwordHash) {
      const { rows } = await db.query('SELECT user_id, expires_at FROM password_resets WHERE token_hash = $1', [tokenHash]);
      await db.query('DELETE FROM password_resets WHERE token_hash = $1', [tokenHash]);
      const row = rows[0];
      if (!row || num(row.expires_at) < now()) return null;
      const updated = await db.query("UPDATE users SET password_hash = $1 WHERE id = $2 AND status <> 'deleted'", [passwordHash, row.user_id]);
      if (updated.rowCount === 0) return null;
      await db.query('DELETE FROM sessions WHERE user_id = $1', [row.user_id]);
      return row.user_id;
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
      // Matched again: the conversation comes back for anyone who had hidden it.
      if (inserted.rowCount === 0) await db.query('UPDATE conversations SET hidden_a = 0, hidden_b = 0 WHERE pair_key = $1', [key]);
      const { rows } = await db.query('SELECT id FROM conversations WHERE pair_key = $1', [key]);
      return { id: rows[0].id, isNew: inserted.rowCount === 1 };
    },

    async muteConversation(userId, conversationId, muted) {
      await db.query('UPDATE conversations SET muted_a = $1 WHERE id = $2 AND user_a = $3', [muted ? 1 : 0, conversationId, userId]);
      await db.query('UPDATE conversations SET muted_b = $1 WHERE id = $2 AND user_b = $3', [muted ? 1 : 0, conversationId, userId]);
    },

    async hideConversation(userId, conversationId) {
      const t = now();
      await db.query('UPDATE conversations SET hidden_a = $1 WHERE id = $2 AND user_a = $3', [t, conversationId, userId]);
      await db.query('UPDATE conversations SET hidden_b = $1 WHERE id = $2 AND user_b = $3', [t, conversationId, userId]);
    },

    // Returns { id, partnerId } if the user is in the conversation, else null.
    async getMembership(userId, conversationId) {
      const { rows } = await db.query('SELECT user_a, user_b, read_a, read_b, muted_a, muted_b FROM conversations WHERE id = $1', [conversationId]);
      const row = rows[0];
      if (!row || (row.user_a !== userId && row.user_b !== userId)) return null;
      const iAmA = row.user_a === userId;
      return {
        id: conversationId,
        partnerId: iAmA ? row.user_b : row.user_a,
        partnerReadAt: num(iAmA ? row.read_b : row.read_a),
        muted: Number(iAmA ? row.muted_a : row.muted_b) === 1,
      };
    },

    // Forces committed data to disk where the database defers it (SQLite WAL); no-op on Postgres.
    async flush() {
      if (db.flush) await db.flush();
    },

    async partnerIds(userId) {
      const { rows } = await db.query(
        'SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS id FROM conversations WHERE user_a = $1 OR user_b = $1',
        [userId],
      );
      return new Set(rows.map((r) => r.id));
    },

    // Everything the send path needs in one round trip. Null if the user isn't in the conversation.
    async sendContext(userId, conversationId) {
      const { rows } = await db.query(
        `SELECT CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END AS partner_id,
                p.status AS partner_status,
                EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = p.id) OR (b.blocker_id = p.id AND b.blocked_id = $1)) AS blocked,
                (SELECT status FROM connections WHERE conversation_id = c.id) AS connection_status,
                CASE WHEN c.user_a = $1 THEN c.muted_b ELSE c.muted_a END AS partner_muted
           FROM conversations c
           JOIN users p ON p.id = CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END
          WHERE c.id = $2 AND (c.user_a = $1 OR c.user_b = $1)`,
        [userId, conversationId],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        id: conversationId,
        partnerId: r.partner_id,
        partnerStatus: r.partner_status,
        blocked: r.blocked === true || Number(r.blocked) === 1,
        connected: r.connection_status === 'accepted',
        partnerMuted: Number(r.partner_muted) === 1,
      };
    },

    // `visibleOnly` leaves out conversations the user hid, unless something happened since.
    async listConversations(userId, { visibleOnly = false, limit } = {}) {
      const visible = visibleOnly ? 'AND (CASE WHEN c.user_a = $1 THEN c.hidden_a ELSE c.hidden_b END) < c.last_message_at' : '';
      const { rows } = await db.query(
        `SELECT c.id, c.last_message_at, c.created_at,
                CASE WHEN c.user_a = $1 THEN c.read_a ELSE c.read_b END AS my_read,
                p.id AS partner_id, p.handle AS partner_handle,
                (SELECT COUNT(*) FROM messages m
                   WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.status = 'delivered'
                     AND m.created_at > CASE WHEN c.user_a = $1 THEN c.read_a ELSE c.read_b END) AS unread,
                (SELECT m.body FROM messages m WHERE m.conversation_id = c.id AND (m.status = 'delivered' OR (m.sender_id = $1 AND m.status = 'held'))
                   ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
                (SELECT m.sender_id FROM messages m WHERE m.conversation_id = c.id AND (m.status = 'delivered' OR (m.sender_id = $1 AND m.status = 'held'))
                   ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender
           FROM conversations c
           JOIN users p ON p.id = CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END
          WHERE (c.user_a = $1 OR c.user_b = $1)
            AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = p.id) OR (b.blocker_id = p.id AND b.blocked_id = $1))
            ${visible}
          ORDER BY c.last_message_at DESC
          ${limit ? 'LIMIT $2' : ''}`,
        limit ? [userId, limit] : [userId],
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
    // Pages backwards by (created_at, id) so messages sharing a millisecond are never skipped.
    async listMessages(userId, conversationId, { before, beforeId, limit = 50 } = {}) {
      const params = [conversationId, userId, Math.min(Math.max(limit, 1), 100)];
      let beforeClause = '';
      if (before && beforeId) {
        params.push(before, beforeId);
        beforeClause = 'AND (created_at < $4 OR (created_at = $4 AND id < $5))';
      } else if (before) {
        params.push(before);
        beforeClause = 'AND created_at < $4';
      }
      const { rows } = await db.query(
        `SELECT * FROM messages WHERE conversation_id = $1 AND (status IN ('delivered', 'unsent') OR sender_id = $2) ${beforeClause}
         ORDER BY created_at DESC, id DESC LIMIT $3`,
        params,
      );
      // Unsent messages stay in place as a placeholder; their text never goes back to either side.
      return rows.map(messageFromRow).map((m) => (m.status === 'unsent' ? { ...m, body: '' } : m)).reverse();
    },

    async addMessage({ conversationId, senderId, body, status = 'delivered', flags }) {
      const t = now();
      const message = { id: newId(), conversationId, senderId, body, status, flags: flags || [], createdAt: t };
      await db.query(
        'INSERT INTO messages (id, conversation_id, sender_id, body, status, flags, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [message.id, conversationId, senderId, body, status, flags ? JSON.stringify(flags) : null, t],
      );
      // Bump the conversation (if delivered) and mark it read for the sender in the same statement.
      await db.query(
        `UPDATE conversations SET
           last_message_at = CASE WHEN $4 = 1 THEN $1 ELSE last_message_at END,
           read_a = CASE WHEN user_a = $3 AND read_a < $1 THEN $1 ELSE read_a END,
           read_b = CASE WHEN user_b = $3 AND read_b < $1 THEN $1 ELSE read_b END
         WHERE id = $2`,
        [t, conversationId, senderId, status === 'delivered' ? 1 : 0],
      );
      return message;
    },

    // The person who received a message can react to it (or clear the reaction with null).
    async setReaction(userId, conversationId, messageId, reaction) {
      const { rowCount } = await db.query(
        `UPDATE messages SET reaction = $1
          WHERE id = $2 AND conversation_id = $3 AND sender_id <> $4 AND status = 'delivered'`,
        [reaction, messageId, conversationId, userId],
      );
      return rowCount === 1;
    },

    // The sender can take a delivered message back for a short while (held ones stay for moderators). Returns false if it's not theirs or too old.
    async unsendMessage(userId, conversationId, messageId, windowMs) {
      const { rowCount } = await db.query(
        `UPDATE messages SET status = 'unsent'
          WHERE id = $1 AND conversation_id = $2 AND sender_id = $3 AND status = 'delivered' AND created_at >= $4`,
        [messageId, conversationId, userId, now() - windowMs],
      );
      return rowCount === 1;
    },

    async markRead(userId, conversationId, at = now()) {
      await db.query(
        `UPDATE conversations SET
           read_a = CASE WHEN user_a = $1 AND read_a < $3 THEN $3 ELSE read_a END,
           read_b = CASE WHEN user_b = $1 AND read_b < $3 THEN $3 ELSE read_b END
         WHERE id = $2`,
        [userId, conversationId, at],
      );
      return at;
    },

    // --- safety ---

    // Deleted accounts stay deleted (so retention purge still removes them).
    async setNotice(userId, text) {
      await db.query("UPDATE users SET notice = $1 WHERE id = $2 AND status <> 'deleted'", [text, userId]);
    },

    async setUserStatus(userId, status) {
      const { rowCount } = await db.query("UPDATE users SET status = $1 WHERE id = $2 AND status <> 'deleted'", [status, userId]);
      // A moderator's suspension covers the devices they used; restoring lifts it.
      if (rowCount > 0 && status === 'suspended') {
        await db.query(
          `INSERT INTO banned_devices (device_hash, user_id, created_at)
           SELECT device_hash, user_id, $2 FROM user_devices WHERE user_id = $1
           ON CONFLICT (device_hash, user_id) DO NOTHING`,
          [userId, now()],
        );
      } else if (rowCount > 0 && status === 'active') {
        await db.query('DELETE FROM banned_devices WHERE user_id = $1', [userId]);
      }
      return rowCount > 0;
    },

    // Remembers a browser this account used. A suspended account's new devices are banned too.
    async noteDevice(userId, deviceHash) {
      const t = now();
      await db.query(
        `INSERT INTO user_devices (user_id, device_hash, last_seen) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, device_hash) DO UPDATE SET last_seen = $3`,
        [userId, deviceHash, t],
      );
      await db.query(
        `INSERT INTO banned_devices (device_hash, user_id, created_at)
         SELECT $2, id, $3 FROM users WHERE id = $1 AND status = 'suspended'
         ON CONFLICT (device_hash, user_id) DO NOTHING`,
        [userId, deviceHash, t],
      );
    },

    async deviceBanned(deviceHash) {
      const { rows } = await db.query('SELECT 1 FROM banned_devices WHERE device_hash = $1 LIMIT 1', [deviceHash]);
      return rows.length > 0;
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
        held: r.status === 'held',
        unsent: r.status === 'unsent',
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
    // Distinct people who reported this user since `since`. Only reporters whose accounts were at
    // least `minReporterAgeMs` old when they reported count, so fresh throwaway accounts can't brigade.
    async distinctReporters(reportedId, since, { reason, minReporterAgeMs = 0 } = {}) {
      const params = [reportedId, since, minReporterAgeMs];
      let extra = '';
      if (reason) {
        params.push(reason);
        extra = 'AND r.reason = $4';
      }
      const { rows } = await db.query(
        `SELECT COUNT(DISTINCT r.reporter_id) AS n FROM reports r JOIN users u ON u.id = r.reporter_id
          WHERE r.reported_id = $1 AND r.created_at >= $2 AND r.created_at - u.created_at >= $3 ${extra}`,
        params,
      );
      return Number(rows[0].n);
    },

    // New conversations this user started (by matching) since `since`.
    async conversationsStartedSince(userId, since) {
      const { rows } = await db.query(
        'SELECT COUNT(*) AS n FROM conversations WHERE (user_a = $1 OR user_b = $1) AND created_at >= $2',
        [userId, since],
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

    // --- private daily check-ins ---

    // `day` is the person's local date (YYYY-MM-DD) so "today" matches their clock.
    async saveCheckin(userId, day, mood) {
      await db.query(
        `INSERT INTO checkins (user_id, day, mood, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, day) DO UPDATE SET mood = $3`,
        [userId, day, mood, now()],
      );
    },

    async recentCheckins(userId, limit = 14) {
      const { rows } = await db.query('SELECT day, mood FROM checkins WHERE user_id = $1 ORDER BY day DESC LIMIT $2', [userId, limit]);
      return rows.map((r) => ({ day: r.day, mood: Number(r.mood) })).reverse();
    },

    // --- feedback ---

    // Returns true if this was a new "helpful" vote (so the listener can be thanked live).
    async saveFeedback({ conversationId, raterId, rateeId, helpful }) {
      const before = await db.query('SELECT helpful FROM feedback WHERE conversation_id = $1 AND rater_id = $2', [conversationId, raterId]);
      await db.query(
        `INSERT INTO feedback (conversation_id, rater_id, ratee_id, helpful, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (conversation_id, rater_id) DO UPDATE SET helpful = $4`,
        [conversationId, raterId, rateeId, helpful ? 1 : 0, now()],
      );
      // Only the first vote thanks them live, so flipping the answer can't spam notifications.
      return helpful && !before.rows[0];
    },

    async myFeedback(conversationId, raterId) {
      const { rows } = await db.query('SELECT helpful FROM feedback WHERE conversation_id = $1 AND rater_id = $2', [conversationId, raterId]);
      return rows[0] ? Number(rows[0].helpful) === 1 : null;
    },

    // A note on an existing "helped" vote; false if there's no such vote.
    async saveKindWords(conversationId, raterId, note) {
      const { rowCount } = await db.query(
        // A note the recipient removed stays removed: the writer can't bring it back.
        'UPDATE feedback SET note = $1, note_at = $2, note_id = $3 WHERE conversation_id = $4 AND rater_id = $5 AND helpful = 1 AND note_hidden = 0',
        [note, now(), newId(), conversationId, raterId],
      );
      return rowCount === 1;
    },

    // Notes people left for this user, newest first. Never who wrote them.
    async kindWordsFor(userId, limit = 20) {
      const { rows } = await db.query(
        `SELECT f.note_id, f.note, f.note_at FROM feedback f
          WHERE f.ratee_id = $1 AND f.helpful = 1 AND f.note IS NOT NULL AND f.note_hidden = 0
            AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = f.rater_id) OR (b.blocker_id = f.rater_id AND b.blocked_id = $1))
          ORDER BY f.note_at DESC LIMIT $2`,
        [userId, limit],
      );
      return rows.map((r) => ({ id: r.note_id, note: r.note, at: num(r.note_at) }));
    },

    async hideKindWords(userId, noteId) {
      const { rowCount } = await db.query('UPDATE feedback SET note_hidden = 1 WHERE ratee_id = $1 AND note_id = $2 AND note IS NOT NULL', [userId, noteId]);
      return rowCount > 0;
    },

    // How many different people said this user helped them.
    async helpedCount(userId) {
      const { rows } = await db.query('SELECT COUNT(DISTINCT rater_id) AS n FROM feedback WHERE ratee_id = $1 AND helpful = 1', [userId]);
      return Number(rows[0].n);
    },

    // Messages each side has sent that the other could see (to decide when to ask "did this help?").
    async messageCounts(conversationId, userId) {
      const { rows } = await db.query(
        `SELECT SUM(CASE WHEN sender_id = $2 THEN 1 ELSE 0 END) AS mine, SUM(CASE WHEN sender_id <> $2 THEN 1 ELSE 0 END) AS theirs
           FROM messages WHERE conversation_id = $1 AND status = 'delivered'`,
        [conversationId, userId],
      );
      return { mine: Number(rows[0].mine) || 0, theirs: Number(rows[0].theirs) || 0 };
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

    async deletePushSubscriptionsFor(userId) {
      await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
    },

    // --- listeners on call ---

    async setListenerAlerts(userId, on) {
      await db.query('UPDATE users SET listener_alerts = $1 WHERE id = $2', [on ? 1 : 0, userId]);
    },

    // Opted-in listeners with a device to notify who haven't been alerted since `before`,
    // longest-rested first so alerts rotate through everyone.
    async listenerAlertCandidates({ before, limit }) {
      const { rows } = await db.query(
        `SELECT id FROM users WHERE listener_alerts = 1 AND status = 'active' AND listener_alerted_at < $1
           AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = users.id)
         ORDER BY listener_alerted_at LIMIT $2`,
        [before, limit],
      );
      return rows.map((r) => r.id);
    },

    // Claims one listener for an alert; false when another alert just did.
    async claimListenerAlert(userId, before, now) {
      const { rowCount } = await db.query(
        'UPDATE users SET listener_alerted_at = $1 WHERE id = $2 AND listener_alerted_at < $3',
        [now, userId, before],
      );
      return rowCount === 1;
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
          `SELECT body, status, sender_id, created_at FROM messages WHERE conversation_id = $1 AND status <> 'unsent' AND (status = 'delivered' OR sender_id = $2)
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
      const checkins = await store.recentCheckins(userId, 10000);
      return {
        exportedAt: new Date(now()).toISOString(),
        account: { handle: user.handle, email: user.email, birthdate: raw.birthdate, createdAt: new Date(user.createdAt).toISOString(), connectCredits: user.connectCredits },
        conversations: threads,
        reportsYouFiled: reports.map((r) => ({ reason: r.reason, details: r.details, status: r.status, at: new Date(num(r.created_at)).toISOString() })),
        dailyCheckins: checkins,
        supportRequests: (await store.mySupportRequests(userId)).map(({ id, ...r }) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() })), // eslint-disable-line no-unused-vars
        kindWordsYouReceived: (await store.kindWordsFor(userId, 10000)).map((k) => ({ note: k.note, at: new Date(k.at).toISOString() })),
      };
    },

    // Scrubs personal data right away; messages and reports stay (for safety review)
    // until purgeDeleted() runs after the retention period.
    async deleteAccount(userId) {
      const t = now();
      await db.query(
        `UPDATE users SET email = $1, password_hash = '!', birthdate = '0000-00-00', status = 'deleted', role = 'member', email_verified_at = NULL, deleted_at = $2,
             plus_subscription_id = NULL, listener_alerts = 0
         WHERE id = $3`,
        [`deleted+${userId}@deleted.invalid`, t, userId],
      );
      await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM email_verifications WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM checkins WHERE user_id = $1', [userId]); // private, no safety value
      await db.query('UPDATE feedback SET note = NULL WHERE rater_id = $1', [userId]); // words they wrote
      await db.query("UPDATE bottles SET status = 'withdrawn' WHERE user_id = $1 AND status = 'open'", [userId]);
      await db.query("UPDATE connections SET requester_name = '(deleted)', requester_contact = NULL WHERE requester_id = $1", [userId]);
      await db.query(
        `UPDATE connections SET accepter_name = '(deleted)', accepter_contact = NULL
          WHERE requester_id <> $1 AND conversation_id IN (SELECT id FROM conversations WHERE user_a = $1 OR user_b = $1)`,
        [userId],
      );
    },

    // Deletes messages older than `before` (report snapshots keep their own copy for moderators).
    async purgeOldMessages(before) {
      const { rowCount } = await db.query('DELETE FROM messages WHERE created_at < $1', [before]);
      return rowCount;
    },

    // Erases the transcript copy on reports resolved before `before` (the report record stays).
    async scrubResolvedReports(before) {
      const { rowCount } = await db.query(
        "UPDATE reports SET snapshot = '[]', details = NULL WHERE status = 'resolved' AND resolved_at < $1 AND snapshot <> '[]'",
        [before],
      );
      return rowCount;
    },

    // Fully removes accounts deleted before `before` (cascades to their messages, chats and reports).
    async purgeDeleted(before) {
      const { rowCount } = await db.query("DELETE FROM users WHERE status = 'deleted' AND deleted_at < $1", [before]);
      return rowCount;
    },

    // Headline numbers for the owner/moderators.
    async adminStats(t = now()) {
      const day = t - 24 * 60 * 60 * 1000;
      const week = t - 7 * 24 * 60 * 60 * 1000;
      const one = async (sql, params = []) => Number(Object.values((await db.query(sql, params)).rows[0])[0]) || 0;
      const [users, signupsDay, signupsWeek, activeDay, messagesDay, matchesDay, connectsAccepted, revenueCents, helpfulWeek, heldToReview, messagesWaiting, supportOpen] = await Promise.all([
        one("SELECT COUNT(*) FROM users WHERE status <> 'deleted'"),
        one("SELECT COUNT(*) FROM users WHERE created_at >= $1 AND status <> 'deleted'", [day]),
        one("SELECT COUNT(*) FROM users WHERE created_at >= $1 AND status <> 'deleted'", [week]),
        one("SELECT COUNT(DISTINCT sender_id) FROM messages WHERE created_at >= $1 AND status = 'delivered'", [day]),
        one("SELECT COUNT(*) FROM messages WHERE created_at >= $1 AND status = 'delivered'", [day]),
        one('SELECT COUNT(*) FROM conversations WHERE created_at >= $1', [day]),
        one("SELECT COUNT(*) FROM connections WHERE status = 'accepted'"),
        one('SELECT COALESCE(SUM(amount_cents), 0) FROM payments'),
        one('SELECT COUNT(*) FROM feedback WHERE helpful = 1 AND created_at >= $1', [week]),
        one("SELECT COUNT(*) FROM messages WHERE status = 'held' AND reviewed_at IS NULL"),
        one("SELECT COUNT(*) FROM bottles WHERE status = 'open' AND created_at >= $1", [day]),
        one("SELECT COUNT(*) FROM support_requests WHERE status = 'open'"),
      ]);
      return { users, signupsDay, signupsWeek, activeDay, messagesDay, matchesDay, connectsAccepted, revenueCents, helpfulWeek, heldToReview, messagesWaiting, supportOpen };
    },

    // --- moderation operations ---

    // Handles are copied in so the log still reads correctly after accounts are purged.
    async logModAction({ moderatorId, targetId, action, detail }) {
      const handleOf = async (id) => (id ? (await store.getUser(id))?.handle || null : null);
      const [moderatorHandle, targetHandle] = await Promise.all([handleOf(moderatorId), handleOf(targetId)]);
      await db.query(
        `INSERT INTO mod_actions (id, moderator_id, moderator_handle, target_id, target_handle, action, detail, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [newId(), moderatorId || null, moderatorHandle, targetId || null, targetHandle, action, detail || null, now()],
      );
    },

    // A moderator's view of one account by its handle (case-insensitive). Never the email:
    // anonymity holds for moderators too.
    async adminUserByHandle(handle) {
      const { rows: [u] } = await db.query('SELECT * FROM users WHERE LOWER(handle) = LOWER($1)', [handle]);
      if (!u) return null;
      const count = async (sql) => Number((await db.query(sql, [u.id])).rows[0].n);
      const [reportsOpen, reportsTotal, reportsMade, held] = await Promise.all([
        count("SELECT COUNT(*) AS n FROM reports WHERE reported_id = $1 AND status = 'open'"),
        count('SELECT COUNT(*) AS n FROM reports WHERE reported_id = $1'),
        count('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = $1'),
        count("SELECT COUNT(*) AS n FROM messages WHERE sender_id = $1 AND status = 'held'"),
      ]);
      const { rows: actions } = await db.query(
        'SELECT id, action, detail, moderator_id, moderator_handle, created_at FROM mod_actions WHERE target_id = $1 ORDER BY created_at DESC LIMIT 20',
        [u.id],
      );
      return {
        id: u.id, handle: u.handle, status: u.status, role: u.role, createdAt: num(u.created_at),
        plus: (num(u.plus_until) || 0) > now(),
        reportsOpen, reportsTotal, reportsMade, held,
        actions: actions.map((r) => ({ id: r.id, action: r.action, detail: r.detail, createdAt: num(r.created_at), moderator: r.moderator_id ? r.moderator_handle || '(former moderator)' : 'system' })),
      };
    },

    async listModActions(limit = 50) {
      const { rows } = await db.query('SELECT * FROM mod_actions ORDER BY created_at DESC LIMIT $1', [limit]);
      return rows.map((r) => ({
        id: r.id, action: r.action, detail: r.detail, createdAt: num(r.created_at),
        moderator: r.moderator_id ? r.moderator_handle || '(former moderator)' : 'system',
        target: r.target_handle || null,
      }));
    },

    async createAppeal(userId, message) {
      // One open appeal at a time; a new one replaces the old text.
      await db.query("DELETE FROM appeals WHERE user_id = $1 AND status = 'open'", [userId]);
      await db.query('INSERT INTO appeals (id, user_id, message, created_at) VALUES ($1, $2, $3, $4)', [newId(), userId, message, now()]);
    },

    async openAppeal(userId) {
      const { rows } = await db.query("SELECT message, created_at FROM appeals WHERE user_id = $1 AND status = 'open'", [userId]);
      return rows[0] ? { message: rows[0].message, createdAt: num(rows[0].created_at) } : null;
    },

    // --- support requests ---

    async createSupportRequest(userId, topic, message) {
      const { rows } = await db.query("SELECT COUNT(*) AS n FROM support_requests WHERE user_id = $1 AND status = 'open'", [userId]);
      if (Number(rows[0].n) >= 3) return null; // enough waiting from one person
      const id = newId();
      await db.query('INSERT INTO support_requests (id, user_id, topic, message, created_at) VALUES ($1, $2, $3, $4, $5)', [id, userId, topic, message, now()]);
      return id;
    },

    async mySupportRequests(userId) {
      const { rows } = await db.query('SELECT id, topic, message, status, reply, created_at FROM support_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId]);
      return rows.map((r) => ({ id: r.id, topic: r.topic, message: r.message, status: r.status, reply: r.reply, createdAt: num(r.created_at) }));
    },

    async listSupportRequests() {
      const { rows } = await db.query(
        `SELECT s.*, u.handle, u.status AS user_status FROM support_requests s JOIN users u ON u.id = s.user_id
          WHERE s.status = 'open' ORDER BY s.created_at ASC LIMIT 100`,
      );
      return rows.map((r) => ({ id: r.id, topic: r.topic, message: r.message, createdAt: num(r.created_at), user: { id: r.user_id, handle: r.handle, status: r.user_status } }));
    },

    // Closes an open request exactly once; returns who to reply to (email stays server-side).
    async resolveSupportRequest(id, reply) {
      const { rows } = await db.query('SELECT s.user_id, s.topic, u.email, u.handle, u.status, u.email_verified_at FROM support_requests s JOIN users u ON u.id = s.user_id WHERE s.id = $1', [id]);
      if (!rows[0]) return null;
      const { rowCount } = await db.query(
        "UPDATE support_requests SET status = 'resolved', reply = $1, resolved_at = $2 WHERE id = $3 AND status = 'open'",
        [reply || null, now(), id],
      );
      return rowCount === 1 ? { userId: rows[0].user_id, topic: rows[0].topic, email: rows[0].email, handle: rows[0].handle, deleted: rows[0].status === 'deleted', verified: Boolean(rows[0].email_verified_at) } : null;
    },

    async listAppeals() {
      const { rows } = await db.query(
        `SELECT a.*, u.handle, u.status AS user_status FROM appeals a JOIN users u ON u.id = a.user_id
          WHERE a.status = 'open' ORDER BY a.created_at ASC`,
      );
      return rows.map((r) => ({ id: r.id, message: r.message, createdAt: num(r.created_at), user: { id: r.user_id, handle: r.handle, status: r.user_status } }));
    },

    // Closes an open appeal exactly once (two moderators clicking at once can't both decide).
    async resolveAppeal(id) {
      const { rows } = await db.query('SELECT user_id FROM appeals WHERE id = $1', [id]);
      if (!rows[0]) return null;
      const { rowCount } = await db.query("UPDATE appeals SET status = 'resolved', resolved_at = $1 WHERE id = $2 AND status = 'open'", [now(), id]);
      return rowCount === 1 ? rows[0].user_id : null;
    },

    async moderatorEmails() {
      const { rows } = await db.query("SELECT email FROM users WHERE role = 'admin' AND status = 'active' AND email_verified_at IS NOT NULL");
      return rows.map((r) => r.email);
    },

    // --- Kindred Plus ---

    async linkSubscription(userId, { customerId, subscriptionId }) {
      await db.query(
        'UPDATE users SET stripe_customer_id = COALESCE($1, stripe_customer_id), plus_subscription_id = $2 WHERE id = $3',
        [customerId || null, subscriptionId, userId],
      );
    },

    async userBySubscription(subscriptionId) {
      const { rows } = await db.query('SELECT * FROM users WHERE plus_subscription_id = $1', [subscriptionId]);
      return userFromRow(rows[0]);
    },

    // Extends Plus to `until` (never shortens it, so out-of-order webhooks are harmless).
    async extendPlus(userId, until) {
      await db.query('UPDATE users SET plus_until = $1 WHERE id = $2 AND (plus_until IS NULL OR plus_until < $1)', [until, userId]);
    },

    async endPlus(userId, until) {
      await db.query('UPDATE users SET plus_until = CASE WHEN plus_until > $1 THEN $1 ELSE plus_until END, plus_subscription_id = NULL WHERE id = $2', [until, userId]);
    },

    async listHeldMessages({ limit = 50 } = {}) {
      const { rows } = await db.query(
        `SELECT m.*, u.handle AS sender_handle, u.status AS sender_status FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.status = 'held' AND m.reviewed_at IS NULL ORDER BY m.created_at DESC LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({ ...messageFromRow(r), sender: { id: r.sender_id, handle: r.sender_handle, status: r.sender_status } }));
    },

    // --- messages for the next listener ("bottles") ---

    // One open message per person; a new one replaces the old.
    async createBottle(userId, body, crisis) {
      await db.query("UPDATE bottles SET status = 'withdrawn' WHERE user_id = $1 AND status = 'open'", [userId]);
      const id = newId();
      await db.query('INSERT INTO bottles (id, user_id, body, crisis, created_at) VALUES ($1, $2, $3, $4, $5)', [id, userId, body, crisis ? 1 : 0, now()]);
      return id;
    },

    async myOpenBottle(userId, since) {
      const { rows } = await db.query("SELECT id, body, created_at FROM bottles WHERE user_id = $1 AND status = 'open' AND created_at > $2", [userId, since]);
      return rows[0] ? { id: rows[0].id, body: rows[0].body, createdAt: num(rows[0].created_at) } : null;
    },

    async withdrawBottle(userId) {
      const { rowCount } = await db.query("UPDATE bottles SET status = 'withdrawn' WHERE user_id = $1 AND status = 'open'", [userId]);
      return rowCount > 0;
    },

    // Oldest first, from people still in good standing.
    async openBottleCandidates(listenerId, since, limit = 20) {
      const { rows } = await db.query(
        `SELECT b.id, b.user_id, b.body, b.crisis, u.handle FROM bottles b JOIN users u ON u.id = b.user_id
          WHERE b.status = 'open' AND b.created_at > $1 AND b.user_id <> $2 AND u.status = 'active'
          ORDER BY b.created_at ASC LIMIT $3`,
        [since, listenerId, limit],
      );
      return rows.map((r) => ({ id: r.id, userId: r.user_id, body: r.body, crisis: Number(r.crisis) === 1, handle: r.handle }));
    },

    async claimBottle(id, listenerId) {
      const { rowCount } = await db.query("UPDATE bottles SET status = 'claimed', claimed_by = $1, claimed_at = $2 WHERE id = $3 AND status = 'open'", [listenerId, now(), id]);
      return rowCount === 1;
    },

    // All of them older than `before`: answered ones already live on as the first chat message
    // (under the normal message retention), so the copy here shouldn't outlast that.
    async purgeOldBottles(before) {
      const { rowCount } = await db.query('DELETE FROM bottles WHERE created_at < $1', [before]);
      return rowCount;
    },

    async releaseBottle(id) {
      await db.query("UPDATE bottles SET status = 'open', claimed_by = NULL, claimed_at = NULL WHERE id = $1 AND status = 'claimed' AND conversation_id IS NULL", [id]);
    },

    async setBottleConversation(id, conversationId) {
      await db.query('UPDATE bottles SET conversation_id = $1 WHERE id = $2', [conversationId, id]);
    },

    async openBottleCount(since) {
      const { rows } = await db.query(
        "SELECT COUNT(*) AS n FROM bottles b JOIN users u ON u.id = b.user_id WHERE b.status = 'open' AND b.created_at > $1 AND u.status = 'active'",
        [since],
      );
      return Number(rows[0].n);
    },

    async pendingHeldMessage(messageId) {
      const { rows } = await db.query("SELECT * FROM messages WHERE id = $1 AND status = 'held' AND reviewed_at IS NULL", [messageId]);
      return rows[0] ? messageFromRow(rows[0]) : null;
    },

    // A moderator's decision on a held message, exactly once: deliver it after all (a false
    // positive), or keep it held. Either way it leaves the queue. Returns the message or null.
    async reviewHeldMessage(messageId, release) {
      const t = now();
      const { rowCount } = await db.query(
        `UPDATE messages SET reviewed_at = $1${release ? ", status = 'delivered'" : ''} WHERE id = $2 AND status = 'held' AND reviewed_at IS NULL`,
        [t, messageId],
      );
      if (rowCount !== 1) return null;
      const { rows: [row] } = await db.query('SELECT * FROM messages WHERE id = $1', [messageId]);
      if (release) await db.query('UPDATE conversations SET last_message_at = $1 WHERE id = $2 AND last_message_at < $1', [t, row.conversation_id]);
      return messageFromRow(row);
    },
  };
  return store;
}

module.exports = { createStore, pairKey };
