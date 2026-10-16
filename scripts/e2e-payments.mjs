// Real-browser end-to-end check of what a customer SEES when a payment is not decided yet, needs a person, or is about to lapse
// (web :4222 + API :4223, mock WhatsApp / mock PSP). The mock provider only knows hosted checkout pages, so for the "approve on your phone"
// case ONE response (the start of the payment) is rewritten in the browser to look like a push flow; the payment behind it and every poll are real.
// Postgres is touched directly for two things no browser can cause: a payment parked in `review`, and a plan that is about to end.
// Usage: node scripts/e2e-payments.mjs [outDir] [baseUrl]      (DATABASE_URL: the API's database; default = the dev database)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const exe = process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const [out = '/tmp/e2e-payments', base = 'http://localhost:4222'] = process.argv.slice(2);
const db = process.env.DATABASE_URL || 'postgresql://surveyflow:surveyflow@127.0.0.1:5432/surveyflow';
mkdirSync(out, { recursive: true });
const sql = (q) => execFileSync('psql', [db, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', q], { encoding: 'utf8' }).trim();

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-GB' });
// Very impatient polling, so "still not decided" is reached in a second instead of three minutes.
await ctx.addInitScript(() => { window.__SF_PAY_POLL__ = { every: 300, tries: 3 }; });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 500 && !r.url().includes('/subscription/upgrade')) problems.push(`HTTP ${r.status()} ${r.url().replace(base, '')}`); });

let n = 0;
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`✓ ${String(++n).padStart(2, '0')} ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    await page.screenshot({ path: `${out}/FAIL-${n + 1}.png`, fullPage: true }).catch(() => {});
    console.log(`✗ ${String(++n).padStart(2, '0')} ${name}\n    ${String(err.message).split('\n').slice(0, 6).join('\n    ')}`);
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
const email = `pay${Date.now()}@example.com`;
const state = {};

await step('register an owner (Cameroon, Mobile Money available)', async () => {
  await page.goto(`${base}/register`);
  await page.fill('#businessName', 'Café Paiements');
  await page.fill('#name', 'Awa Paiements');
  await page.fill('#phone', '+237 677 11 22 33');
  await page.fill('#email', email);
  await page.fill('#password', 'a-long-test-password');
  await page.click('button[type=submit]');
  await page.waitForURL('**/onboarding**', { timeout: 30000 });
  await page.getByRole('radio', { name: /Businesses/ }).click();
  await page.getByText(/Saved\. You can change it later/).waitFor({ timeout: 10000 });
});

await step('a payment the provider has not decided yet is NEVER shown as failed: "still waiting", with the reference and "do not pay again"', async () => {
  // Make the start of the payment look like a Mobile Money push (no checkout page), keep the real payment behind it.
  await page.route('**/proxy/subscription/upgrade', async (route) => {
    const res = await route.fetch();
    const tx = await res.json();
    state.ref = tx.reference; state.id = tx.id;
    await route.fulfill({ response: res, json: { ...tx, checkoutUrl: null, paymentToken: 'tok-e2e' } });
  });
  await page.goto(`${base}/billing?plan=growth`);
  await page.getByRole('heading', { name: /subscribe to growth/i }).waitFor({ timeout: 15000 });
  await page.getByRole('radio', { name: /Mobile Money/ }).click();
  await page.getByRole('button', { name: /^pay 39,000/i }).click();
  await page.getByText(/Approve the payment on your phone/).waitFor({ timeout: 10000 });
  const waiting = page.locator('[data-testid=pay-waiting]');
  await waiting.waitFor({ timeout: 15000 });
  const text = await waiting.innerText();
  expect(/Still waiting for the provider/.test(text), `waiting title missing: ${text}`);
  expect(/do not pay again/i.test(text), `must tell the customer not to pay again: ${text}`);
  expect(text.includes(state.ref), `must show the reference ${state.ref}: ${text}`);
  const all = await page.locator('body').innerText();
  expect(!/not been charged|has failed|Payment failed/i.test(all), 'a pending payment must never be called failed or "not charged"');
  await shot('01-still-waiting');
});

await step('closing the dialog does not lose it: it is listed under "Payments in progress" with a Check now button', async () => {
  await page.unroute('**/proxy/subscription/upgrade');
  await page.goto(`${base}/billing`);
  const card = page.locator('[data-testid=pay-inprogress]');
  await card.waitFor({ timeout: 15000 });
  const text = await card.innerText();
  expect(/Payments in progress/.test(text) && /Waiting for the provider/.test(text) && text.includes(state.ref), `in-progress card: ${text}`);
  await shot('02-in-progress');
});

await step('the provider confirms later (webhook / reconciliation): the customer presses Check now, the plan is active and the card disappears', async () => {
  const paid = await call('POST', `/payments/mock/${state.ref}`, { outcome: 'success' }); // what the provider's webhook does
  expect(paid.json.status === 'success', `mock settle: ${JSON.stringify(paid)}`);
  const card = page.locator('[data-testid=pay-inprogress]');
  await card.getByRole('button', { name: 'Check now' }).click();
  await card.waitFor({ state: 'detached', timeout: 25000 });
  await page.getByText('Growth', { exact: true }).first().waitFor({ timeout: 15000 });
  await shot('02b-activated');
});

await step('an upgrade tells the customer, before they pay, that the days left on the current plan are not credited', async () => {
  await page.goto(`${base}/billing?plan=business`);
  await page.getByRole('heading', { name: /subscribe to business/i }).waitFor({ timeout: 15000 });
  const note = page.locator('[data-testid=no-proration]');
  await note.waitFor({ timeout: 10000 });
  expect(/Your new plan starts today/.test(await note.innerText()), 'no-proration notice text');
  await shot('03-no-proration');
});

await step('a payment parked for review (money received, a person decides) says so calmly: reference, "nothing is lost", never "failed"', async () => {
  // Start a real payment, then park it as the API does when a provider reports less than asked.
  await page.goto(`${base}/billing`);
  const up = await call('PUT', '/subscription/upgrade', { plan: 'business', interval: 'monthly', method: 'card' });
  expect(up.status === 200, `upgrade: ${JSON.stringify(up)}`);
  state.review = up.json.reference;
  sql(`update "PaymentTransaction" set status = 'review', "failReason" = 'underpaid: provider reports 3000 XAF, asked 99000 XAF' where reference = '${state.review}'`);
  await page.goto(`${base}/billing`);
  const card = page.locator('[data-testid=pay-inprogress]');
  await card.waitFor({ timeout: 15000 });
  const text = await card.innerText();
  expect(/We received your payment but could not apply it automatically/.test(text) && text.includes(state.review), `review text: ${text}`);
  expect(!/failed|not been charged/i.test(text), 'a payment in review is not a failure');
  expect(!/underpaid|3000/.test(text), 'the operator detail must not reach the customer');
  await shot('04-review-in-list');
  await page.goto(`${base}/billing/return?ref=${state.review}`);
  const view = page.locator('[data-testid=pay-review]');
  await view.waitFor({ timeout: 15000 });
  expect((await view.innerText()).includes(state.review), 'return page shows the reference');
  await shot('05-review-return');
});

await step('three days before the end of a paid plan the app says so, in English and in French, and links to billing', async () => {
  sql(`update "Subscription" set "currentPeriodEnd" = now() + interval '2 days' where "userId" = (select id from "User" where email = '${email}')`);
  await page.goto(`${base}/dashboard`);
  await page.getByText(/Your plan ends in 2 day\(s\)\. Renewal is not automatic/).waitFor({ timeout: 15000 });
  await shot('06-renewal-banner');
  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await page.getByText(/Votre forfait se termine dans 2 jour\(s\)\. Le renouvellement n’est pas automatique/).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await page.getByText(/Your plan ends in 2 day\(s\)/).waitFor({ timeout: 15000 });
});

await step('a start we could not confirm (502) tells the customer, in words, NOT to pay again — and nothing generic', async () => {
  await page.route('**/proxy/subscription/upgrade', (route) =>
    route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'psp_unconfirmed', message: 'x' }) }));
  await page.goto(`${base}/billing?plan=business`);
  await page.getByRole('heading', { name: /subscribe to business/i }).waitFor({ timeout: 15000 });
  await page.getByRole('radio', { name: /Mobile Money/ }).click();
  await page.getByRole('button', { name: /^pay /i }).click();
  const alert = page.getByRole('alert').filter({ hasText: /Do not pay again yet/ });
  await alert.waitFor({ timeout: 10000 });
  expect(/check your phone/i.test(await alert.innerText()), 'tells the customer to check the phone');
  await shot('07-unconfirmed');
  await page.unroute('**/proxy/subscription/upgrade');
});

expect(problems.length === 0, `browser problems:\n${problems.join('\n')}`);
console.log(`\nAll ${n} steps passed. Screenshots in ${out}`);
await browser.close();
