require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { boot } = require('./boot');

const port = Number(process.env.PORT) || 3000;
const distDir = path.join(__dirname, '..', '..', 'dist');
const staticDir = fs.existsSync(path.join(distDir, 'index.html')) ? distDir : undefined;

boot({ staticDir }).then(({ app, db }) => {
  const server = app.listen(port, () => {
    console.log(`LoreForge on http://localhost:${port}${staticDir ? '' : ' (API only; run `npm run build` to serve the app)'}`);
    console.log(`Narrator: ${process.env.GEMINI_API_KEY ? 'gemini' : 'offline (set GEMINI_API_KEY for AI stories)'} · Database: ${db.kind}`);
  });
  const shutdown = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}).catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
