// Every width and every real device size, in portrait AND landscape, in English and French: the menu bars never overlap, never wrap, never leave the screen,
// stay at the top, and leave most of a short (landscape phone) screen to the page; no sticky element is taller than the screen; menus open inside it.
// Logged in as the seeded demo owner (npm run db:seed). Usage: node scripts/e2e-landscape.mjs [outDir] [baseUrl]
import { chromium } from 'playwright-core';
import { chromePath } from './lib/browser-path.mjs';
import { mkdirSync } from 'node:fs';

const exe = await chromePath();
const [out = '/tmp/e2e-land', base = 'http://localhost:4222'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let bad = 0;
const seen = new Set();
const fail = (msg) => { if (seen.has(msg)) return; seen.add(msg); bad++; console.log(`✗ ${msg}`); };

const DEVICES = [
  ['iPhone SE', 375, 667], ['iPhone 8 Plus', 414, 736], ['iPhone 12 mini', 375, 812], ['iPhone 14', 390, 844], ['iPhone 14 Pro Max', 430, 932],
  ['Galaxy S8+', 360, 740], ['Pixel 7', 412, 915], ['small Android', 320, 568], ['Galaxy Fold (folded)', 280, 653],
  ['iPad mini', 768, 1024], ['iPad Air', 820, 1180], ['iPad Pro 12.9', 1024, 1366], ['laptop 1366', 1366, 768], ['laptop 1280', 1280, 720], ['desktop 1920', 1920, 1080],
].flatMap(([n, w, h]) => [[`${n} portrait`, w, h], [`${n} landscape`, h, w]]);

const box = async (loc) => { const l = loc.first(); return (await loc.count() && await l.isVisible()) ? l.boundingBox() : null; };
const overlap = (a, b) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/** One row of items that fit: inside the screen, not on top of each other. Returns the header's height. */
async function checkBar(pg, label, w, h, items) {
  const header = pg.locator('header').first();
  const hb = await header.boundingBox();
  if (!hb) { fail(`${label}: no header`); return 0; }
  const parts = [];
  for (const [name, loc] of items) { const b = await box(loc); if (b) parts.push([name, b]); }
  for (let i = 0; i < parts.length; i++) {
    const [n, b] = parts[i];
    if (b.x < -0.5 || b.x + b.width > w + 0.5) fail(`${label}: "${n}" leaves the screen (${Math.round(b.x)}→${Math.round(b.x + b.width)} of ${w})`);
    if (b.y < hb.y - 0.5 || b.y + b.height > hb.y + hb.height + 0.5) fail(`${label}: "${n}" is outside the bar (the bar wrapped to a second row?)`);
    for (let j = i + 1; j < parts.length; j++) if (overlap(b, parts[j][1])) fail(`${label}: "${n}" overlaps "${parts[j][0]}"`);
  }
  const limit = h <= 480 ? 56 : 84;
  if (hb.height > limit) fail(`${label}: the menu bar is ${Math.round(hb.height)}px high (at most ${limit}px at this screen height)`);
  return hb.height;
}

const publicItems = (pg) => [
  ['logo', pg.locator('header a[href="/"]')],
  ...['How it works', 'Comment ça marche', 'Gifts', 'Cadeaux', 'For agencies', 'Agences', 'Pricing', 'Tarifs'].map((t) => [t, pg.locator('header nav a', { hasText: t })]),
  ['language', pg.locator('header [role=group]')], ['sign in', pg.locator('header a[href="/login"]')], ['call to action', pg.locator('header a[href="/register"]')], ['hamburger', pg.getByRole('button', { name: /menu/i })],
];
const appItems = (pg) => [
  ['logo', pg.locator('header a[href="/dashboard"]').first()],
  ...['Dashboard', 'Tableau de bord', 'Surveys', 'Sondages', 'Contacts', 'Simulator', 'Simulateur'].map((t) => [t, pg.locator('header nav a', { hasText: t })]),
  ['plan badge', pg.locator('header a[href="/billing"]').first()], ['wallet', pg.locator('header a[href="/billing#wallet"]')], ['language', pg.locator('header [role=group]')], ['account', pg.getByRole('button', { name: /^(Account|Compte)$/ })],
];

/** No element is `position: sticky` and taller than the room it has (its lower part would be unreachable). */
const stickyTooTall = (pg) => pg.evaluate(() => {
  const vh = innerHeight, bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'sticky' || el.tagName === 'HEADER') continue;
    const r = el.getBoundingClientRect(), top = parseFloat(cs.top) || 0;
    if (r.height > vh - top - 8) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} is ${Math.round(r.height)}px, room ${Math.round(vh - top)}px`);
  }
  return bad;
});
const overflowOf = (pg) => pg.evaluate(() => {
  const vw = innerWidth, out = [];
  for (const el of document.querySelectorAll('body *')) {
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height || (b.right <= vw + 1 && b.left >= -1)) continue;
    let p = el.parentElement, ok = false;
    while (p) { const o = getComputedStyle(p).overflowX; if (['auto', 'scroll', 'hidden', 'clip'].includes(o) && p.scrollWidth >= p.clientWidth) { const pb = p.getBoundingClientRect(); if (pb.right <= vw + 1 && pb.left >= -1) { ok = true; break; } } p = p.parentElement; }
    if (!ok) out.push(`${el.tagName.toLowerCase()} (${Math.round(b.left)}→${Math.round(b.right)})`);
  }
  return { over: document.documentElement.scrollWidth - vw, out: out.slice(0, 3) };
});

// ---------- A. the public site: a fine sweep of widths (every 8 px), both languages, a short screen ----------
const pub = await browser.newContext({ viewport: { width: 1280, height: 400 }, locale: 'en-GB' });
const pp = await pub.newPage();
for (const lang of ['en', 'fr']) {
  await pub.addCookies([{ name: 'sf_lang', value: lang, url: base }]);
  await pp.goto(`${base}/`, { waitUntil: 'networkidle' });
  await pp.waitForTimeout(600);
  let widthsChecked = 0;
  for (let w = 280; w <= 1440; w += 8) {
    await pp.setViewportSize({ width: w, height: 400 });
    await pp.waitForTimeout(30);
    await checkBar(pp, `public ${lang} ${w}px`, w, 400, publicItems(pp));
    widthsChecked++;
  }
  console.log(`public menu bar (${lang}): ${widthsChecked} widths from 280 to 1440 px checked`);
}

// ---------- B. devices, portrait and landscape: all public and sign-in screens ----------
const publicRoutes = ['/', '/pricing', '/privacy', '/terms', '/login', '/register', '/forgot-password', '/check-email?email=owner%40example.com', '/verify-email?token=sample', '/reset-password?token=sample', '/link-google?token=sample'];
for (const lang of ['en', 'fr']) {
  await pub.addCookies([{ name: 'sf_lang', value: lang, url: base }]);
  for (const [name, w, h] of DEVICES) {
    await pp.setViewportSize({ width: w, height: h });
    for (const r of publicRoutes) {
      await pp.goto(`${base}${r}`, { waitUntil: 'load' });
      await pp.waitForTimeout(250);
      const o = await overflowOf(pp);
      if (o.over > 1 || o.out.length) { fail(`${lang} ${name} (${w}×${h}) ${r}: sideways scroll ${o.over}px; ${o.out.join(', ')}`); await pp.screenshot({ path: `${out}/${lang}-${name.replace(/\W+/g, '_')}-${r.replace(/\W+/g, '_')}.png` }); }
      for (const t of await stickyTooTall(pp)) fail(`${lang} ${name} ${r}: sticky ${t}`);
      if (r === '/' || r === '/pricing') {
        await pp.evaluate(() => window.scrollTo(0, 800));
        await pp.waitForTimeout(150);
        const top = (await pp.locator('header').first().boundingBox())?.y ?? 99;
        if (Math.abs(top) > 1) fail(`${lang} ${name} ${r}: the menu bar scrolled away`);
        await pp.evaluate(() => window.scrollTo(0, 0));
      }
    }
    // the hamburger's side menu on a short phone screen: the call to action must stay reachable
    if (w < 640) {
      await pp.goto(`${base}/`, { waitUntil: 'load' });
      await pp.getByRole('button', { name: /menu/i }).first().click();
      const d = pp.getByRole('dialog');
      await d.waitFor();
      await pp.waitForTimeout(350);
      const cta = await box(d.getByRole('link', { name: lang === 'fr' ? /Explorer gratuitement/ : /Explore free/ }));
      if (!cta || cta.y + cta.height > h + 0.5 || cta.y < 0) fail(`${lang} ${name} (${w}×${h}): the side menu's call to action is not on the screen`);
      const close = await box(d.getByRole('button', { name: /menu/i }));
      if (!close || close.y < 0) fail(`${lang} ${name}: the side menu cannot be closed`);
      await pp.keyboard.press('Escape');
    }
  }
  console.log(`public screens on ${DEVICES.length} device orientations (${lang}) checked`);
}
await pub.close();

// ---------- C. the app, logged in ----------
const ctx = await browser.newContext({ viewport: { width: 1280, height: 400 }, locale: 'en-GB' });
const page = await ctx.newPage();
await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.fill('input[type=email]', 'demo@surveyflow.test');
await page.fill('input[type=password]', 'demo-password-123');
await page.click('button[type=submit]');
await page.waitForURL('**/dashboard**', { timeout: 60000 });
const call = (p) => page.evaluate(async (x) => (await (await fetch('/proxy' + x)).json()), p);
const active = ((await call('/surveys?pageSize=50')).items ?? []).find((s) => s.status === 'active');
const appRoutes = ['/dashboard', '/surveys', '/surveys/new', '/contacts', '/settings?tab=profile', '/settings?tab=whatsapp', '/settings?tab=analytics', '/settings?tab=security', '/settings?tab=integrations', '/billing', '/simulator', '/simulator?mode=owner',
  ...(active ? [`/surveys/${active.id}`, `/surveys/${active.id}/analytics`, `/surveys/${active.id}/export`] : [])];

for (const lang of ['en', 'fr']) {
  await ctx.addCookies([{ name: 'sf_lang', value: lang, url: base }]);
  await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  for (let w = 320; w <= 1440; w += 8) {
    await page.setViewportSize({ width: w, height: 400 });
    await page.waitForTimeout(30);
    await checkBar(page, `app ${lang} ${w}px`, w, 400, appItems(page));
  }
  console.log(`app header (${lang}): widths from 320 to 1440 px checked`);
  for (const [name, w, h] of DEVICES) {
    await page.setViewportSize({ width: w, height: h });
    for (const r of appRoutes) {
      await page.goto(`${base}${r}`, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      const o = await overflowOf(page);
      if (o.over > 1 || o.out.length) { fail(`${lang} ${name} (${w}×${h}) ${r}: sideways scroll ${o.over}px; ${o.out.join(', ')}`); await page.screenshot({ path: `${out}/app-${lang}-${name.replace(/\W+/g, '_')}-${r.replace(/\W+/g, '_')}.png` }); }
      for (const t of await stickyTooTall(page)) fail(`${lang} ${name} (${w}×${h}) ${r}: sticky ${t}`);
    }
    // the chrome that stays on screen (bar + tab bar) leaves most of a short screen to the page
    await page.goto(`${base}/dashboard`, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const chrome = await page.evaluate(() => {
      const hd = document.querySelector('header')?.getBoundingClientRect().height ?? 0;
      const tb = document.querySelector('nav.fixed');
      return hd + (tb && getComputedStyle(tb).display !== 'none' ? tb.getBoundingClientRect().height : 0);
    });
    if (h <= 480 && chrome > h * 0.4) fail(`${lang} ${name} (${w}×${h}): the bars that stay on screen take ${Math.round(chrome)}px of ${h}px (${Math.round(chrome / h * 100)} %; at most 40 %)`);
    // the account menu opens inside a short screen
    await page.getByRole('button', { name: /^(Account|Compte)$/ }).click();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    await page.waitForTimeout(350);
    const mb = await menu.boundingBox();
    if (!mb || mb.y < -0.5 || mb.y + mb.height > h + 0.5 || mb.x < -0.5 || mb.x + mb.width > w + 0.5) fail(`${lang} ${name} (${w}×${h}): the account menu does not fit the screen`);
    else if (h <= 480) {
      // every item visible without scrolling the menu (from 320 px of height; a 280 px screen may scroll it)
      const fits = await menu.evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
      if (!fits && h >= 320) fail(`${lang} ${name} (${w}×${h}): the account menu needs scrolling (Sign out out of reach)`);
    }
    await page.keyboard.press('Escape');
  }
  console.log(`app screens on ${DEVICES.length} device orientations (${lang}) checked`);
}
await browser.close();
if (bad) { console.log(`\n${bad} problem(s)`); process.exit(1); }
console.log('\nEvery width and device orientation: bars fit on one row, nothing sticks out, sticky parts reachable, menus inside the screen.');
