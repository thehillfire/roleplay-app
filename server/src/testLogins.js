// Test sign-ins for trying the app quickly: TEST_LOGINS="a:a,b:b" lets someone sign in with the
// name "a" and the password "a". Each name is one ordinary member account (never a moderator),
// created on first use with a placeholder email that can't receive mail.
const NAME = /^[a-z0-9]{1,20}$/;

function parseTestLogins(value = '') {
  const logins = new Map();
  for (const pair of String(value).split(',')) {
    const i = pair.indexOf(':');
    if (i < 1) continue;
    const name = pair.slice(0, i).trim().toLowerCase();
    const password = pair.slice(i + 1).trim();
    if (NAME.test(name) && password) logins.set(name, password);
  }
  return logins;
}

const testEmail = (name) => `${name}@test-login.invalid`;

module.exports = { parseTestLogins, testEmail };
