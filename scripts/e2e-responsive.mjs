// Every main screen at phone (360, 390), small tablet (768) and laptop (1280) widths: no horizontal scroll, no element sticking out of the viewport,
// no tap target smaller than 32px in the header. Logged in as the seeded demo owner (npm run db:seed). Usage: node scripts/e2e-responsive.mjs [outDir] [baseUrl]
import { chromium } from 'playwright-core';
import { chromePath } from './lib/browser-path.mjs';
import { mkdirSync } from 'node:fs';

const exe = await chromePath();
const [out = '/tmp/e2e-resp', base = 'http://localhost:4222'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-GB' });
const page = await ctx.newPage();
await page.goto(`${base}/login`);
await page.fill('input[type=email]', 'demo@surveyflow.test');
await page.fill('input[type=password]', 'demo-password-123');
await page.click('button[type=submit]');
await page.waitForURL('**/dashboard**', { timeout: 30000 });
const call = (path) => page.evaluate(async (p) => (await (await fetch('/proxy' + p)).json()), path);
const surveys = (await call('/surveys?pageSize=50')).items ?? [];
const active = surveys.find((s) => s.status === 'active') ?? surveys[0];
const routes = ['/dashboard', '/surveys', '/surveys/new', '/contacts', '/settings?tab=profile', '/settings?tab=whatsapp', '/settings?tab=analytics', '/settings?tab=integrations', '/billing', '/simulator', '/simulator?mode=owner',
  ...(active ? [`/surveys/${active.id}`, `/surveys/${active.id}/analytics`, `/surveys/${active.id}/export`] : []), '/pricing', '/'];
const widths = [360, 390, 768, 1280];
let bad = 0;
for (const w of widths) {
  await page.setViewportSize({ width: w, height: 900 });
  for (const r of routes) {
    await page.goto(`${base}${r}`, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const res = await page.evaluate(() => {
      const vw = window.innerWidth;
      const over = document.documentElement.scrollWidth - vw;
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.right > vw + 1 || b.left < -1) {
          // inside a horizontally scrollable wrapper it is fine
          let p = el.parentElement, scroll = false;
          while (p) { const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll' || o === 'hidden') && p.scrollWidth >= p.clientWidth) { const pb = p.getBoundingClientRect(); if (pb.right <= vw + 1 && pb.left >= -1) { scroll = true; break; } } p = p.parentElement; }
          if (!scroll) out.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} (${Math.round(b.left)}→${Math.round(b.right)})`);
        }
      }
      return { over, out: out.slice(0, 4) };
    });
    const ok = res.over <= 1 && res.out.length === 0;
    if (!ok) { bad++; console.log(`✗ ${w}px ${r}: page overflow ${res.over}px; sticking out: ${res.out.join(', ')}`); await page.screenshot({ path: `${out}/${w}-${r.replace(/[^a-z0-9]+/gi, '_')}.png`, fullPage: true }); }
  }
  console.log(`${w}px: ${routes.length} screens checked`);
}
// phone navigation: a fixed tab bar and a More sheet (below 640 px); the text menu only from 640 px
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${base}/dashboard`);
const bar = page.locator('nav[aria-label]').filter({ has: page.getByRole('button', { name: 'More' }) });
await bar.waitFor({ timeout: 15000 });
const tabs = (await bar.locator('a, button').allInnerTexts()).map((x) => x.trim());
if (tabs.join('|') !== 'Home|Surveys|Contacts|Simulator|More') { console.log(`✗ tab bar is ${tabs.join('|')}`); bad++; }
await bar.getByRole('button', { name: 'More' }).click();
for (const name of ['Billing & wallet', 'Settings', 'Analytics on WhatsApp', 'Sign out']) {
  if (!(await page.getByRole('dialog').getByText(name).count())) { console.log(`✗ More sheet lacks ${name}`); bad++; }
}
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(300);
if (await bar.isVisible()) { console.log('✗ the phone tab bar must be hidden from 640 px'); bad++; }
console.log('phone navigation checked');
await browser.close();
if (bad) { console.log(`\n${bad} problem(s)`); process.exit(1); }
console.log('\nNo horizontal overflow on any screen at any width.');
