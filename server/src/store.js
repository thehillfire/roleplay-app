const crypto = require('crypto');

const newId = () => crypto.randomUUID();
const num = (v) => (v === null || v === undefined ? v : Number(v));

function userFromRow(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, displayName: row.display_name, createdAt: num(row.created_at) };
}

function storyFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    hero: JSON.parse(row.hero),
    history: JSON.parse(row.history),
    choices: JSON.parse(row.choices),
    version: num(row.version),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function summaryFromRow(row) {
  return {
    id: row.id,
    hero: JSON.parse(row.hero),
    actions: num(row.actions),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

const countActions = (history) => history.filter((t) => t.role === 'player').length;

function createStore(db, { now = Date.now } = {}) {
  return {
    async createUser({ email, displayName, passwordHash }) {
      const user = { id: newId(), email, displayName, createdAt: now() };
      try {
        await db.query(
          'INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
          [user.id, email, displayName, passwordHash, user.createdAt],
        );
      } catch (err) {
        if (/unique|duplicate/i.test(err.message)) return null;
        throw err;
      }
      return user;
    },

    async findUserByEmail(email) {
      const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
      return rows[0] ? { ...userFromRow(rows[0]), passwordHash: rows[0].password_hash } : null;
    },

    async createSession(tokenHash, userId, ttlMs) {
      await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, now() + ttlMs]);
    },

    async findSessionUser(tokenHash) {
      const { rows } = await db.query(
        `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
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

    async listStories(userId) {
      const { rows } = await db.query(
        'SELECT id, hero, actions, created_at, updated_at FROM stories WHERE user_id = $1 ORDER BY updated_at DESC',
        [userId],
      );
      return rows.map(summaryFromRow);
    },

    async countStories(userId) {
      const { rows } = await db.query('SELECT COUNT(*) AS n FROM stories WHERE user_id = $1', [userId]);
      return Number(rows[0].n);
    },

    async getStory(userId, id) {
      const { rows } = await db.query('SELECT * FROM stories WHERE id = $1 AND user_id = $2', [id, userId]);
      return storyFromRow(rows[0]);
    },

    async createStory(userId, { hero, history, choices, createdAt }) {
      const t = now();
      const story = { id: newId(), hero, history, choices, version: 0, createdAt: createdAt || t, updatedAt: t };
      await db.query(
        `INSERT INTO stories (id, user_id, hero, history, choices, actions, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)`,
        [story.id, userId, JSON.stringify(hero), JSON.stringify(history), JSON.stringify(choices), countActions(history), story.createdAt, story.updatedAt],
      );
      return story;
    },

    // Optimistic concurrency: returns null if someone else advanced the story first.
    async updateStory(userId, story, { history, choices }) {
      const t = now();
      const { rowCount } = await db.query(
        `UPDATE stories SET history = $1, choices = $2, actions = $3, version = version + 1, updated_at = $4
         WHERE id = $5 AND user_id = $6 AND version = $7`,
        [JSON.stringify(history), JSON.stringify(choices), countActions(history), t, story.id, userId, story.version],
      );
      if (rowCount === 0) return null;
      return { ...story, history, choices, version: story.version + 1, updatedAt: t };
    },

    async deleteStory(userId, id) {
      const { rowCount } = await db.query('DELETE FROM stories WHERE id = $1 AND user_id = $2', [id, userId]);
      return rowCount > 0;
    },
  };
}

module.exports = { createStore };
