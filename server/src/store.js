const crypto = require('crypto');
const { randomHandle } = require('./handles');

const newId = () => crypto.randomUUID();
const num = (v) => (v === null || v === undefined ? v : Number(v));
const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function userFromRow(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, handle: row.handle, role: row.role, status: row.status, createdAt: num(row.created_at) };
}

function messageFromRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body,
    status: row.status,
    createdAt: num(row.created_at),
  };
}

function createStore(db, { now = Date.now, rng = Math.random } = {}) {
  const store = {
    // --- users & sessions ---

    async createUser({ email, passwordHash, birthdate }) {
      const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (exists.rows.length) return null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const user = { id: newId(), email, handle: randomHandle(rng), role: 'member', status: 'active', createdAt: now() };
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
      const message = { id: newId(), conversationId, senderId, body, status, createdAt: t };
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
  };
  return store;
}

module.exports = { createStore, pairKey };
