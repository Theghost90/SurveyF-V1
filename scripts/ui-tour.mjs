// Logs in through the real form and screenshots every main screen. Reports console errors and failed requests.
// Usage: node scripts/ui-tour.mjs <outDir> [baseUrl] [locale]
import { chromium } from 'playwright-core';
import { chromePath } from './lib/browser-path.mjs';
import { mkdirSync } from 'node:fs';

const exe = await chromePath();
const [out, base = 'http://localhost:4222', locale = 'en-GB'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text().slice(0, 220)}`));
page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/_next/')) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(base, '')}`); });

const go = async (name, path, { full = true, wait = 900, action } = {}) => {
  problems.length = 0;
  await page.goto(base + path, { waitUntil: 'networkidle', timeout: 90000 }).catch((e) => problems.push('goto: ' + e.message));
  if (action) await action();
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: full });
  console.log(`${problems.length ? '✗' : '✓'} ${name} ${path}${problems.length ? '\n    ' + [...new Set(problems)].join('\n    ') : ''}`);
};

await go('01-login', '/login', { full: false });
await page.fill('#email', 'demo@surveyflow.test');
await page.fill('#password', 'demo-password-123');
await Promise.all([page.waitForURL('**/dashboard', { timeout: 60000 }), page.click('button[type=submit]')]);
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/02-dashboard.png`, fullPage: true });
console.log('✓ 02-dashboard (after login)');

const surveyId = await page.evaluate(async () => (await (await fetch('/proxy/surveys')).json()).items.find((s) => s.status === 'active')?.id);
const draftId = await page.evaluate(async () => (await (await fetch('/proxy/surveys')).json()).items.find((s) => s.status === 'draft')?.id);
console.log('active survey', surveyId, 'draft', draftId);

await go('03-surveys', '/surveys');
await go('04-new-survey', '/surveys/new');
await go('05-builder-active', `/surveys/${surveyId}`);
await go('06-builder-draft', `/surveys/${draftId}`);
await go('07-analytics', `/surveys/${surveyId}/analytics`, { wait: 1800 });
await go('08-export', `/surveys/${surveyId}/export`);
await go('09-contacts', '/contacts');
await go('10-settings-profile', '/settings');
await go('11-settings-whatsapp', '/settings?tab=whatsapp');
await go('12-billing', '/billing');
await go('13-onboarding', '/onboarding');
await go('14-simulator', '/simulator', { wait: 1500 });
await browser.close();
