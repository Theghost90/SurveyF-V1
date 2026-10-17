// Usage: node scripts/shoot.mjs <outDir> <name=url[@WxH][+full]>...   (uses the preinstalled Chromium)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const exe = process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const [out, ...jobs] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
for (const job of jobs) {
  const [name, rest] = job.split('=');
  const [urlAndSize, flag] = rest.split('+');
  const [url, size = '1440x1000'] = urlAndSize.split('@');
  const [w, h] = size.split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, locale: 'en-GB' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror:`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.log(`[${name}] console.error:`, m.text().slice(0, 200)));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => console.log(`[${name}] goto: ${e.message}`));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: flag === 'full' });
  await ctx.close();
}
await browser.close();
