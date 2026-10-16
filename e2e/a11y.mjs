// Accessibility audit with axe-core across the main screens.
// Usage: BASE_URL=http://localhost:3000 [CHROMIUM_PATH=...] npm run a11y
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let failures = 0;
let onboardingAudited = false;

async function audit(page, name) {
  await page.waitForTimeout(400);
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
  const serious = result.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  for (const v of result.violations) {
    console.log(`${serious.includes(v) ? '✗' : '·'} [${name}] ${v.impact} ${v.id}: ${v.help}`);
    for (const n of v.nodes.slice(0, 3)) console.log(`    ${n.target.join(' ')}`);
  }
  if (!result.violations.length) console.log(`✓ [${name}] no violations`);
  failures += serious.length;
}

async function person() {
  // bypassCSP: the app's CSP (correctly) blocks injecting the axe script.
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, bypassCSP: true })).newPage();
  await page.goto(BASE);
  return page;
}

const signUp = async (page) => {
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByLabel('Email').fill(`a11y-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel(/Password/).fill('quiet-harbor-9');
  await page.getByLabel(/Birthdate/).fill('1990-01-01');
  await page.getByLabel(/I'm 18 or older/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('dialog').waitFor();
  if (!onboardingAudited) {
    onboardingAudited = true;
    await audit(page, 'onboarding');
  }
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Find someone' }).waitFor();
};

const a = await person();
await audit(a, 'welcome');
await a.getByRole('button', { name: 'Get started' }).click();
await audit(a, 'signup');
await a.goto(BASE);
await signUp(a);
await audit(a, 'home');
const b = await person();
await signUp(b);
await a.getByRole('button', { name: 'Find someone' }).click();
await audit(a, 'waiting');
await b.getByRole('radio', { name: 'I can listen' }).click();
await b.getByRole('button', { name: 'Find someone' }).click();
await a.getByLabel('Message').waitFor();
await a.getByLabel('Message').fill('hello there, rough day');
await a.getByLabel('Message').press('Enter');
await b.locator('.bubble.them').waitFor();
await audit(b, 'chat');
await b.getByRole('button', { name: 'Conversation options' }).click();
await b.getByRole('menuitem', { name: 'Report' }).click();
await audit(b, 'report sheet');
await b.keyboard.press('Escape');
await b.goto(BASE);
await b.getByRole('button', { name: 'Account' }).click();
await audit(b, 'account');
await b.getByRole('button', { name: 'Privacy policy' }).click();
await audit(b, 'privacy');

await browser.close();
console.log(failures ? `\n${failures} serious/critical violation(s)` : '\nNo serious or critical violations');
process.exit(failures ? 1 : 0);
