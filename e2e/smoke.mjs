// End-to-end smoke test: two strangers in separate browsers match and chat.
// Run against a server: npm run build && npm start, then
//   BASE_URL=http://localhost:3000 [CHROMIUM_PATH=...] [SHOTS_DIR=...] npm run e2e
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
// A fake camera, so the Don't Smile game can start its on-device face model in CI.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const errors = [];
const step = (name) => console.log(`✓ ${name}`);

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => d.accept()); // confirmations (suspend, block, sign out everywhere): say yes
  // Expected noise: 4xx responses the app handles, and the face model's engine (an info line,
  // and its built-in usage ping to Google, which our CSP blocks on purpose).
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d|odml\.pa\.googleapis\.com|XNNPACK delegate/.test(m.text()) && errors.push(`${name}: ${m.text()}`));
  page.shot = async (file) => SHOTS && (await page.waitForTimeout(500), await page.screenshot({ path: `${SHOTS}/${file}.png` }));
  return page;
}

async function signUp(page, { birthdate = '1990-06-01', expectOnboarding = true } = {}) {
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByLabel('Email').fill(`e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`);
  await page.getByLabel(/Password/).fill('quiet-harbor-9');
  await page.getByLabel(/Birthdate/).fill(birthdate);
  await page.getByLabel(/I'm 18 or older/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  if (expectOnboarding) await page.getByRole('button', { name: 'Skip' }).click(); // first-run onboarding
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
await signUp(kid, { birthdate: `${new Date().getUTCFullYear() - 15}-03-03`, expectOnboarding: false });
await kid.getByText(/for adults 18 and over/).waitFor();
step('under-18 signup is refused');

// Two adults sign up
const alice = await person('alice');
const bob = await person('bob');
// Onboarding is shown once, then remembered on this device
const newcomer = await person('newcomer');
await newcomer.goto(BASE);
await newcomer.getByRole('button', { name: 'Get started' }).click();
await newcomer.getByLabel('Email').fill(`e2e-new-${Date.now()}@example.com`);
await newcomer.getByLabel(/Password/).fill('quiet-harbor-9');
await newcomer.getByLabel(/Birthdate/).fill('1992-02-02');
await newcomer.getByLabel(/I'm 18 or older/).check();
await newcomer.getByRole('button', { name: 'Create account' }).click();
await newcomer.getByRole('heading', { name: 'Talk to someone, anytime' }).waitFor();
await newcomer.getByRole('button', { name: 'Next' }).click();
await newcomer.getByRole('button', { name: 'Next' }).click();
await newcomer.getByRole('button', { name: "Let's go" }).click();
await newcomer.reload();
await newcomer.getByRole('button', { name: 'Find someone' }).waitFor();
assert.equal(await newcomer.getByRole('dialog').count(), 0, 'onboarding not shown again');
// Private daily check-in: a low day offers a listener
await newcomer.getByRole('radio', { name: 'Low' }).click();
await newcomer.getByRole('heading', { name: 'Today: low' }).waitFor();
await newcomer.getByRole('button', { name: 'Talk to someone now' }).waitFor();
await newcomer.reload();
await newcomer.getByRole('heading', { name: 'Today: low' }).waitFor();
step('onboarding once; private daily check-in');
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
await alice.getByRole('button', { name: 'Breathe with me' }).click();
await alice.getByRole('status').filter({ hasText: 'Breathe in' }).waitFor();
await alice.getByRole('status').filter({ hasText: 'Breathe out' }).waitFor({ timeout: 6000 });
await alice.shot('2-waiting');
// Bob sees (live, no reload) that someone is waiting for a listener and steps up
await bob.getByText('Someone is waiting for someone to listen.').waitFor({ timeout: 10000 });
await bob.getByRole('button', { name: 'Be a listener' }).click();
await alice.locator('.chat-who', { hasText: bobHandle }).waitFor();
await bob.locator('.chat-who', { hasText: aliceHandle }).waitFor();
await bob.getByRole('button', { name: 'Hey. Rough day?' }).click();
assert.equal(await bob.getByLabel('Message').inputValue(), 'Hey. Rough day?');
await bob.getByLabel('Message').fill('');
step('matched in real time; openers offered in the empty chat');

// Chat both ways, with typing indicator
await alice.getByLabel('Message').fill('Rent is due Friday and I am short. Feeling dumb about it.');
await bob.getByText('typing…').waitFor();
await alice.getByLabel('Message').press('Enter');
await bob.locator('.bubble.them', { hasText: 'Rent is due Friday' }).waitFor();
await bob.getByLabel('Message').fill("Not dumb at all. Happens to so many people. Want to talk through options?");
await bob.getByRole('button', { name: 'Send' }).click();
await alice.locator('.bubble.them', { hasText: 'Not dumb at all' }).waitFor();
await alice.getByLabel('Message').fill('Yeah. Maybe.');
await alice.getByLabel('Message').press('Enter');
await alice.locator('.bubble.me time', { hasText: 'Seen' }).waitFor();
await alice.shot('3-chat');
// Bob reacts to Alice's message; she sees it
await bob.locator('.bubble.them', { hasText: 'Rent is due Friday' }).click(); // tap shows its actions
await bob.locator('.bubble.them', { hasText: 'Rent is due Friday' }).getByRole('button', { name: 'React' }).click();
await bob.getByRole('button', { name: 'Hug' }).click();
await alice.locator('.bubble.me', { hasText: 'Rent is due Friday' }).locator('.reaction', { hasText: '🫂' }).waitFor();
step('messages delivered both ways, typing shown, reactions');

// Bob leaves the chat; Alice's next message shows up as unread in his list
await bob.getByRole('button', { name: 'Back to conversations' }).click();
await bob.locator('.convo', { hasText: aliceHandle }).waitFor();
await alice.getByLabel('Message').fill('Thank you. Really.');
await alice.getByLabel('Message').press('Enter');
await bob.locator('.convo .count', { hasText: '1' }).waitFor();
assert.equal(await bob.title(), '(1) Kindred', 'unread count in the tab title');
assert.match(await bob.locator('.convo').first().innerText(), /Thank you\. Really\./);
await bob.shot('4-home-unread');
step('unread message shows on the conversation list');

// Reload keeps the session and the history
await bob.reload();
await bob.locator('.convo', { hasText: aliceHandle }).click();
await bob.locator('.bubble', { hasText: 'Thank you. Really.' }).waitFor();
assert.equal(await bob.locator('.bubble').count(), 4);
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

// Unsend: gone for both, a placeholder stays
await alice.getByLabel('Message').fill('ugh ignore that, I overshared');
await alice.getByLabel('Message').press('Enter');
await bob.locator('.bubble.them', { hasText: 'I overshared' }).waitFor();
await alice.locator('.bubble.me', { hasText: 'I overshared' }).click();
await alice.locator('.bubble.me', { hasText: 'I overshared' }).getByRole('button', { name: 'Unsend' }).click();
await alice.getByText('You unsent a message').waitFor();
await bob.getByText('Message unsent').waitFor();
assert.equal(await bob.locator('.bubble', { hasText: 'I overshared' }).count(), 0);
step('unsend removes a message for both');

// "Say goodbye…" drafts a kind sign-off without sending it
await bob.getByRole('button', { name: 'Conversation options' }).click();
await bob.getByRole('menuitem', { name: 'Say goodbye…' }).click();
assert.match(await bob.getByLabel('Message').inputValue(), /Thank you for talking with me/);
await bob.getByLabel('Message').fill('');
await bob.getByRole('button', { name: 'Conversation options' }).click();
await bob.getByRole('menuitem', { name: 'Mute notifications' }).click();
await bob.locator('.chat-who', { hasText: '🔕' }).waitFor();
await bob.getByRole('button', { name: 'Conversation options' }).click();
await bob.getByRole('menuitem', { name: 'Unmute notifications' }).click();
await bob.locator('.chat-who', { hasText: '🔕' }).waitFor({ state: 'detached' });
step('goodbye drafted, not sent; mute toggles');

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
await alice.getByLabel('Kind words').fill('You really listened. Thank you.');
await alice.getByRole('button', { name: 'Leave it' }).click();
await alice.locator('.feedback-bar').waitFor({ state: 'detached' });
await bob.getByRole('button', { name: 'Back to conversations' }).click();
await bob.getByText(/You've helped 1 person/).waitFor();
await bob.locator('.kind-words blockquote', { hasText: 'You really listened. Thank you.' }).waitFor();
await bob.locator('.presence', { hasText: 'people here now' }).waitFor();
await bob.shot('6a-thanked');
await bob.locator('.convo', { hasText: aliceHandle }).click();
step('thank-you and kind words reach the listener and show on their home screen');

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
  await mod.getByRole('button', { name: 'Skip' }).click();
  await mod.getByRole('button', { name: 'Find someone' }).waitFor();
  assert.equal(await mod.getByRole('button', { name: 'Moderate' }).count(), 0, 'not a moderator until the email is confirmed');
  await mod.waitForTimeout(300);
  const verifyLinks = [...readFileSync(process.env.MAIL_LOG, 'utf8').matchAll(/to=(\S+) subject="Confirm[^"]*"\n[\s\S]*?(https?:\/\/\S+\/verify#[\w-]+)/g)]
    .filter((m) => m[1] === process.env.MOD_EMAIL);
  await mod.goto(verifyLinks[verifyLinks.length - 1][2]);
  await mod.getByText(/Email confirmed\. To switch on moderator access/).waitFor();
  assert.equal(await mod.getByRole('button', { name: 'Moderate' }).count(), 0, 'confirming alone never grants moderator rights');
  // Moderator rights come from completing a password reset (proves the inbox, replaces the password).
  await mod.getByRole('button', { name: 'Account' }).click();
  await mod.getByRole('button', { name: 'Sign out', exact: true }).click();
  await mod.getByRole('button', { name: 'I have an account' }).click();
  await mod.getByRole('button', { name: 'Forgot password?' }).click();
  await mod.getByLabel('Email').fill(process.env.MOD_EMAIL);
  await mod.getByRole('button', { name: 'Send reset link' }).click();
  await mod.getByText(/a reset link is on its way/).waitFor();
  await mod.waitForTimeout(300);
  // One logged email per "[mail]" entry; take the moderator's latest reset link.
  const modReset = readFileSync(process.env.MAIL_LOG, 'utf8').split('[mail] ')
    .filter((m) => m.startsWith(`to=${process.env.MOD_EMAIL} `) && /\/reset#/.test(m)).at(-1).match(/https?:\/\/\S+\/reset#[\w-]+/)[0];
  await mod.goto(modReset);
  await mod.getByLabel(/New password/).fill('moderator-pass-22');
  await mod.getByRole('button', { name: 'Save and sign in' }).click();
  await mod.getByRole('button', { name: 'Moderate' }).click();
  const card = mod.locator('.report', { hasText: aliceHandle }).first();
  await card.waitFor();
  assert.match(await card.innerText(), /Harassment/);
  assert.match(await card.innerText(), /Rent is due Friday/);
  await mod.getByRole('tab', { name: /Held/ }).click();
  const heldCard = mod.locator('.report', { hasText: aliceHandle }).filter({ hasText: '555 123 4567' }).first();
  await heldCard.waitFor();
  await heldCard.getByRole('button', { name: 'Keep held' }).click();
  await mod.locator('.report', { hasText: '555 123 4567' }).first().waitFor({ state: 'detached' });
  await mod.getByRole('tab', { name: /Reports/ }).click();
  await mod.shot('8-moderate');
  await card.getByRole('button', { name: `Suspend ${aliceHandle}` }).click();
  await mod.getByText('No open reports.').waitFor();
  await alice.reload();
  await alice.getByText('Your account is paused').waitFor();
  await bob.getByText(/Thanks for your report\. A moderator has reviewed it/).waitFor();
  step('moderator reviewed the report and suspended the account; the reporter hears back');

  // The suspended person appeals; the moderator restores them, and it's in the log
  await alice.getByLabel(/Think this was a mistake/).fill('That was a misunderstanding, sorry.');
  await alice.getByRole('button', { name: 'Send to moderators' }).click();
  await alice.getByText(/Your note was sent/).waitFor();
  await mod.reload();
  await mod.getByRole('button', { name: 'Moderate' }).click();
  await mod.getByRole('tab', { name: /Appeals \(1\)/ }).click();
  await mod.getByText('That was a misunderstanding, sorry.').waitFor();
  await mod.getByRole('button', { name: 'Restore account' }).click();
  await mod.getByText('No open appeals.').waitFor();
  await mod.getByRole('tab', { name: 'Log' }).click();
  await mod.locator('.modlog li', { hasText: 'Granted an appeal' }).waitFor();
  await mod.getByRole('tab', { name: 'Look up' }).click();
  await mod.getByLabel('Handle').fill(aliceHandle.toLowerCase());
  await mod.getByRole('button', { name: 'Look up', exact: true }).click();
  const profile = mod.locator('.report', { hasText: aliceHandle });
  await profile.getByText('Granted an appeal').waitFor();
  assert.match(await profile.innerText(), /Reports against: 0 open · 1 total/);
  // A reload keeps her in her last chat (now ended by Bob, read-only and reportable); go home from there.
  await alice.reload();
  await alice.locator('.chat-head .back').click();
  await alice.getByRole('button', { name: 'Find someone' }).waitFor();
  step('appeal granted and logged; account restored');

  // Alice writes to support; the moderator replies from the Inbox
  await alice.getByRole('button', { name: 'Account' }).click();
  await alice.getByRole('button', { name: 'Write to us' }).click();
  await alice.getByLabel("What's it about?").selectOption('feedback');
  await alice.getByLabel('Your message').fill('Could there be a dark blue theme?');
  await alice.getByRole('button', { name: 'Send', exact: true }).click();
  await alice.getByText(/Thanks, we got it/).waitFor();
  await mod.reload();
  await mod.getByRole('button', { name: 'Moderate' }).click();
  await mod.getByRole('tab', { name: /Inbox \(1\)/ }).click();
  await mod.getByText('Could there be a dark blue theme?').waitFor();
  await mod.getByLabel(`Reply to ${aliceHandle}`).fill('Love it. It is on our list.');
  await mod.getByRole('button', { name: 'Send reply' }).click();
  await mod.getByText('No support requests waiting.').waitFor();
  await alice.reload();
  await alice.locator('.account, .find').first().waitFor();
  if (await alice.locator('.find').count()) await alice.getByRole('button', { name: 'Account' }).click();
  await alice.getByText('Love it. It is on our list.').waitFor();
  await alice.getByRole('button', { name: '← Back' }).click();
  step('support request answered from the moderator inbox');
  pages.push(mod);
}

// Forgot password: with MAIL_LOG pointing at the server's output (no email provider),
// read the reset link from the log and set a new password.
if (process.env.MAIL_LOG) {
  const bobEmail = await bob.evaluate(async () => (await (await fetch('/api/account/export')).json()).account.email);
  await bob.goto(BASE);
  await bob.getByRole('button', { name: 'Account' }).click();
  await bob.getByRole('button', { name: 'Sign out', exact: true }).click();
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

// Nobody around: Carol leaves a message for the next listener; Dave picks it up later
const carol = await person('carol');
await signUp(carol);
// Cancel, then browser Forward, never lands in a waiting room that isn't searching.
await carol.getByRole('button', { name: 'Find someone' }).click();
await carol.locator('.waiting').waitFor();
await carol.getByRole('button', { name: 'Cancel' }).click();
await carol.getByRole('button', { name: 'Find someone' }).waitFor();
await carol.goForward();
await carol.getByRole('button', { name: 'Find someone' }).waitFor();
assert.equal(await carol.locator('.waiting').count(), 0);
await carol.getByRole('button', { name: 'Find someone' }).click();
await carol.getByRole('button', { name: 'Leave a message for the next listener' }).click({ timeout: 25000 });
await carol.getByLabel(/What's on your mind/).fill('Long week. Could use someone to talk to when you get a minute.');
await carol.getByRole('button', { name: 'Leave it' }).click();
await carol.getByText(/Your message is waiting for the next listener/).waitFor();
await carol.locator('.waiting-message', { hasText: 'Long week.' }).waitFor();
const dave = await person('dave');
await signUp(dave);
await dave.getByText('Someone is waiting for someone to listen.').waitFor();
await dave.getByRole('button', { name: 'Be a listener' }).click();
await dave.locator('.bubble.them', { hasText: 'Long week. Could use someone to talk to' }).waitFor();
await carol.getByText(/picked up your message/).waitFor();
await carol.locator('.waiting-message').waitFor({ state: 'detached' });
pages.push(carol, dave);
step('message left for the next listener is picked up later');

// Signed out on another device: the live connection closes and this one lands on sign-in, saying why.
await dave.evaluate(() => fetch('/api/auth/logout-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
await dave.getByText('You were signed out. Sign in again').waitFor();
await dave.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
step('a session ended elsewhere goes to sign-in');

// Game modes: only people in the same mode meet; Cringe Duel cards stay in sync; Don't Smile scores.
const eve = await person('eve');
const finn = await person('finn');
await signUp(eve);
await signUp(finn);
await eve.context().grantPermissions(['camera']);
await eve.getByRole('radio', { name: /Cringe Duel/ }).click();
await eve.getByRole('button', { name: 'Find someone' }).click();
await eve.getByText('#cringeduel').waitFor();
await finn.getByRole('radio', { name: /Cringe Duel/ }).click();
await finn.getByRole('button', { name: 'Find someone' }).click();
await eve.getByText(/Card 1\/\d+/).waitFor();
await finn.getByText(/Card 1\/\d+/).waitFor();
assert.equal(await eve.locator('.game-card').textContent(), await finn.locator('.game-card').textContent(), 'both see the same card');
await eve.getByRole('button', { name: 'Next card' }).click();
await finn.getByText(/Card 2\/\d+/).waitFor();
assert.equal(await eve.locator('.game-card').textContent(), await finn.locator('.game-card').textContent(), 'the next card reaches both');
await eve.shot('10-cringe');
step('Cringe Duel: matched by mode, the same cards for both');

for (const p of [eve, finn]) await p.getByRole('button', { name: 'Back to conversations' }).click();
await eve.getByRole('radio', { name: /Don't Smile/ }).click();
await eve.getByRole('button', { name: 'Find someone' }).click();
await finn.getByRole('radio', { name: /Don't Smile/ }).click();
await finn.getByRole('button', { name: 'Find someone' }).click();
await eve.getByText('You 0 · Them 0').waitFor();
await finn.getByRole('button', { name: 'I smiled 😬' }).click();
await eve.getByText('You 1 · Them 0').waitFor();
await finn.getByText('You 0 · Them 1').waitFor();
await eve.getByRole('button', { name: 'Use my camera' }).click();
await eve.getByRole('button', { name: 'Turn camera off' }).waitFor({ timeout: 30000 });
await eve.waitForTimeout(1000);
// The preview must show the live camera. (It once showed a black box: the stream was attached to a
// different <video> than the visible one, and the buttons still toggled, so nothing else noticed.)
const preview = await eve.evaluate(() => [...document.querySelectorAll('video')].map((v) => ({ shown: v.offsetParent !== null, stream: Boolean(v.srcObject), width: v.videoWidth, playing: !v.paused })));
assert.deepEqual(preview, [{ shown: true, stream: true, width: 320, playing: true }], 'one visible, playing preview with the camera stream');
await eve.shot('11-dont-smile');
await eve.getByRole('button', { name: 'Turn camera off' }).click();
await eve.getByRole('button', { name: 'Use my camera' }).waitFor();
assert.equal(await eve.evaluate(() => Boolean(document.querySelector('video').srcObject)), false, 'turning the camera off releases it');
pages.push(eve, finn);
step("Don't Smile: smiles score for the other player; the on-device camera check starts and stops");

// Alone in a game (nobody else is looking): say so plainly, and offer a practice round.
const lone = await person('lone');
await signUp(lone);
await lone.getByRole('radio', { name: /Cringe Duel/ }).click();
await lone.getByRole('button', { name: 'Find someone' }).click();
// Other people are online here, so it says nobody is looking for *this game* (alone on the server it says "you're the only one here").
await lone.getByText(/Games need a second person looking at the same time/).waitFor({ timeout: 20000 });
await lone.getByRole('button', { name: 'Practice on my own' }).click();
await lone.getByRole('heading', { name: /Practice: Cringe Duel/ }).waitFor();
const dealt = await lone.locator('.game-card').innerText();
await lone.getByRole('button', { name: 'Next card' }).click();
assert.notEqual(await lone.locator('.game-card').innerText(), dealt, 'practice deals a new card');
await lone.shot('11b-practice');
await lone.getByRole('button', { name: '← Back' }).click();
await lone.getByRole('radio', { name: /Cringe Duel/ }).waitFor();
pages.push(lone);
step('alone in a game: told so plainly, with a practice round');

// Account: download data, then delete the account
await bob.goto(BASE);
await bob.getByRole('button', { name: 'Account' }).click();
const exported = await bob.evaluate(async () => (await fetch('/api/account/export')).json());
assert.equal(exported.account.handle, bobHandle);
await bob.getByRole('radio', { name: 'Larger' }).click();
await bob.reload();
assert.equal(await bob.evaluate(() => document.documentElement.dataset.textSize), 'larger', 'text size survives a reload');
await bob.getByRole('button', { name: 'Account' }).click();
await bob.getByRole('radio', { name: 'Rush' }).click();
assert.equal(await bob.evaluate(() => document.documentElement.dataset.accent), 'rush', 'your color applies at once');
await bob.shot('8b-your-color');
await bob.reload();
assert.equal(await bob.evaluate(() => document.documentElement.dataset.accent), 'rush', 'your color survives a reload');
await bob.getByRole('button', { name: 'Account' }).click();
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
