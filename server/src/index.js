require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const distDir = path.join(__dirname, '..', '..', 'dist');
const staticDir = fs.existsSync(path.join(distDir, 'index.html')) ? distDir : undefined;

createApp({ staticDir }).listen(port, () => {
  console.log(`Roleplay server on http://localhost:${port}${staticDir ? '' : ' (API only; run `npm run build` to serve the app)'}`);
  console.log(`Narrator: ${process.env.GEMINI_API_KEY ? 'gemini' : 'offline (set GEMINI_API_KEY for AI stories)'}`);
});
