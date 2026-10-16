// A tiny database adapter so the same SQL runs on SQLite (default, zero setup)
// and Postgres (set DATABASE_URL, e.g. Supabase or Neon). SQL is written with
// Postgres-style $1 placeholders and translated for SQLite.

const SCHEMA = [
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
];

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
  for (const statement of SCHEMA) await db.query(statement);
  return db;
}

module.exports = { createDb };
