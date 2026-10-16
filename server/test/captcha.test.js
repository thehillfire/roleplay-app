const test = require('node:test');
const assert = require('node:assert/strict');
const { start, client, adult } = require('./helpers');
const { createCaptcha } = require('../src/captcha');

test('with Turnstile keys, signup needs a token Cloudflare accepts', async (t) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)) });
    return { ok: true, json: async () => ({ success: init.body.get('response') === 'good-token' }) };
  };
  const captcha = createCaptcha({ siteKey: 'site-1', secretKey: 'secret-1', fetchImpl });
  const s = await start({ captcha });
  t.after(s.stop);
  const api = client(s.base);
  assert.equal((await api('GET', '/api/auth/me')).body.captcha.siteKey, 'site-1');

  assert.equal((await api('POST', '/api/auth/signup', adult())).status, 400, 'no token');
  assert.equal((await api('POST', '/api/auth/signup', { ...adult(), captchaToken: 'bot-token' })).status, 400);
  const ok = await api('POST', '/api/auth/signup', { ...adult(), captchaToken: 'good-token' });
  assert.equal(ok.status, 201);
  assert.equal(seen.at(-1).url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(seen.at(-1).form.secret, 'secret-1');

  const csp = (await fetch(`${s.base}/api/health`)).headers.get('content-security-policy');
  assert.match(csp, /script-src[^;]*https:\/\/challenges\.cloudflare\.com/);
});

test('Turnstile off without keys; fails open if Cloudflare is unreachable', async () => {
  const off = createCaptcha({ siteKey: '', secretKey: '' });
  assert.equal(off.enabled, false);
  assert.equal(off.siteKey, null);
  assert.equal(await off.verify(undefined), true);

  const down = createCaptcha({ siteKey: 's', secretKey: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); }, log: { warn() {} } });
  assert.equal(await down.verify('token'), true);
  assert.equal(await down.verify(''), false, 'but a missing token still fails');
});
