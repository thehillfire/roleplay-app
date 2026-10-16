const { createDb } = require('./db');
const { createStore } = require('./store');
const { createApp } = require('./app');

async function boot(options = {}) {
  const db = await createDb(options.db);
  const app = createApp({ ...options, store: createStore(db) });
  return { app, db };
}

module.exports = { boot };
