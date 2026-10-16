// A tiny database adapter so the same SQL runs on SQLite (default, zero setup)
// and Postgres (set DATABASE_URL, e.g. Supabase or Neon). SQL is written with
// Postgres-style $1 placeholders and translated for SQLite.

// Each migration runs once, in order; never edit one that has shipped, add a new one.
const MIGRATIONS = [
  // 1: accounts, sessions, stories
  [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)',
  `CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hero TEXT NOT NULL,
    history TEXT NOT NULL,
    choices TEXT NOT NULL,
    actions INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS stories_user_idx ON stories(user_id, updated_at)',
  ],
  // 2: game state (HP, inventory, quest)
  ['ALTER TABLE stories ADD COLUMN state TEXT'],
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

async function createDb({ url = process.env.DATABASE_URL, sqliteFile = process.env.SQLITE_FILE || 'data/loreforge.db' } = {}) {
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
