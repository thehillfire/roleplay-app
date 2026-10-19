// End-to-end test of "Continue with Google": a real browser, the real Kindred server, and a fake Google
// on a local port that really redirects, issues a code and signs an id_token with a real key.
// It starts its own servers, so it needs only the built app (npm run build):
//   [CHROMIUM_PATH=...] node e2e/social.mjs
import { chromium, devices } from 'playwright-core';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { boot } = require('../server/src/boot');
const { createSocial } = require('../server/src/social');
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const staticDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const step = (name) => console.log(`✓ ${name}`);
const errors = [];

// --- fake Google ---
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e-key', alg: 'RS256', use: 'sig' };
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const idp = { identity: { sub: 'g-1', email: 'sam@example.com' }, deny: false, codes: new Map(), authorizeCalls: [] };
const idpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://idp');
  if (url.pathname === '/authorize') {
    idp.authorizeCalls.push(Object.fromEntries(url.searchParams));
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('state', url.searchParams.get('state'));
    if (idp.deny) {
      back.searchParams.set('error', 'access_denied');
    } else {
      const code = crypto.randomBytes(12).toString('hex');
      idp.codes.set(code, url.searchParams.get('nonce'));
      back.searchParams.set('code', code);
    }
    res.writeHead(302, { Location: back.toString() }).end();
  } else if (url.pathname === '/token' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      const nonce = idp.codes.get(form.get('code'));
      idp.codes.delete(form.get('code'));
      if (!nonce || form.get('client_secret') !== 'e2e-secret') return res.writeHead(400).end('{}');
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: idp.base, aud: 'e2e-client', sub: idp.identity.sub, email: idp.identity.email, email_verified: true, nonce, iat: now, exp: now + 600 };
      const input = `${b64({ alg: 'RS256', kid: 'e2e-key' })}.${b64(claims)}`;
      const id_token = `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id_token }));
    });
  } else if (url.pathname === '/keys') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => idpServer.listen(0, '127.0.0.1', r));
idp.base = `http://127.0.0.1:${idpServer.address().port}`;

// --- the real Kindred server, with the fake Google as its "google" ---
const social = createSocial({
  providers: {
    google: {
      id: 'google', label: 'Google', clientId: 'e2e-client', clientSecret: () => 'e2e-secret',
      authUrl: `${idp.base}/authorize`, tokenUrl: `${idp.base}/token`, jwksUrl: `${idp.base}/keys`,
      issuers: [idp.base], scope: 'openid email', pkce: true,
      extraAuthParams: { prompt: 'select_account' }, reauthParams: { prompt: 'login' },
    },
  },
  log: { warn() {} },
});
const app = await boot({ db: { sqliteFile: ':memory:' }, staticDir, social, authRateLimit: { max: 1000, windowMs: 60000 } });
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
async function phone(name, options = {}) {
  const context = await browser.newContext({ ...devices['Pixel 7'], ...options });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(`${name}: ${m.text()}`));
  return page;
}
const adultBirthdate = '1990-06-01';
async function startSignup(page, birthdate = adultBirthdate) {
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByLabel(/Birthdate/).fill(birthdate);
  await page.getByLabel(/I'm 18 or older/).check();
}
const me = (page) => page.evaluate(() => fetch('/api/auth/me').then((r) => r.json()));
async function axe(page, label) {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(() => window.axe.run({ include: [document] }, { resultTypes: ['violations'] }));
  const serious = result.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  assert.equal(serious.length, 0, `${label}: ${serious.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(',')}`).join('; ')}`);
}

// 0. Preview only (SOCIAL_PREVIEW, no keys): the buttons are visibly "coming soon", disabled, and don't give instructions for something unusable.
{
  const previewApp = await boot({ db: { sqliteFile: ':memory:' }, staticDir, social: createSocial({ providers: {}, log: { warn() {} } }), socialPreview: true });
  const previewServer = previewApp.listen(0);
  await new Promise((r) => previewServer.once('listening', r));
  const page = await phone('preview');
  await page.goto(`http://127.0.0.1:${previewServer.address().port}`);
  await page.getByRole('button', { name: 'Get started' }).click();
  for (const name of ['Google: coming soon', 'Apple: coming soon']) assert.equal(await page.getByRole('button', { name }).isDisabled(), true, name);
  assert.equal(await page.getByText(/Enter your birthdate and agree above/).count(), 0, 'no instruction for buttons that cannot be used yet');
  await page.context().close();
  await new Promise((r) => previewServer.close(r));
  await previewApp.db.close();
  step('preview only: buttons say "coming soon", are disabled, and show no instruction');
}

// 1. Both screens show the button; sign-up keeps it off until the 18+ answers are in. Accessibility is clean with it live.
{
  const page = await phone('a11y', { bypassCSP: true }); // (axe injects a script; the app's CSP rightly blocks that)
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Get started' }).click();
  const google = page.getByRole('button', { name: 'Continue with Google' });
  assert.equal(await google.isDisabled(), true, 'off until birthdate and agreement');
  await page.getByText('Enter your birthdate and agree above to continue').waitFor();
  await page.getByLabel(/Birthdate/).fill(adultBirthdate);
  await page.getByLabel(/I'm 18 or older/).check();
  assert.equal(await google.isDisabled(), false);
  await axe(page, 'sign-up with provider buttons');
  await page.getByRole('tab', { name: 'Sign in' }).click();
  assert.equal(await page.getByRole('button', { name: 'Continue with Google' }).isDisabled(), false, 'sign-in needs no extra answers');
  await axe(page, 'sign-in with provider buttons');
  await page.context().close();
  step('Google button on both tabs; sign-up waits for the 18+ answers; no accessibility violations');
}

// 2. Under 18: refused before leaving for Google.
{
  const kid = await phone('kid');
  await startSignup(kid, `${new Date().getUTCFullYear() - 15}-03-03`);
  await kid.getByRole('button', { name: 'Continue with Google' }).click();
  await kid.getByText(/for adults 18 and over/).waitFor();
  assert.ok(kid.url().startsWith(BASE), 'never left Kindred');
  assert.equal(idp.authorizeCalls.length, 0, 'Google was never contacted');
  await kid.context().close();
  step('under-18 is refused before anyone is sent to Google');
}

// 3. Sign up with Google: lands signed in, with the lightning entry; the account has no password and an anonymous name.
const sam = await phone('sam');
await startSignup(sam);
await sam.getByRole('button', { name: 'Continue with Google' }).click();
await sam.locator('.strike').waitFor({ timeout: 15000 });
assert.match(await sam.locator('.strike-title').innerText(), /you're in/i);
const handle = await sam.locator('.strike-name').innerText();
assert.doesNotMatch(handle.toLowerCase(), /sam/, 'the name is random, not from the email');
assert.equal(new URL(sam.url()).search, '', 'the address is tidied after returning');
assert.equal(idp.authorizeCalls.at(-1).prompt, 'select_account');
assert.ok(idp.authorizeCalls.at(-1).code_challenge, 'PKCE challenge sent');
await sam.getByRole('button', { name: 'Skip' }).click(); // first-run onboarding
const account = (await me(sam)).user;
assert.deepEqual(account.signIn, { hasPassword: false, providers: ['google'] });
assert.equal(account.emailVerified, true);
await sam.locator('.strike').waitFor({ state: 'detached', timeout: 5000 });
step('sign up with Google: signed in with the lightning entry, anonymous name, no password stored');

// 4. Sign out, then sign in with Google: same person, "welcome back".
await sam.getByRole('button', { name: 'Account' }).click();
await sam.getByRole('button', { name: 'Sign out', exact: true }).click();
await sam.getByRole('button', { name: 'Get started' }).click();
await sam.getByRole('tab', { name: 'Sign in' }).click();
await sam.getByRole('button', { name: 'Continue with Google' }).click();
await sam.locator('.strike').waitFor({ timeout: 15000 });
assert.match(await sam.locator('.strike-title').innerText(), /welcome back/i);
assert.equal(await sam.locator('.strike-name').innerText(), handle, 'same account');
step('sign in with Google: the same account, "welcome back"');

// 5. Delete an account that has no password: confirm with Google first, then delete.
await sam.locator('.strike').waitFor({ state: 'detached', timeout: 5000 });
await sam.getByRole('button', { name: 'Account' }).click();
await sam.getByRole('button', { name: 'Delete account' }).click();
await sam.getByText(/signs in with Google, so there's no password to type/).waitFor();
assert.equal(await sam.getByLabel(/password/i).count(), 0, 'no password box');
await sam.getByRole('button', { name: 'Confirm with Google' }).click();
await sam.getByText(/Confirmed with Google/).waitFor({ timeout: 15000 });
assert.equal(idp.authorizeCalls.at(-1).prompt, 'login', 'asked Google to confirm afresh');
await sam.getByRole('button', { name: 'Delete forever' }).click();
await sam.getByText(/Your account was deleted/).waitFor({ timeout: 15000 });
step('deleting a Google-only account: confirm with Google, then it is gone');

// 6. The same Google account can start over, as someone new.
await sam.getByRole('button', { name: 'Get started' }).click();
await sam.getByLabel(/Birthdate/).fill(adultBirthdate);
await sam.getByLabel(/I'm 18 or older/).check();
await sam.getByRole('button', { name: 'Continue with Google' }).click();
await sam.locator('.strike').waitFor({ timeout: 15000 });
assert.notEqual(await sam.locator('.strike-name').innerText(), handle, 'a fresh, unrelated account');
step('the same Google account can sign up again as a new person');
await sam.context().close();

// 7. Never merged into someone else's email account.
{
  idp.identity = { sub: 'g-2', email: 'owner@example.com' };
  const owner = await phone('owner');
  await owner.goto(BASE);
  await owner.getByRole('button', { name: 'Get started' }).click();
  await owner.getByLabel('Email').fill('owner@example.com');
  await owner.getByLabel(/Password/).fill('quiet-harbor-9');
  await owner.getByLabel(/Birthdate/).fill(adultBirthdate);
  await owner.getByLabel(/I'm 18 or older/).check();
  await owner.getByRole('button', { name: 'Create account' }).click();
  await owner.getByRole('button', { name: 'Skip' }).click();
  await owner.context().close();

  const other = await phone('other');
  await other.goto(BASE);
  await other.getByRole('button', { name: 'Get started' }).click();
  await other.getByRole('tab', { name: 'Sign in' }).click();
  await other.getByRole('button', { name: 'Continue with Google' }).click();
  await other.getByText(/An account with that email already exists/).waitFor({ timeout: 15000 });
  assert.equal((await me(other)).user, null, 'not signed in to the existing account');
  step("a Google account is never merged into someone else's email account");

  // 8. Unknown Google account on the sign-in tab: pointed to Create account. Cancelling is friendly.
  idp.identity = { sub: 'g-3', email: 'stranger@example.com' };
  await other.goto(BASE);
  await other.getByRole('button', { name: 'Get started' }).click();
  await other.getByRole('tab', { name: 'Sign in' }).click();
  await other.getByRole('button', { name: 'Continue with Google' }).click();
  await other.getByText(/no Kindred account for that Google or Apple account yet/).waitFor({ timeout: 15000 });
  assert.equal(await other.getByRole('tab', { name: 'Create account' }).getAttribute('aria-selected'), 'true', 'opens Create account');

  idp.deny = true;
  await other.goto(BASE);
  await other.getByRole('button', { name: 'Get started' }).click();
  await other.getByRole('tab', { name: 'Sign in' }).click();
  await other.getByRole('button', { name: 'Continue with Google' }).click();
  await other.getByText(/Sign-in was cancelled/).waitFor({ timeout: 15000 });
  idp.deny = false;
  await other.context().close();
  step('an unknown Google account is pointed to Create account; cancelling is handled kindly');
}

await browser.close();
await new Promise((r) => server.close(r));
idpServer.close();
await app.db.close();
if (errors.length) {
  console.error('Browser errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('SOCIAL E2E passed');
process.exit(0);
