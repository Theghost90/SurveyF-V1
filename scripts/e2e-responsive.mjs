// Every screen from 320 to 1920 px wide: no horizontal scroll, no element sticking out of the viewport; the menu bar stays at the top while scrolling;
// below 640 px a hamburger (public site) / a tab bar (app) replaces the text menu, and the language switch and the "Explore free" button stay visible.
// Logged in as the seeded demo owner (npm run db:seed). Usage: node scripts/e2e-responsive.mjs [outDir] [baseUrl]
import { chromium } from 'playwright-core';
import { chromePath } from './lib/browser-path.mjs';
import { mkdirSync } from 'node:fs';

const exe = await chromePath();
const [out = '/tmp/e2e-resp', base = 'http://localhost:4222'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-GB' });
const page = await ctx.newPage();
let bad = 0;
const fail = (msg) => { bad++; console.log(`✗ ${msg}`); };

// ---- shared: horizontal overflow / elements outside the viewport ----
const overflowOf = (pg) => pg.evaluate(() => {
  const vw = window.innerWidth;
  const over = document.documentElement.scrollWidth - vw;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    if (b.right > vw + 1 || b.left < -1) {
      // inside a horizontally scrollable wrapper it is fine
      let p = el.parentElement, scroll = false;
      while (p) { const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') && p.scrollWidth >= p.clientWidth) { const pb = p.getBoundingClientRect(); if (pb.right <= vw + 1 && pb.left >= -1) { scroll = true; break; } } p = p.parentElement; }
      if (!scroll) out.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} (${Math.round(b.left)}→${Math.round(b.right)})`);
    }
  }
  return { over, out: out.slice(0, 4) };
});
const checkOverflow = async (pg, w, r) => {
  const res = await overflowOf(pg);
  if (res.over > 1 || res.out.length) { fail(`${w}px ${r}: page overflow ${res.over}px; sticking out: ${res.out.join(', ')}`); await pg.screenshot({ path: `${out}/${w}-${r.replace(/[^a-z0-9]+/gi, '_')}.png`, fullPage: true }); }
};
const box = async (loc) => (await loc.count() && await loc.first().isVisible()) ? loc.first().boundingBox() : null;
const overlap = (a, b) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
/** The menu bar stays glued to the top of the viewport after scrolling a long way down. */
const stickyOk = async (pg, header) => {
  await pg.evaluate(() => window.scrollTo(0, Math.max(600, document.body.scrollHeight / 2)));
  await pg.waitForTimeout(250);
  const y = await pg.evaluate(() => window.scrollY);
  const top = (await header.boundingBox())?.y;
  return { scrolled: y > 100, top };
};

const WIDTHS = [320, 360, 390, 430, 600, 639, 640, 768, 1024, 1280, 1440, 1920];

// ---- A. the public site, logged out ----
const pub = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-GB' });
const pp = await pub.newPage();
const publicRoutes = ['/', '/pricing', '/privacy', '/terms', '/login', '/register', '/forgot-password', '/check-email?email=owner%40example.com', '/verify-email?token=sample', '/reset-password?token=sample', '/link-google?token=sample'];
// The sign-in family has no marketing header: only the overflow and sticky checks apply to it.
const AUTH_ONLY = new Set(['/login', '/register', '/forgot-password', '/check-email?email=owner%40example.com', '/verify-email?token=sample', '/reset-password?token=sample', '/link-google?token=sample']);
for (const w of WIDTHS) {
  await pp.setViewportSize({ width: w, height: 900 });
  for (const r of publicRoutes) {
    await pp.goto(`${base}${r}`, { waitUntil: 'load' });
    await pp.waitForTimeout(700);
    await checkOverflow(pp, w, r);
    if (AUTH_ONLY.has(r)) continue;
    const header = pp.locator('header').first();
    const phone = w < 640;
    const lang = pp.locator('header [role=group]').first();
    const cta = pp.locator('header a[href="/register"]').first();
    const burger = pp.getByRole('button', { name: 'Open menu' });
    const vis = { lang: await box(lang), cta: await box(cta), burger: await box(burger) };
    if (!vis.lang) fail(`${w}px ${r}: the language switch is not visible`);
    if (!vis.cta) fail(`${w}px ${r}: the "Explore free" button is not visible`);
    if (phone && !vis.burger) fail(`${w}px ${r}: no hamburger below 640 px`);
    if (!phone && vis.burger) fail(`${w}px ${r}: the hamburger must be hidden from 640 px`);
    if (!phone && !(await pp.locator('header nav a', { hasText: 'Pricing' }).first().isVisible())) fail(`${w}px ${r}: the text menu is not visible from 640 px`);
    if (phone && (await pp.locator('header nav a', { hasText: 'Pricing' }).first().isVisible())) fail(`${w}px ${r}: the text menu must give way to the hamburger below 640 px`);
    const logo = await box(pp.locator('header a[href="/"]'));
    const parts = [logo, vis.lang, vis.cta, vis.burger].filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].x < 0 || parts[i].x + parts[i].width > w) fail(`${w}px ${r}: a menu-bar item is outside the screen`);
      for (let j = i + 1; j < parts.length; j++) if (overlap(parts[i], parts[j])) fail(`${w}px ${r}: menu-bar items overlap`);
    }
    if (phone) { const h = (await header.boundingBox())?.height ?? 0; if (h > 72) fail(`${w}px ${r}: the phone menu bar is ${Math.round(h)}px high (one row expected)`); }
    if (phone && vis.burger && (vis.burger.width < 44 || vis.burger.height < 44)) fail(`${w}px ${r}: the hamburger is smaller than 44 px`);
    if (r === '/' || r === '/pricing') {
      const st = await stickyOk(pp, header);
      if (!st.scrolled) fail(`${w}px ${r}: the page is too short to test the sticky bar`);
      else if (Math.abs(st.top ?? 99) > 1) fail(`${w}px ${r}: the menu bar scrolled away (top = ${st.top})`);
    }
  }
  console.log(`${w}px: public site checked`);
}

// the hamburger's side menu
await pp.setViewportSize({ width: 360, height: 800 });
await pp.goto(`${base}/`, { waitUntil: 'load' });
await pp.waitForTimeout(600);
await pp.screenshot({ path: `${out}/phone-home-bar.png` });
await pp.getByRole('button', { name: 'Open menu' }).click();
const drawer = pp.getByRole('dialog');
await drawer.waitFor();
await pp.waitForTimeout(400);
await pp.screenshot({ path: `${out}/phone-home-menu.png` });
for (const name of ['How it works', 'Gifts', 'For agencies & NGOs', 'Pricing', 'Sign in', 'Explore free']) if (!(await drawer.getByText(name, { exact: true }).count())) fail(`the side menu lacks "${name}"`);
const db = await drawer.boundingBox();
if (!db || db.x + db.width > 360.5 || db.height < 700) fail('the side menu does not fill the height of the screen');
await pp.keyboard.press('Escape');
await pp.waitForTimeout(300);
if (await pp.getByRole('dialog').count()) fail('Escape does not close the side menu');
await pp.getByRole('button', { name: 'Open menu' }).click();
await pp.getByRole('dialog').getByRole('link', { name: 'Pricing' }).click();
await pp.waitForURL('**/pricing');
await pp.waitForTimeout(500);
if (await pp.getByRole('dialog').count()) fail('the side menu stays open after choosing a link');
// French: the short label must still fit
await pub.addCookies([{ name: 'sf_lang', value: 'fr', url: base }]);
for (const w of [320, 360, 390]) {
  await pp.setViewportSize({ width: w, height: 800 });
  await pp.goto(`${base}/`, { waitUntil: 'load' });
  await pp.waitForTimeout(500);
  const l = await box(pp.locator('header [role=group]')), c = await box(pp.locator('header a[href="/register"]')), b = await box(pp.getByRole('button', { name: /menu/i }));
  if (!l || !c || !b) fail(`${w}px (FR): language switch, "Explorer" or the hamburger is missing`);
  else if (overlap(l, c) || overlap(c, b) || b.x + b.width > w) fail(`${w}px (FR): the menu bar does not fit`);
}
console.log('public menu bar + side menu checked');
await pub.close();

// ---- B. the app, logged in as the demo owner ----
await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200); // let the form hydrate before typing
await page.fill('input[type=email]', 'demo@surveyflow.test');
await page.fill('input[type=password]', 'demo-password-123');
await page.click('button[type=submit]');
await page.waitForURL('**/dashboard**', { timeout: 30000 });
const call = (path) => page.evaluate(async (p) => (await (await fetch('/proxy' + p)).json()), path);
const surveys = (await call('/surveys?pageSize=50')).items ?? [];
const active = surveys.find((s) => s.status === 'active') ?? surveys[0];
const routes = ['/dashboard', '/surveys', '/surveys/new', '/contacts', '/settings?tab=profile', '/settings?tab=whatsapp', '/settings?tab=analytics', '/settings?tab=security', '/settings?tab=integrations', '/billing', '/simulator', '/simulator?mode=owner',
  ...(active ? [`/surveys/${active.id}`, `/surveys/${active.id}/analytics`, `/surveys/${active.id}/export`] : []), '/pricing', '/'];
const widths = [320, 360, 390, 600, 768, 1024, 1280, 1920];
for (const w of widths) {
  await page.setViewportSize({ width: w, height: 900 });
  for (const r of routes) {
    await page.goto(`${base}${r}`, { waitUntil: 'load' });
    await page.waitForTimeout(1000);
    await checkOverflow(page, w, r);
  }
  console.log(`${w}px: ${routes.length} screens checked`);
}
// app navigation: text menu from 640 px (no Settings in it), tab bar below (no More), Billing / Settings / Sign out in the account menu at every width
const appNav = async (w) => {
  await page.setViewportSize({ width: w, height: 800 });
  await page.goto(`${base}/dashboard`, { waitUntil: 'load' });
  const account = page.getByRole('button', { name: 'Account' });
  await account.waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
  const header = page.locator('header').first();
  const phone = w < 640;
  const text = header.locator('nav a');
  const labels = (await text.allInnerTexts()).map((x) => x.trim());
  if (phone) {
    if (labels.length && await text.first().isVisible()) fail(`${w}px: the text menu must be hidden below 640 px`);
    const tabs = (await page.locator('nav.fixed a, nav.fixed button').allInnerTexts()).map((x) => x.trim());
    if (tabs.join('|') !== 'Home|Surveys|Contacts|Simulator') fail(`${w}px: tab bar is ${tabs.join('|')}`);
    if (await page.getByRole('button', { name: 'More' }).count()) fail(`${w}px: the "More" button must be gone`);
  } else {
    if (labels.join('|') !== 'Dashboard|Surveys|Contacts|Simulator') fail(`${w}px: text menu is ${labels.join('|')} (no Settings expected)`);
    if (await page.locator('nav.fixed').isVisible()) fail(`${w}px: the tab bar must be hidden from 640 px`);
  }
  const ab = await account.boundingBox();
  if (!ab || ab.height < 44 - 0.5) fail(`${w}px: the account menu button is smaller than 44 px high`);
  const lang = await box(header.locator('[role=group]'));
  if (!lang) fail(`${w}px: the language switch is not visible in the app bar`);
  const st = await stickyOk(page, header);
  if (st.scrolled && Math.abs(st.top ?? 99) > 1) fail(`${w}px: the app bar scrolled away (top = ${st.top})`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await account.click();
  const menu = page.getByRole('menu');
  await menu.waitFor();
  for (const name of ['Billing', 'Settings', 'Sign out']) if (!(await menu.getByRole('menuitem', { name: new RegExp(`^${name}`) }).count())) fail(`${w}px: the account menu lacks ${name}`);
  if (phone && !(await menu.getByText('Growth').count()) && !(await menu.getByText('Explore').count())) fail(`${w}px: the plan badge is missing from the account menu on a phone`);
  if (w === 390 || w === 1280) await page.screenshot({ path: `${out}/app-${w}-account-menu.png` });
  await page.keyboard.press('Escape');
  // Settings is reachable from the account menu
  await account.click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.waitForURL('**/settings**');
};
for (const w of [320, 360, 390, 600, 639, 640, 768, 1024, 1280, 1920]) await appNav(w);
console.log('app navigation checked');
await browser.close();
if (bad) { console.log(`\n${bad} problem(s)`); process.exit(1); }
console.log('\nNo horizontal overflow on any screen at any width; menus behave at every width.');
