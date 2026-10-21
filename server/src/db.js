// A tiny database adapter so the same SQL runs on SQLite (default, zero setup)
// and Postgres (set DATABASE_URL, e.g. Supabase or Neon). SQL is written with
// Postgres-style $1 placeholders and translated for SQLite.

// Each migration runs once, in order; never edit one that has shipped, add a new one.
const MIGRATIONS = [
  // 1: accounts, sessions, conversations, messages, blocks
  [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      handle TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      birthdate TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)',
    `CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      pair_key TEXT UNIQUE NOT NULL,
      user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_a BIGINT NOT NULL DEFAULT 0,
      read_b BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      last_message_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS conversations_a_idx ON conversations(user_a, last_message_at)',
    'CREATE INDEX IF NOT EXISTS conversations_b_idx ON conversations(user_b, last_message_at)',
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'delivered',
      flags TEXT,
      created_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at)',
    `CREATE TABLE IF NOT EXISTS blocks (
      blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id)
    )`,
  ],
  // 2: reports for moderators
  [
    `CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reported_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      details TEXT,
      snapshot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at BIGINT NOT NULL,
      resolved_at BIGINT,
      resolution TEXT
    )`,
    'CREATE INDEX IF NOT EXISTS reports_reported_idx ON reports(reported_id, created_at)',
    'CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status, created_at)',
    'CREATE INDEX IF NOT EXISTS messages_status_idx ON messages(status, created_at)',
  ],
  // 3: mutual connect (reveal) and paid connect credits
  [
    'ALTER TABLE users ADD COLUMN connect_credits INTEGER NOT NULL DEFAULT 0',
    `CREATE TABLE IF NOT EXISTS connections (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requester_name TEXT NOT NULL,
      requester_contact TEXT,
      paid INTEGER NOT NULL DEFAULT 0,
      accepter_name TEXT,
      accepter_contact TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL,
      responded_at BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL,
      credits INTEGER NOT NULL,
      created_at BIGINT NOT NULL
    )`,
  ],
  // 4: web push subscriptions
  [
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS push_user_idx ON push_subscriptions(user_id)',
  ],
  // 5: account deletion bookkeeping (safety data is purged after a retention period)
  ['ALTER TABLE users ADD COLUMN deleted_at BIGINT'],
  // 6: "did this help?" feedback, one per person per conversation
  [
    `CREATE TABLE IF NOT EXISTS feedback (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      rater_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ratee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      helpful INTEGER NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (conversation_id, rater_id)
    )`,
    'CREATE INDEX IF NOT EXISTS feedback_ratee_idx ON feedback(ratee_id, helpful)',
  ],
  // 7: password reset tokens (stored hashed, single use, short-lived)
  [
    `CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL
    )`,
  ],
  // 8: email verification (moderator rights require a verified email)
  [
    'ALTER TABLE users ADD COLUMN email_verified_at BIGINT',
    `CREATE TABLE IF NOT EXISTS email_verifications (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL
    )`,
  ],
  // 9: one gentle reaction per person per message
  [
    'ALTER TABLE messages ADD COLUMN reaction TEXT',
  ],
  // 10: private daily mood check-ins (one per person per day)
  [
    `CREATE TABLE IF NOT EXISTS checkins (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      mood INTEGER NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, day)
    )`,
  ],
  // 11: moderation audit log and appeals
  [
    `CREATE TABLE IF NOT EXISTS mod_actions (
      id TEXT PRIMARY KEY,
      moderator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      target_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      detail TEXT,
      created_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS mod_actions_created_idx ON mod_actions(created_at)',
    `CREATE TABLE IF NOT EXISTS appeals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at BIGINT NOT NULL,
      resolved_at BIGINT
    )`,
  ],
  // 12: the audit log must outlive the accounts it mentions: no cascading deletes, keep handles
  [
    `CREATE TABLE IF NOT EXISTS mod_actions_v2 (
      id TEXT PRIMARY KEY,
      moderator_id TEXT,
      moderator_handle TEXT,
      target_id TEXT,
      target_handle TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      created_at BIGINT NOT NULL
    )`,
    `INSERT INTO mod_actions_v2 (id, moderator_id, moderator_handle, target_id, target_handle, action, detail, created_at)
       SELECT a.id, a.moderator_id, m.handle, a.target_id, t.handle, a.action, a.detail, a.created_at
         FROM mod_actions a LEFT JOIN users m ON m.id = a.moderator_id LEFT JOIN users t ON t.id = a.target_id`,
    'DROP TABLE mod_actions',
    'ALTER TABLE mod_actions_v2 RENAME TO mod_actions',
    'CREATE INDEX IF NOT EXISTS mod_actions_created_idx2 ON mod_actions(created_at)',
  ],
  // 13: Kindred Plus subscriptions
  [
    'ALTER TABLE users ADD COLUMN stripe_customer_id TEXT',
    'ALTER TABLE users ADD COLUMN plus_subscription_id TEXT',
    'ALTER TABLE users ADD COLUMN plus_until BIGINT',
  ],
  // 14: listeners "on call" (opt-in push when someone is waiting to talk)
  [
    'ALTER TABLE users ADD COLUMN listener_alerts INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN listener_alerted_at BIGINT NOT NULL DEFAULT 0',
  ],
  // 15: hide a conversation from your list until there's something new in it
  [
    'ALTER TABLE conversations ADD COLUMN hidden_a BIGINT NOT NULL DEFAULT 0',
    'ALTER TABLE conversations ADD COLUMN hidden_b BIGINT NOT NULL DEFAULT 0',
  ],
  // 16: kind words: a short note with a "this helped" vote, kept for the listener
  [
    'ALTER TABLE feedback ADD COLUMN note TEXT',
    'ALTER TABLE feedback ADD COLUMN note_at BIGINT',
    'ALTER TABLE feedback ADD COLUMN note_hidden INTEGER NOT NULL DEFAULT 0',
  ],
  // 17: support requests (members write in; moderators reply by email without seeing the address)
  [
    `CREATE TABLE IF NOT EXISTS support_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      reply TEXT,
      created_at BIGINT NOT NULL,
      resolved_at BIGINT
    )`,
    'CREATE INDEX IF NOT EXISTS support_status_idx ON support_requests(status, created_at)',
  ],
  // 18: devices (hashed browser ids) so a suspended person can't just sign up again
  [
    `CREATE TABLE IF NOT EXISTS user_devices (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_hash TEXT NOT NULL,
      last_seen BIGINT NOT NULL,
      PRIMARY KEY (user_id, device_hash)
    )`,
    'CREATE INDEX IF NOT EXISTS user_devices_hash_idx ON user_devices(device_hash)',
    // Outlives the account (a suspended person deleting it shouldn't clear the ban).
    `CREATE TABLE IF NOT EXISTS banned_devices (
      device_hash TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (device_hash, user_id)
    )`,
  ],
  // 19: kind words get their own random id, so nothing ties a note to a conversation
  [
    'ALTER TABLE feedback ADD COLUMN note_id TEXT',
  ],
  // 20: mute push notifications for one conversation
  [
    'ALTER TABLE conversations ADD COLUMN muted_a INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE conversations ADD COLUMN muted_b INTEGER NOT NULL DEFAULT 0',
  ],
  // 21: held messages a moderator has reviewed leave the queue
  [
    'ALTER TABLE messages ADD COLUMN reviewed_at BIGINT',
  ],
  // 22: "leave a message for the next listener" when nobody is around
  [
    `CREATE TABLE IF NOT EXISTS bottles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      crisis INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      created_at BIGINT NOT NULL,
      claimed_by TEXT,
      claimed_at BIGINT,
      conversation_id TEXT
    )`,
    'CREATE INDEX IF NOT EXISTS bottles_open_idx ON bottles(status, created_at)',
  ],
  // 23: a one-line notice from the moderators, shown next time the person opens the app
  [
    'ALTER TABLE users ADD COLUMN notice TEXT',
  ],
  // 24: payment records must outlive the accounts that made them (accounting, disputes, revenue):
  // rebuilt without the cascading delete. They hold no personal data beyond an account id.
  [
    `CREATE TABLE IF NOT EXISTS payments_v2 (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      credits INTEGER NOT NULL,
      created_at BIGINT NOT NULL
    )`,
    'INSERT INTO payments_v2 (id, user_id, amount_cents, credits, created_at) SELECT id, user_id, amount_cents, credits, created_at FROM payments',
    'DROP TABLE payments',
    'ALTER TABLE payments_v2 RENAME TO payments',
    'CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id)',
  ],
  // 25: indexes for moderator lookup (case-insensitive handle, history by account), reports
  // made, on-call listener search and waiting messages by author
  [
    'CREATE INDEX IF NOT EXISTS users_handle_lower_idx ON users(LOWER(handle))',
    'CREATE INDEX IF NOT EXISTS users_listener_alerts_idx ON users(listener_alerts, listener_alerted_at)',
    'CREATE INDEX IF NOT EXISTS mod_actions_target_idx ON mod_actions(target_id, created_at)',
    'CREATE INDEX IF NOT EXISTS reports_reporter_idx ON reports(reporter_id, created_at)',
    'CREATE INDEX IF NOT EXISTS bottles_user_idx ON bottles(user_id, status)',
  ],
  // 26: appeals record the decision (and an optional note to the person)
  [
    'ALTER TABLE appeals ADD COLUMN decision TEXT',
    'ALTER TABLE appeals ADD COLUMN decision_note TEXT',
  ],
  // 27: appeals answered before decisions were recorded belong to an earlier pause; retire them
  // so the paused screen offers a fresh note instead of an outcome it can't describe.
  [
    "UPDATE appeals SET status = 'past' WHERE status = 'resolved' AND decision IS NULL",
  ],
  // 28: connect asks per chat, so the daily limit holds across restarts and servers
  [
    `CREATE TABLE IF NOT EXISTS connect_asks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS connect_asks_idx ON connect_asks(user_id, conversation_id, created_at)',
  ],
  // 29: game modes: what the pair matched for last ('talk', 'cringe', 'nosmile')
  [
    "ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'talk'",
  ],
  // 30: "Continue with Google/Apple": which provider account signs in to which user. Only the
  // provider's stable id (`subject`) is kept: no name, photo or token.
  [
    `CREATE TABLE IF NOT EXISTS oauth_identities (
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (provider, subject)
    )`,
    'CREATE INDEX IF NOT EXISTS oauth_identities_user_idx ON oauth_identities(user_id)',
  ],
];

async function migrate(db) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
  const { rows } = await db.query('SELECT id FROM schema_migrations');
  const done = new Set(rows.map((r) => Number(r.id)));
  for (let i = 0; i < MIGRATIONS.length; i += 1) {
    const id = i + 1;
    if (done.has(id)) continue;
    for (const statement of MIGRATIONS[i]) {
      try {
        await db.query(statement);
      } catch (err) {
        // Already applied (a DB from before tracking, or another instance racing us on boot).
        if (!/duplicate column|already exists/i.test(err.message)) throw err;
      }
    }
    await db.query('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, Date.now()]);
  }
}

function createSqlite(file) {
  // Loaded lazily so Postgres deployments never touch the experimental module.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') {
    // WAL + synchronous=NORMAL is SQLite's recommended pairing: commits don't fsync
    // (checkpoints do), which keeps the single Node thread from stalling under load.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
  }
  const toSqlite = (sql) => sql.replace(/\$(\d+)/g, '?$1');
  return {
    kind: 'sqlite',
    async query(sql, params = []) {
      const stmt = db.prepare(toSqlite(sql));
      if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
        return { rows: stmt.all(...params).map((r) => ({ ...r })), rowCount: undefined };
      }
      const info = stmt.run(...params);
      return { rows: [], rowCount: Number(info.changes) };
    },
    // With synchronous=NORMAL, the latest commits live only in the WAL until a checkpoint; this
    // pushes them into the database file with a full sync (used after payments).
    async flush() {
      db.exec('PRAGMA wal_checkpoint(FULL)');
    },
    async close() {
      db.close();
    },
  };
}

function createPostgres(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    // TLS follows the URL's sslmode (e.g. ?sslmode=require). Skipping certificate
    // checks is an explicit opt-in for providers with a private CA.
    ...(process.env.DATABASE_SSL_NO_VERIFY === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
    max: Number(process.env.DATABASE_POOL_MAX) || 5,
  });
  return {
    kind: 'postgres',
    async query(sql, params = []) {
      const res = await pool.query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount };
    },
    async close() {
      await pool.end();
    },
  };
}

async function createDb({ url = process.env.DATABASE_URL, sqliteFile = process.env.SQLITE_FILE || 'data/kindred.db' } = {}) {
  let db;
  if (url) {
    db = createPostgres(url);
  } else {
    if (sqliteFile !== ':memory:') {
      require('fs').mkdirSync(require('path').dirname(sqliteFile), { recursive: true });
    }
    db = createSqlite(sqliteFile);
  }
  await migrate(db);
  return db;
}

module.exports = { createDb };
