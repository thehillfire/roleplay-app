const { createDb } = require('./db');
const { createStore } = require('./store');
const { createApp } = require('./app');
const { createHub, attachRealtime } = require('./realtime');

// Builds the whole server. Call `listen(port)` to start HTTP + WebSocket on one port.
async function boot(options = {}) {
  const db = await createDb(options.db);
  const store = createStore(db);
  const hub = createHub();
  const app = createApp({ ...options, store, hub });
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

  function listen(port, cb) {
    const server = app.listen(port, cb);
    const realtime = attachRealtime({ server, hub, store, allowedOrigins, ...options.realtime });
    server.on('close', () => realtime.close());
    return Object.assign(server, { realtime });
  }

  return { app, db, store, hub, listen };
}

module.exports = { boot };
