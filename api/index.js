// Vercel serverless entry. Serverless disks are ephemeral, so set DATABASE_URL
// (Postgres) in the Vercel project; SQLite here would lose data between requests.
const { boot } = require('../server/src/boot');

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set: accounts and saved stories will not persist on Vercel.');
}

const ready = boot({ db: { sqliteFile: process.env.DATABASE_URL ? undefined : '/tmp/loreforge.db' } });

module.exports = async (req, res) => {
  const { app } = await ready;
  return app(req, res);
};
