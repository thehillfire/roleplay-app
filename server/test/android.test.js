const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

test('assetlinks.json is served only when the Android app is configured', async (t) => {
  const off = await start({ android: null });
  t.after(off.stop);
  assert.equal((await fetch(`${off.base}/.well-known/assetlinks.json`)).status, 404);

  const on = await start({ android: { packageName: 'app.kindred.twa', fingerprints: ['AA:BB:CC'] } });
  t.after(on.stop);
  const res = await fetch(`${on.base}/.well-known/assetlinks.json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'app.kindred.twa', sha256_cert_fingerprints: ['AA:BB:CC'] },
  }]);
});
