const MIN_AGE = 18;
const MAX_MESSAGE = 2000;

// The passwords people try first. Not a full breach list, just the obvious ones.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', '12345678', '123456789', '1234567890', '87654321',
  '11111111', '00000000', 'qwertyui', 'qwerty123', 'qwertyuiop', 'abcd1234', 'abc12345', 'iloveyou', 'iloveyou1',
  'letmein1', 'welcome1', 'welcome123', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'whatever',
  'trustno1', 'starwars', 'monkey123', 'dragon123', 'changeme', 'asdfghjk', 'asdf1234', 'zxcvbnm1', '1q2w3e4r',
  'kindred1', 'kindred123', 'loveyou1', 'mypassword', 'secret123', 'admin123',
]);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, expose: true });
}

function str(value, field, max, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw badRequest(`${field} is required`);
  if (trimmed.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return trimmed || undefined;
}

// Whole years between an ISO birthdate (YYYY-MM-DD) and `today`.
function ageOn(birthdate, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate || '');
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return NaN;
  let age = today.getUTCFullYear() - y;
  const beforeBirthday = today.getUTCMonth() < mo - 1 || (today.getUTCMonth() === mo - 1 && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseCredentials(body = {}, { signup, today } = {}) {
  const email = str(body.email, 'email', 254)?.toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest('Enter a valid email address');
  if (typeof body.password !== 'string' || body.password.length < (signup ? 8 : 1)) {
    throw badRequest(signup ? 'Password must be at least 8 characters' : 'password is required');
  }
  if (body.password.length > 200) throw badRequest('Password must be at most 200 characters');
  if (signup && (COMMON_PASSWORDS.has(body.password.toLowerCase()) || body.password.toLowerCase() === email.split('@')[0])) {
    throw badRequest('That password is too easy to guess. Try a few words that mean something to you.');
  }
  const out = { email, password: body.password };
  if (signup) out.birthdate = parseAdult(body, { today });
  return out;
}

// The 18+ gate every new account passes, however it signs up (email or "Continue with Google").
// Returns the birthdate; an under-18 answer carries `underage` so the caller can flag the device.
function parseAdult(body = {}, { today } = {}) {
  const age = ageOn(body.birthdate, today);
  if (!Number.isFinite(age) || age > 120 || age < 0) throw badRequest('Enter a valid birthdate');
  if (age < MIN_AGE) throw Object.assign(new Error(`Kindred is for adults ${MIN_AGE} and over.`), { status: 403, expose: true, underage: true });
  if (body.agree !== true) throw badRequest('Please agree to the community guidelines');
  return body.birthdate;
}

function parseMessageBody(value) {
  if (typeof value !== 'string') throw badRequest('Message must be text');
  // Collapse runs of blank lines; keep intentional line breaks.
  const body = value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) throw badRequest('Message is empty');
  if (body.length > MAX_MESSAGE) throw badRequest(`Messages can be at most ${MAX_MESSAGE} characters`);
  return body;
}

module.exports = { MIN_AGE, MAX_MESSAGE, badRequest, str, ageOn, parseCredentials, parseAdult, parseMessageBody };
