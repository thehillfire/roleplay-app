// Store listing screenshots from the real app: Google Play (1080×1920) and the App Store's
// 6.5" iPhone size (1284×2778), plus Play's 1024×500 feature graphic.
// Usage: start a server, then  BASE_URL=http://localhost:3000 OUT=store-assets node e2e/store-shots.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = process.env.OUT || 'store-assets';
const SIZES = [
  { name: 'play', width: 360, height: 640, scale: 3 }, // 1080×1920
  { name: 'ios-6.5', width: 428, height: 926, scale: 3 }, // 1284×2778
];
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

async function person(size) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  return page;
}

async function signUp(page) {
  await page.goto(`${BASE}/?app=android`);
  await page.getByRole('button', { name: 'Get started' }).click();
  // Social sign-in may be on; the email form is behind its own tab or link in some builds.
  await page.getByLabel('Email').fill(`shots-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`);
  await page.getByLabel(/Password/).fill('quiet-harbor-9');
  await page.getByLabel(/Birthdate/).fill('1990-06-01');
  await page.getByLabel(/I'm 18 or older/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Find someone' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.btn.big')?.disabled);
}

const shot = async (page, size, n, label) => {
  await page.waitForTimeout(1900); // let entry animations and splashes finish
  await page.screenshot({ path: `${OUT}/${size.name}-${n}-${label}.png` });
};

for (const size of SIZES) {
  const a = await person(size);
  const b = await person(size);
  await signUp(a);
  await signUp(b);
  await capture(a, b, size);
  await a.context().close();
  await b.context().close();
}

async function capture(a, b, size) {
  await shot(a, size, 1, 'home');
  // A support chat.
  await a.getByRole('button', { name: 'Find someone' }).click();
  await b.getByRole('radio', { name: 'I can listen' }).click();
  await b.getByRole('button', { name: 'Find someone' }).click();
  await a.locator('.chat').waitFor();
  await b.locator('.chat').waitFor();
  const say = async (p, text) => {
    await p.getByLabel('Message', { exact: true }).fill(text);
    await p.getByRole('button', { name: 'Send', exact: true }).click();
    await p.waitForTimeout(250);
  };
  await say(a, 'Rough week. Rent is due Friday and I feel dumb about being short.');
  await say(b, "Not dumb at all. That happens to so many people. Want to talk through it?");
  await say(a, 'Yeah. Thanks for being here.');
  await shot(a, size, 2, 'chat');
  // Cringe Duel.
  for (const p of [a, b]) await p.getByRole('button', { name: /Back to conversations/ }).click();
  await a.getByRole('radio', { name: /Cringe Duel/ }).click();
  await shot(a, size, 3, 'modes');
  await a.getByRole('button', { name: 'Find someone' }).click();
  await b.getByRole('radio', { name: /Cringe Duel/ }).click();
  await b.getByRole('button', { name: 'Find someone' }).click();
  await a.locator('.game-panel').waitFor();
  await say(b, 'Okay that red light one. It was a ballad. A long one. With hand gestures.');
  await shot(a, size, 4, 'cringe-duel');
  // Your color.
  await a.getByRole('button', { name: /Back to conversations/ }).click();
  await a.getByRole('button', { name: 'Account' }).click();
  await a.getByRole('radio', { name: 'Rush' }).click();
  await shot(a, size, 5, 'your-color');
  await a.getByRole('radio', { name: 'Volt' }).click();
}

// Play feature graphic: the icon mark and the name on the arena background.
const fg = await browser.newPage({ viewport: { width: 1024, height: 500 } });
await fg.goto(`${BASE}/offline.html`); // same origin, so the icon and fonts load
await fg.setContent(`<html><head><link href="https://fonts.googleapis.com/css2?family=Anton&display=swap" rel="stylesheet"></head>
<body style="margin:0;width:1024px;height:500px;overflow:hidden;background:#0b0a10;font-family:Anton,Impact,sans-serif">
<div style="position:absolute;inset:0;background:linear-gradient(115deg,transparent 0 55%,rgba(255,225,77,.18) 55% 62%,transparent 62%),repeating-linear-gradient(115deg,rgba(255,255,255,.02) 0 2px,transparent 2px 22px)"></div>
<img src="${BASE}/icon-512.png" style="position:absolute;left:70px;top:90px;width:320px;height:320px">
<div style="position:absolute;left:430px;top:120px;color:#f3f1f7;font-size:150px;line-height:1;transform:skewX(-9deg);text-shadow:6px 6px 0 #ffe14d">KINDRED</div>
<div style="position:absolute;left:440px;top:300px;padding:6px 18px;background:#ffe14d;color:#15120a;font-size:34px;transform:skewX(-9deg)">TALK TO SOMEONE. NOBODY HAS TO KNOW.</div>
</body></html>`);
await fg.waitForTimeout(1200);
await fg.screenshot({ path: `${OUT}/play-feature-graphic-1024x500.png` });

await browser.close();
console.log(`Store screenshots written to ${OUT}/`);
