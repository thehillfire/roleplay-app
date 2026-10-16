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
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
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
