// Vercel serverless entry: every /api/* request is handled by the Express app.
const { createApp } = require('../server/src/app');

module.exports = createApp();
