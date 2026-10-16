const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');

test('without AdSense configured, no ad hosts are allowed by the CSP', async (t) => {
  const s = await start({ ads: null });
  t.after(s.stop);
  const res = await fetch(`${s.base}/api/health`);
  assert.ok(!/googlesyndication/.test(res.headers.get('content-security-policy')));
  const alice = await signedUp(s.base);
  assert.equal((await alice('GET', '/api/auth/me')).body.ads, null);
});

test('with AdSense configured, the CSP allows Google ad hosts and the client gets the slot', async (t) => {
  const s = await start({ ads: { client: 'ca-pub-123', slot: '456' } });
  t.after(s.stop);
  const csp = (await fetch(`${s.base}/api/health`)).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' https:\/\/pagead2\.googlesyndication\.com/);
  assert.match(csp, /frame-src [^;]*doubleclick/);
  const alice = await signedUp(s.base);
  assert.deepEqual((await alice('GET', '/api/auth/me')).body.ads, { client: 'ca-pub-123', slot: '456' });
});
