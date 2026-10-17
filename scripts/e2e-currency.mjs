// Real-browser end-to-end test of an owner whose currency is NOT the CFA franc: a Kenyan visitor. Plans, wallet top-up and gifts are all
// in shillings; only international cards are offered; amounts come from the live rate (the run uses scripts/fx-stub.mjs: 1 XAF = 0.2 KES).
// Start first:  node scripts/fx-stub.mjs   and the API with   FX_API_URL=http://127.0.0.1:4299/v6/latest/XAF
// Usage: node scripts/e2e-currency.mjs [outDir] [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const exe = process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const [out = '/tmp/e2e-currency', base = 'http://localhost:4222'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
// The platform in front of the site tells it where the visitor is; the test browser sends the same header.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-GB', extraHTTPHeaders: { 'x-vercel-ip-country': 'KE' } });
const page = await ctx.newPage();
const problems = [];
const aborted = (t) => /Failed to fetch RSC payload .*Falling back to browser navigation/.test(t) || /CLIENT_FETCH_ERROR[\s\S]*Failed to fetch/.test(t);
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !aborted(m.text()) && problems.push(`console: ${m.text().slice(0, 200)}`));
page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url().replace(base, '')}`); });

let n = 0;
const step = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); console.log(`✓ ${String(++n).padStart(2, '0')} ${name} (${Date.now() - t0}ms)`); }
  catch (err) {
    await page.screenshot({ path: `${out}/FAIL-${n + 1}.png`, fullPage: true }).catch(() => {});
    console.log(`✗ ${String(++n).padStart(2, '0')} ${name}\n    ${String(err.message).split('\n').slice(0, 5).join('\n    ')}`);
    await browser.close();
    process.exit(1);
  }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const shot = (name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
const call = (method, path, body) =>
  page.evaluate(async ([m, p, b]) => {
    const r = await fetch('/proxy' + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null };
  }, [method, path, body]);
const email = `ke${Date.now()}@example.com`;

await step('a Kenyan visitor sees shillings on the pricing page, with the rate and the card note; signs up as Kenya (KES)', async () => {
  await page.goto(`${base}/pricing`);
  await page.getByText('2,900', { exact: true }).waitFor(); // Starter: 14,500 FCFA × 0.2
  const text = await page.locator('body').innerText();
  expect(/KES \/ month/.test(text) && !/FCFA \/ month/.test(text), 'prices in KES, not FCFA');
  expect(/1 FCFA = 0\.2 KES/.test(text) && /international Visa or Mastercard/.test(text) && /ExchangeRate-API/.test(text), 'the rate note says how the price was made');
  await shot('01-pricing-ke');
  await page.goto(`${base}/register`);
  expect(await page.locator('#phone').inputValue() === '+254 ', 'Kenyan prefix');
  await page.fill('#businessName', 'Nairobi Shop'); await page.fill('#name', 'Wanjiru'); await page.fill('#phone', '+254 712 345 678');
  await page.fill('#email', email); await page.fill('#password', 'a-long-test-password');
  await page.click('button[type=submit]');
  await page.waitForURL('**/onboarding**', { timeout: 30000 });
  await page.getByRole('radio', { name: /Academics/ }).click();
  await page.getByRole('heading', { name: 'Connect WhatsApp' }).waitFor({ timeout: 10000 }); // choosing a segment moves on by itself
  await page.getByRole('button', { name: /use a simulated number/i }).click();
  await page.getByTestId('ob-connected').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /go to dashboard/i }).click();
  await page.waitForURL('**/dashboard**', { timeout: 15000 });
});

await step('settings: Currency reads "Kenya (KES)"; the plan prices of the billing page are in shillings', async () => {
  await page.goto(`${base}/billing`); // (onboarding no longer has a plan step: plans are chosen here)
  await page.getByText('7,800', { exact: true }).first().waitFor({ timeout: 15000 }); // Growth 39,000 × 0.2
  await page.goto(`${base}/settings`);
  await page.locator('#p-currency').waitFor();
  expect(await page.locator('#p-currency').inputValue() === 'Kenya (KES)', `got ${await page.locator('#p-currency').inputValue()}`);
});

await step('billing: Growth costs 7,800 KES, the checkout offers only card, and the rate note is shown', async () => {
  await page.goto(`${base}/billing?plan=growth`);
  await page.getByRole('heading', { name: /subscribe to growth/i }).waitFor({ timeout: 15000 });
  const dlg = await page.getByRole('dialog').innerText();
  expect(!/Mobile Money|Orange Money/i.test(dlg), 'no Mobile Money in shillings');
  expect(/Visa/.test(dlg) && /1 FCFA = 0\.2 KES/.test(dlg) && /ExchangeRate-API/.test(dlg), 'card + rate note in the checkout');
  await page.getByRole('button', { name: /^pay 7,800 KES/i }).click();
  await page.waitForURL(/mock-checkout/, { timeout: 30000 });
  await page.getByRole('button', { name: /pay \(success\)/i }).click();
  await page.getByRole('heading', { name: 'Payment received' }).waitFor({ timeout: 30000 });
  const sub = (await call('GET', '/subscription')).json;
  expect(sub.currency === 'KES' && sub.subscription.amountFCFA === 39000, `plan recorded at its FCFA price, charged in KES: ${JSON.stringify([sub.currency, sub.subscription.amountFCFA])}`);
  const inv = sub.invoices[0];
  expect(inv.currency === 'KES' && inv.amount === 7800, `invoice in KES: ${JSON.stringify(inv)}`);
  await shot('02-billing-ke');
});

await step('wallet: balance and limits in shillings; top-up offers only card; credited in shillings after the PSP confirms', async () => {
  await page.goto(`${base}/billing`);
  await page.locator('[data-testid=wallet-balance]').waitFor();
  expect(/0\s*KES/.test(await page.locator('[data-testid=wallet-balance]').innerText()), 'wallet shows KES');
  await page.getByRole('button', { name: 'Top up', exact: true }).click();
  const dlg = page.getByRole('dialog');
  expect(/Amount to add \(KES\)/.test(await dlg.innerText()), 'amount label in KES');
  expect(/Between 500 KES and 200,000 KES/.test(await dlg.innerText()), `limits in KES, got: ${await dlg.innerText()}`);
  expect(!/Mobile Money|Orange Money/i.test(await dlg.innerText()), 'no Mobile Money');
  await shot('03-topup-ke');
  await dlg.getByRole('button', { name: '5,000', exact: true }).click();
  await dlg.getByRole('button', { name: /Add 5,000 KES/ }).click();
  await page.waitForURL(/mock-checkout/, { timeout: 30000 });
  expect((await call('GET', '/wallet')).json.balance === 0, 'nothing credited while pending');
  await page.getByRole('button', { name: 'Pay (success)' }).click();
  await page.getByRole('heading', { name: 'Wallet topped up' }).waitFor({ timeout: 20000 });
  const w = (await call('GET', '/wallet')).json;
  expect(w.currency === 'KES' && w.balance === 5000, `wallet in KES: ${JSON.stringify([w.currency, w.balance])}`);
  expect(w.entries[0].delta === 5000 && w.entries[0].kind === 'topup', 'ledger entry in KES');
});

await step('builder: gift amount is in KES with KES limits (20–5,000), and the cost panel shows shillings', async () => {
  await page.goto(`${base}/surveys/new`);
  await page.getByRole('button', { name: /start from scratch/i }).click();
  await page.waitForURL(/\/surveys\/[a-z0-9]+$/);
  await page.getByText('Airtime / data bundle').click();
  const amount = page.getByLabel(/amount per participant \(KES\)/i);
  await amount.waitFor();
  await amount.fill('10');
  await page.getByLabel(/what participants are told/i).fill('Airtime');
  await page.locator('#title').fill('Shillings survey');
  await page.getByRole('button', { name: /add question/i }).first().click();
  await page.locator('ol > li').nth(0).locator('textarea').fill('Did you like it?');
  await page.locator('ol > li').nth(0).locator('input[placeholder^="Option"]').nth(0).fill('Yes');
  await page.locator('ol > li').nth(0).locator('input[placeholder^="Option"]').nth(1).fill('No');
  await page.getByRole('button', { name: /save draft/i }).click();
  await page.getByText(/Enter an amount between 20 KES and 5,000 KES/).waitFor();
  await amount.fill('100');
  const panel = page.locator('[data-testid=gift-cost-panel]');
  await panel.waitFor();
  const txt = await panel.innerText();
  expect(/105 KES/.test(txt) && /100 KES gift \+ 5 KES fee/.test(txt), `unit cost 105 KES expected in: ${txt}`);
  expect(/5,000 KES/.test(txt) && /covers 47 gift/.test(txt.replace(/\s+/g, ' ')), `the 5,000 KES balance covers 47 gifts of 105 KES, got: ${txt}`);
  await page.getByRole('button', { name: /save draft/i }).click();
  await page.locator('[data-sonner-toast]', { hasText: 'Saved' }).first().waitFor({ timeout: 10000 });
  await shot('04-builder-gift-ke');
});

await step('French UI: the wallet, limits and rate notes follow the language', async () => {
  await page.goto(`${base}/billing`);
  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await page.getByText(/Gift wallet|Portefeuille cadeaux/).first().waitFor();
  await page.getByRole('button', { name: 'Recharger', exact: true }).click();
  const dlg = await page.getByRole('dialog').innerText();
  expect(/Montant à ajouter \(KES\)/.test(dlg) && /Entre 500 KES et 200 000 KES/.test(dlg), `French labels in KES, got: ${dlg}`);
  await shot('05-topup-ke-fr');
  await page.keyboard.press('Escape');
  await page.goto(`${base}/pricing`);
  expect(/Les prix en KES sont convertis depuis le FCFA/.test(await page.locator('body').innerText()), 'rate note in French');
});

await browser.close();
const unique = [...new Set(problems)];
console.log(unique.length ? `\nBrowser problems seen (${unique.length}):\n  ` + unique.join('\n  ') : '\nNo console errors or 5xx responses in the whole run.');
console.log(`\nAll ${n} steps passed.`);
