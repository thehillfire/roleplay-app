// End-to-end smoke test against a running server (npm run build && npm start).
// Usage: BASE_URL=http://localhost:3000 CHROMIUM_PATH=/path/to/chrome npm run e2e
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
const shot = async (name) => SHOTS && (await page.waitForTimeout(900), await page.screenshot({ path: `${SHOTS}/${name}.png` }));
const narratorCount = () => page.locator('.turn.narrator').count();
const act = async (text) => {
  const before = await narratorCount();
  await page.getByLabel('Your action').fill(text);
  await page.getByRole('button', { name: 'Act' }).click();
  await page.waitForFunction((n) => document.querySelectorAll('.turn.narrator').length === n, before + 1);
};
const step = (name) => console.log(`✓ ${name}`);

// Guest play
await page.goto(BASE);
await shot('1-home-guest');
await page.getByText('Roll a Class').click();
await page.getByText('Begin this story').waitFor();
const heroName = (await page.locator('.class-name').textContent()).trim();
await page.getByText('Begin this story').click();
await page.locator('.chip').first().waitFor();
await act('I wave at the horizon');
step(`guest played as ${heroName}`);

// Sign up: guest story moves into the account
const email = `e2e-${Date.now()}@example.com`;
await page.getByText('← Stories').click();
await page.getByText('Sign in to save stories').click();
await page.getByLabel('Display name').fill('Night Owl');
await page.getByLabel('Email').fill(email);
await page.getByLabel(/Password/).fill('lantern-light-42');
await shot('2-signup');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByText(/1 guest story is now saved/).waitFor();
await page.locator('.saved-item', { hasText: heroName }).waitFor();
await shot('3-home-account');
step('signed up and imported guest story');

// Continue the saved story, then reload: session and progress persist
await page.locator('.saved-open', { hasText: heroName }).click();
await page.getByLabel('Your action').waitFor();
await act('I follow the river');
await page.reload();
await page.locator('.saved-item', { hasText: heroName }).waitFor();
assert.match(await page.locator('.saved-item', { hasText: heroName }).innerText(), /2 actions/);
step('saved story survives reload');

// Start a new account story from Imagine
await page.getByText('Imagine Yourself').click();
await page.getByLabel('Name').fill('Ilya of the Lantern Road');
await page.getByRole('button', { name: 'Begin story' }).click();
await page.locator('.turn.narrator').first().waitFor();
await act('I light the lantern');
await shot('4-story-account');
await page.getByText('← Stories').click();
await page.locator('.saved-item', { hasText: 'Ilya' }).waitFor();
step('imagine story saved to account');

// Sign out: device shows no stories; sign back in: both are there
await page.getByRole('button', { name: 'Sign out' }).click();
await page.getByText('Sign in to save stories').waitFor();
assert.equal(await page.locator('.saved-item').count(), 0);
await page.getByText('Sign in to save stories').click();
await page.getByRole('tab', { name: 'Sign in' }).click();
await page.getByLabel('Email').fill(email);
await page.getByLabel(/Password/).fill('wrong-password');
await page.getByRole('button', { name: 'Sign in' }).last().click();
await page.getByText('Email or password is incorrect.').waitFor();
await page.getByLabel(/Password/).fill('lantern-light-42');
await page.getByRole('button', { name: 'Sign in' }).last().click();
await page.locator('.saved-item').nth(1).waitFor();
assert.equal(await page.locator('.saved-item').count(), 2);
step('sign out, wrong password, sign back in');

// Delete a story
page.once('dialog', (d) => d.accept());
await page.getByRole('button', { name: 'Delete Ilya of the Lantern Road' }).click();
await page.waitForFunction(() => document.querySelectorAll('.saved-item').length === 1);
step('delete story');

const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
assert.equal(overflow, false, 'page scrolls horizontally on a phone');
assert.deepEqual(errors, [], 'browser errors');
await browser.close();
console.log('E2E passed');
