require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { boot } = require('./boot');
const { envInt } = require('./env');
const { createErrorAlerts } = require('./alerts');

const alerts = createErrorAlerts();
process.on('unhandledRejection', (err) => {
  console.error('unhandled rejection', err);
  alerts.report(err, 'background task');
});

const port = Number(process.env.PORT) || 3000;
const distDir = path.join(__dirname, '..', '..', 'dist');
const staticDir = fs.existsSync(path.join(distDir, 'index.html')) ? distDir : undefined;

if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_URL) {
  console.warn('PUBLIC_URL is not set: links in emails are disabled until it is.');
}
if (process.env.TEST_LOGINS) {
  console.warn('TEST_LOGINS is set: anyone who knows a test name and password can sign in with it. Remove it before launch.');
}
if (process.env.NODE_ENV === 'production' && !process.env.RESEND_API_KEY) {
  console.warn('RESEND_API_KEY is not set: no emails (password resets, confirmations, moderator alerts) will be sent.');
}

// Deleted accounts keep messages/reports this long for safety review, then are purged.
const RETENTION_DAYS = envInt('DELETED_RETENTION_DAYS', 90);

// Messages older than this are deleted (0 keeps them forever).
const MESSAGE_RETENTION_DAYS = envInt('MESSAGE_RETENTION_DAYS', 365);
const DAY_MS = 24 * 60 * 60 * 1000;

boot({ staticDir }).then(({ listen, db, store }) => {
  const purge = async () => {
    try {
      const accounts = await store.purgeDeleted(Date.now() - RETENTION_DAYS * DAY_MS);
      if (accounts) console.log(`Purged ${accounts} deleted account(s)`);
      const scrubbed = await store.scrubResolvedReports(Date.now() - RETENTION_DAYS * DAY_MS);
      if (scrubbed) console.log(`Erased transcripts on ${scrubbed} long-resolved report(s)`);
      // Messages left for the next listener: they expire after a day; the rows go after a week.
      const bottles = await store.purgeOldBottles(Date.now() - 7 * DAY_MS);
      if (bottles) console.log(`Deleted ${bottles} old message(s) for the next listener`);
      await store.purgeOldConnectAsks(Date.now() - 2 * DAY_MS); // only the last day counts
      if (MESSAGE_RETENTION_DAYS > 0) {
        const messages = await store.purgeOldMessages(Date.now() - MESSAGE_RETENTION_DAYS * DAY_MS);
        if (messages) console.log(`Deleted ${messages} message(s) older than ${MESSAGE_RETENTION_DAYS} days`);
      }
    } catch (err) {
      console.error('purge failed', err);
      alerts.report(err, 'daily purge');
    }
  };
  purge();
  setInterval(purge, 24 * 60 * 60 * 1000).unref();

  const server = listen(port, () => {
    console.log(`Kindred on http://localhost:${port}${staticDir ? '' : ' (API only; run `npm run build` to serve the app)'} · database: ${db.kind}`);
  });
  const shutdown = () => {
    server.realtime.close(); // open WebSockets would otherwise keep server.close() waiting
    server.close(() => db.close().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}).catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
