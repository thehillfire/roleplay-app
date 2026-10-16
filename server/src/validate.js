const MIN_AGE = 18;
const MAX_MESSAGE = 2000;

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
  const out = { email, password: body.password };
  if (signup) {
    const age = ageOn(body.birthdate, today);
    if (!Number.isFinite(age) || age > 120 || age < 0) throw badRequest('Enter a valid birthdate');
    if (age < MIN_AGE) throw Object.assign(new Error(`Kindred is for adults ${MIN_AGE} and over.`), { status: 403, expose: true });
    if (body.agree !== true) throw badRequest('Please agree to the community guidelines');
    out.birthdate = body.birthdate;
  }
  return out;
}

function parseMessageBody(value) {
  if (typeof value !== 'string') throw badRequest('Message must be text');
  // Collapse runs of blank lines; keep intentional line breaks.
  const body = value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) throw badRequest('Message is empty');
  if (body.length > MAX_MESSAGE) throw badRequest(`Messages can be at most ${MAX_MESSAGE} characters`);
  return body;
}

module.exports = { MIN_AGE, MAX_MESSAGE, badRequest, str, ageOn, parseCredentials, parseMessageBody };
