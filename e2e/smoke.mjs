// End-to-end smoke test: two strangers in separate browsers match and chat.
// Run against a server: npm run build && npm start, then
//   BASE_URL=http://localhost:3000 [CHROMIUM_PATH=...] [SHOTS_DIR=...] npm run e2e
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errors = [];
const step = (name) => console.log(`✓ ${name}`);

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(`${name}: ${m.text()}`));
  page.shot = async (file) => SHOTS && (await page.waitForTimeout(500), await page.screenshot({ path: `${SHOTS}/${file}.png` }));
  return page;
}

async function signUp(page, { birthdate = '1990-06-01' } = {}) {
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByLabel('Email').fill(`e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`);
  await page.getByLabel(/Password/).fill('quiet-harbor-9');
  await page.getByLabel(/Birthdate/).fill(birthdate);
  await page.getByLabel(/I'm 18 or older/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
}

// Legal pages: direct link and from the welcome screen
const visitor = await person('visitor');
await visitor.goto(`${BASE}/privacy`);
await visitor.getByRole('heading', { name: 'Privacy' }).waitFor();
await visitor.getByRole('button', { name: '← Back' }).click();
await visitor.getByRole('button', { name: 'Get started' }).waitFor();
await visitor.getByRole('button', { name: 'Terms' }).click();
await visitor.getByRole('heading', { name: 'Terms' }).waitFor();
assert.equal(new URL(visitor.url()).pathname, '/terms');
await visitor.goBack();
await visitor.getByRole('button', { name: 'Get started' }).waitFor();
step('privacy and terms pages');

// Minors are turned away at signup
const kid = await person('kid');
await signUp(kid, { birthdate: `${new Date().getUTCFullYear() - 15}-03-03` });
await kid.getByText(/for adults 18 and over/).waitFor();
step('under-18 signup is refused');

// Two adults sign up
const alice = await person('alice');
const bob = await person('bob');
const pages = [alice, bob];
await kid.shot('0-welcome');
await signUp(alice);
await signUp(bob);
const aliceHandle = (await alice.locator('.who strong').textContent()).trim();
const sw = await alice.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  return Boolean(reg.active);
});
assert.equal(sw, true, 'service worker active');
const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
assert.equal(manifest.display, 'standalone');
if (process.env.EXPECT_PUSH) await alice.getByText('Get a notification when someone replies').waitFor();
const bobHandle = (await bob.locator('.who strong').textContent()).trim();
assert.notEqual(aliceHandle, bobHandle);
await alice.getByRole('button', { name: 'Find someone' }).waitFor();
await alice.shot('1-home');
step(`signed up as ${aliceHandle} and ${bobHandle}`);

// Match: Alice needs to talk about money, Bob can listen
await alice.getByRole('radio', { name: 'I need to talk' }).click();
await alice.getByRole('button', { name: 'Money' }).click();
await alice.getByRole('button', { name: 'Find someone' }).click();
await alice.locator('.waiting').waitFor();
await alice.shot('2-waiting');
await bob.getByRole('radio', { name: 'I can listen' }).click();
await bob.getByRole('button', { name: 'Find someone' }).click();
await alice.locator('.chat-who', { hasText: bobHandle }).waitFor();
await bob.locator('.chat-who', { hasText: aliceHandle }).waitFor();
step('matched in real time');

// Chat both ways, with typing indicator
await alice.getByLabel('Message').fill('Rent is due Friday and I am short. Feeling dumb about it.');
await bob.getByText('typing…').waitFor();
await alice.getByLabel('Message').press('Enter');
await bob.locator('.bubble.them', { hasText: 'Rent is due Friday' }).waitFor();
await bob.getByLabel('Message').fill("Not dumb at all. Happens to so many people. Want to talk through options?");
await bob.getByRole('button', { name: 'Send' }).click();
await alice.locator('.bubble.them', { hasText: 'Not dumb at all' }).waitFor();
await alice.shot('3-chat');
step('messages delivered both ways, typing shown');

// Bob leaves the chat; Alice's next message shows up as unread in his list
await bob.getByRole('button', { name: 'Back to conversations' }).click();
await bob.locator('.convo', { hasText: aliceHandle }).waitFor();
await alice.getByLabel('Message').fill('Thank you. Really.');
await alice.getByLabel('Message').press('Enter');
await bob.locator('.convo .count', { hasText: '1' }).waitFor();
assert.match(await bob.locator('.convo').first().innerText(), /Thank you\. Really\./);
await bob.shot('4-home-unread');
step('unread message shows on the conversation list');

// Reload keeps the session and the history
await bob.reload();
await bob.locator('.convo', { hasText: aliceHandle }).click();
await bob.locator('.bubble', { hasText: 'Thank you. Really.' }).waitFor();
assert.equal(await bob.locator('.bubble').count(), 3);
step('session and history survive reload');

// The phone back button returns to the list instead of leaving the app
await bob.goBack();
await bob.locator('.convo', { hasText: aliceHandle }).waitFor();
await bob.goForward();
await bob.locator('.bubble', { hasText: 'Thank you. Really.' }).waitFor();
step('back and forward buttons move between screens');

// Safety: phone numbers are held back with an explanation
await alice.getByLabel('Message').fill('text me 555 123 4567');
await alice.getByLabel('Message').press('Enter');
await alice.locator('.bubble.held .held-note', { hasText: "Contact details" }).waitFor();
await bob.waitForTimeout(500);
assert.equal(await bob.locator('.bubble', { hasText: '555' }).count(), 0, 'partner never sees held messages');
step('contact info held with an explanation');

// Crisis language: sender sees resources, listener sees guidance
await alice.getByLabel('Message').fill('some days I just want to die');
await alice.getByLabel('Message').press('Enter');
await alice.locator('.crisis', { hasText: 'You matter' }).waitFor();
await bob.locator('.crisis', { hasText: 'going through something heavy' }).waitFor();
await bob.shot('5-crisis-listener');
await alice.shot('5b-held-and-crisis');
step('crisis resources shown to both sides');

// After a real exchange, Alice thanks Bob; his home screen shows it
await bob.getByLabel('Message').fill("I'm here. Take your time, I'm listening.");
await bob.getByLabel('Message').press('Enter');
await alice.locator('.bubble.them', { hasText: "I'm listening" }).waitFor();
await alice.getByRole('button', { name: '💙 Yes, thank them' }).click();
await alice.locator('.feedback-bar').waitFor({ state: 'detached' });
await bob.getByRole('button', { name: 'Back to conversations' }).click();
await bob.getByText(`💙 ${aliceHandle} said talking with you helped.`).waitFor();
await bob.getByText(/You've helped 1 person/).waitFor();
await bob.locator('.presence', { hasText: 'people here now' }).waitFor();
await bob.shot('6a-thanked');
await bob.locator('.convo', { hasText: aliceHandle }).click();
step('thank-you reaches the listener and counts on their home screen');

// Connect: Alice asks, Bob accepts, both see what the other chose to share
await alice.getByRole('button', { name: 'Conversation options' }).click();
await alice.getByRole('menuitem', { name: 'Connect…' }).click();
await alice.getByLabel('First name or nickname').fill('Jav');
await alice.getByLabel(/A way to reach you/).fill('@jav.writes');
await alice.shot('7-connect-request');
await alice.getByRole('button', { name: 'Send request' }).click();
await alice.getByText('Connect request sent.').waitFor();
await bob.getByText(`${aliceHandle} would like to connect.`).waitFor();
await bob.shot('7b-connect-incoming');
await bob.getByRole('button', { name: 'Accept…' }).click();
await bob.getByLabel('First name or nickname').fill('Rob');
await bob.getByRole('button', { name: 'Accept and connect' }).click();
await bob.locator('.connect-banner.accepted', { hasText: 'Jav' }).waitFor();
assert.match(await bob.locator('.connect-banner.accepted').innerText(), /@jav\.writes/);
await alice.locator('.connect-banner.accepted', { hasText: 'Rob' }).waitFor();
await alice.shot('7c-connected');
step('mutual connect reveals both names only after both agree');

// Report and block
await bob.getByRole('button', { name: 'Conversation options' }).click();
await bob.getByRole('menuitem', { name: 'Report' }).click();
await bob.getByText('Harassment or bullying').click();
await bob.shot('6-report');
await bob.getByRole('button', { name: 'Report and block' }).click();
await bob.locator('.notice', { hasText: 'was reported and blocked' }).waitFor();
assert.equal(await bob.locator('.convo').count(), 0);
await alice.getByText('This conversation has ended.').waitFor();
step('report blocks and ends the chat for both');

// Moderator (MOD_EMAIL must be in the server's ADMIN_EMAILS, and MAIL_LOG must point at the
// server's output so the email confirmation link can be followed) reviews the report and suspends
if (process.env.MOD_EMAIL && process.env.MAIL_LOG) {
  const mod = await person('mod');
  await mod.goto(BASE);
  await mod.getByRole('button', { name: 'Get started' }).click();
  await mod.getByLabel('Email').fill(process.env.MOD_EMAIL);
  await mod.getByLabel(/Password/).fill('quiet-harbor-9');
  await mod.getByLabel(/Birthdate/).fill('1980-01-01');
  await mod.getByLabel(/I'm 18 or older/).check();
  await mod.getByRole('button', { name: 'Create account' }).click();
  await mod.getByRole('button', { name: 'Find someone' }).waitFor();
  assert.equal(await mod.getByRole('button', { name: 'Moderate' }).count(), 0, 'not a moderator until the email is confirmed');
  await mod.waitForTimeout(300);
  const verifyLinks = [...readFileSync(process.env.MAIL_LOG, 'utf8').matchAll(/to=(\S+) subject="Confirm[^"]*"\n[\s\S]*?(https?:\/\/\S+\/verify#[\w-]+)/g)]
    .filter((m) => m[1] === process.env.MOD_EMAIL);
  await mod.goto(verifyLinks[verifyLinks.length - 1][2]);
  await mod.getByText('Email confirmed. Thank you!').waitFor();
  await mod.getByRole('button', { name: 'Moderate' }).click();
  const card = mod.locator('.report', { hasText: aliceHandle }).first();
  await card.waitFor();
  assert.match(await card.innerText(), /Harassment/);
  assert.match(await card.innerText(), /Rent is due Friday/);
  await mod.getByRole('tab', { name: /Held messages/ }).click();
  await mod.locator('.report', { hasText: aliceHandle }).filter({ hasText: '555 123 4567' }).first().waitFor();
  await mod.getByRole('tab', { name: /Reports/ }).click();
  await mod.shot('8-moderate');
  await card.getByRole('button', { name: `Suspend ${aliceHandle}` }).click();
  await mod.getByText('No open reports.').waitFor();
  await alice.reload();
  await alice.getByText('Your account is paused').waitFor();
  step('moderator reviewed the report and suspended the account');
  pages.push(mod);
}

// Forgot password: with MAIL_LOG pointing at the server's output (no email provider),
// read the reset link from the log and set a new password.
if (process.env.MAIL_LOG) {
  const bobEmail = await bob.evaluate(async () => (await (await fetch('/api/account/export')).json()).account.email);
  await bob.goto(BASE);
  await bob.getByRole('button', { name: 'Account' }).click();
  await bob.getByRole('button', { name: 'Sign out' }).click();
  await bob.getByRole('button', { name: 'I have an account' }).click();
  await bob.getByRole('button', { name: 'Forgot password?' }).click();
  await bob.getByLabel('Email').fill(bobEmail);
  await bob.getByRole('button', { name: 'Send reset link' }).click();
  await bob.getByText(/a reset link is on its way/).waitFor();
  await bob.waitForTimeout(300);
  const links = [...readFileSync(process.env.MAIL_LOG, 'utf8').matchAll(/(https?:\/\/\S+\/reset#[\w-]+)/g)];
  assert.ok(links.length, 'reset link was logged');
  await bob.goto(links[links.length - 1][1]);
  await bob.getByLabel(/New password/).fill('a-fresh-start-7');
  await bob.getByRole('button', { name: 'Save and sign in' }).click();
  await bob.getByRole('button', { name: 'Find someone' }).waitFor();
  assert.equal(new URL(bob.url()).pathname, '/');
  step('forgot password and reset');
}

// Account: download data, then delete the account
await bob.goto(BASE);
await bob.getByRole('button', { name: 'Account' }).click();
const exported = await bob.evaluate(async () => (await fetch('/api/account/export')).json());
assert.equal(exported.account.handle, bobHandle);
await bob.getByRole('button', { name: 'Delete account' }).click();
await bob.getByLabel('Enter your password to confirm').fill(process.env.MAIL_LOG ? 'a-fresh-start-7' : 'quiet-harbor-9');
await bob.shot('9-delete');
await bob.getByRole('button', { name: 'Delete forever' }).click();
await bob.getByRole('button', { name: 'Get started' }).waitFor();
step('data export and account deletion');

for (const page of pages) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'page scrolls horizontally on a phone');
}
assert.deepEqual(errors, [], 'browser errors');
await browser.close();
console.log('E2E passed');
