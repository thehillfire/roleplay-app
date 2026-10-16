// Usage: node server/scripts/make-admin.js someone@example.com
// Gives an existing account the moderator role (uses DATABASE_URL / SQLITE_FILE like the server).
require('dotenv').config({ quiet: true });
const { createDb } = require('../src/db');
const { createStore } = require('../src/store');

(async () => {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: node server/scripts/make-admin.js <email>');
    process.exit(1);
  }
  const db = await createDb();
  const ok = await createStore(db).setUserRole(email, 'admin');
  await db.close();
  console.log(ok ? `${email} is now a moderator.` : `No account found for ${email}.`);
  process.exit(ok ? 0 : 1);
})();
