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
      await db.query('DELETE FROM email_verifications WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM checkins WHERE user_id = $1', [userId]); // private, no safety value
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
      await db.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM email_verifications WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM checkins WHERE user_id = $1', [userId]); // private, no safety value // only the newest link works
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
      const { rows } = await db.query('SELECT id FROM conversations WHERE pair_key = $1', [key]);
      return { id: rows[0].id, isNew: inserted.rowCount === 1 };
    },

    // Returns { id, partnerId } if the user is in the conversation, else null.
    async getMembership(userId, conversationId) {
      const { rows } = await db.query('SELECT user_a, user_b, read_a, read_b FROM conversations WHERE id = $1', [conversationId]);
      const row = rows[0];
      if (!row || (row.user_a !== userId && row.user_b !== userId)) return null;
      const iAmA = row.user_a === userId;
      return { id: conversationId, partnerId: iAmA ? row.user_b : row.user_a, partnerReadAt: num(iAmA ? row.read_b : row.read_a) };
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
                (SELECT status FROM connections WHERE conversation_id = c.id) AS connection_status
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
      };
    },

    async listConversations(userId) {
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

    // The sender can take a message back for a short while. Returns false if it's not theirs or too old.
    async unsendMessage(userId, conversationId, messageId, windowMs) {
      const { rowCount } = await db.query(
        `UPDATE messages SET status = 'unsent'
          WHERE id = $1 AND conversation_id = $2 AND sender_id = $3 AND status IN ('delivered', 'held') AND created_at >= $4`,
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
    async setUserStatus(userId, status) {
      const { rowCount } = await db.query("UPDATE users SET status = $1 WHERE id = $2 AND status <> 'deleted'", [status, userId]);
      return rowCount > 0;
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
      return helpful && Number(before.rows[0]?.helpful) !== 1;
    },

    async myFeedback(conversationId, raterId) {
      const { rows } = await db.query('SELECT helpful FROM feedback WHERE conversation_id = $1 AND rater_id = $2', [conversationId, raterId]);
      return rows[0] ? Number(rows[0].helpful) === 1 : null;
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
      };
    },

    // Scrubs personal data right away; messages and reports stay (for safety review)
    // until purgeDeleted() runs after the retention period.
    async deleteAccount(userId) {
      const t = now();
      await db.query(
        `UPDATE users SET email = $1, password_hash = '!', birthdate = '0000-00-00', status = 'deleted', role = 'member', email_verified_at = NULL, deleted_at = $2
         WHERE id = $3`,
        [`deleted+${userId}@deleted.invalid`, t, userId],
      );
      await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM email_verifications WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM checkins WHERE user_id = $1', [userId]); // private, no safety value
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
      const [users, signupsDay, signupsWeek, activeDay, messagesDay, matchesDay, connectsAccepted, revenueCents, helpfulWeek] = await Promise.all([
        one("SELECT COUNT(*) FROM users WHERE status <> 'deleted'"),
        one("SELECT COUNT(*) FROM users WHERE created_at >= $1 AND status <> 'deleted'", [day]),
        one("SELECT COUNT(*) FROM users WHERE created_at >= $1 AND status <> 'deleted'", [week]),
        one("SELECT COUNT(DISTINCT sender_id) FROM messages WHERE created_at >= $1 AND status = 'delivered'", [day]),
        one("SELECT COUNT(*) FROM messages WHERE created_at >= $1 AND status = 'delivered'", [day]),
        one('SELECT COUNT(*) FROM conversations WHERE created_at >= $1', [day]),
        one("SELECT COUNT(*) FROM connections WHERE status = 'accepted'"),
        one('SELECT COALESCE(SUM(amount_cents), 0) FROM payments'),
        one('SELECT COUNT(*) FROM feedback WHERE helpful = 1 AND created_at >= $1', [week]),
      ]);
      return { users, signupsDay, signupsWeek, activeDay, messagesDay, matchesDay, connectsAccepted, revenueCents, helpfulWeek };
    },

    // --- moderation operations ---

    async logModAction({ moderatorId, targetId, action, detail }) {
      await db.query(
        'INSERT INTO mod_actions (id, moderator_id, target_id, action, detail, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [newId(), moderatorId || null, targetId || null, action, detail || null, now()],
      );
    },

    async listModActions(limit = 50) {
      const { rows } = await db.query(
        `SELECT a.*, m.handle AS moderator_handle, t.handle AS target_handle FROM mod_actions a
           LEFT JOIN users m ON m.id = a.moderator_id LEFT JOIN users t ON t.id = a.target_id
          ORDER BY a.created_at DESC LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({
        id: r.id, action: r.action, detail: r.detail, createdAt: num(r.created_at),
        moderator: r.moderator_handle || 'system', target: r.target_handle || null,
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

    async listAppeals() {
      const { rows } = await db.query(
        `SELECT a.*, u.handle, u.status AS user_status FROM appeals a JOIN users u ON u.id = a.user_id
          WHERE a.status = 'open' ORDER BY a.created_at ASC`,
      );
      return rows.map((r) => ({ id: r.id, message: r.message, createdAt: num(r.created_at), user: { id: r.user_id, handle: r.handle, status: r.user_status } }));
    },

    async resolveAppeal(id) {
      const { rows } = await db.query("SELECT user_id FROM appeals WHERE id = $1 AND status = 'open'", [id]);
      if (!rows[0]) return null;
      await db.query("UPDATE appeals SET status = 'resolved', resolved_at = $1 WHERE id = $2", [now(), id]);
      return rows[0].user_id;
    },

    async moderatorEmails() {
      const { rows } = await db.query("SELECT email FROM users WHERE role = 'admin' AND status = 'active' AND email_verified_at IS NOT NULL");
      return rows.map((r) => r.email);
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
