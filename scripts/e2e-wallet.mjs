// Real-browser end-to-end test of the owner-pays gift flow (web :4222 + API :4223, mock WhatsApp / mock PSP).
// Starts from an EMPTY wallet and follows the money: warn → participant finishes unpaid → top up → release → delivered.
// Usage: node scripts/e2e-wallet.mjs [outDir] [baseUrl]
import { chromium } from 'playwright-core';
import { chromePath } from './lib/browser-path.mjs';
import { confirmAndSignIn } from './lib/signup.mjs';
import { mkdirSync } from 'node:fs';

const exe = await chromePath();
const [out = '/tmp/e2e-wallet', base = 'http://localhost:4222'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-GB' });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text().slice(0, 200)}`));
page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url().replace(base, '')}`); });

let n = 0;
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`✓ ${String(++n).padStart(2, '0')} ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    await page.screenshot({ path: `${out}/FAIL-${n + 1}.png`, fullPage: true }).catch(() => {});
    console.log(`✗ ${String(++n).padStart(2, '0')} ${name}\n    ${String(err.message).split('\n').slice(0, 5).join('\n    ')}`);
    await browser.close();
    process.exit(1);
  }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const shot = (name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
const toast = (re) => page.locator('[data-sonner-toast]', { hasText: re }).first().waitFor({ timeout: 10000 });
const call = (method, path, body) =>
  page.evaluate(async ([m, p, b]) => {
    const r = await fetch('/proxy' + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null };
  }, [method, path, body]);
const email = `wallet${Date.now()}@example.com`;
const state = {};

await step('register, upgrade to Growth (mock checkout), connect a simulated number, add 2 contacts', async () => {
  await page.goto(`${base}/register`);
  await page.fill('#businessName', 'Café Wallet');
  await page.fill('#name', 'Awa Wallet');
  await page.fill('#phone', '+237 677 11 22 33');
  await page.fill('#email', email);
  await page.fill('#password', 'a-long-test-password');
  await page.click('button[type=submit]');
  await confirmAndSignIn(page, base, { email });
  await page.getByRole('radio', { name: /Businesses/ }).click(); // the one required onboarding answer; the app redirects here until it is given
  await page.getByRole('heading', { name: 'Connect WhatsApp' }).waitFor({ timeout: 10000 }); // choosing a segment moves on by itself
  const up = await call('PUT', '/subscription/upgrade', { plan: 'growth', interval: 'monthly', method: 'mobile_money', phone: '+237677112233' });
  expect(up.status === 200, `upgrade: ${JSON.stringify(up)}`);
  const paid = await call('POST', `/payments/mock/${up.json.reference}`, { outcome: 'success' });
  expect(paid.json.status === 'success', 'plan payment should settle');
  expect((await call('POST', '/whatsapp/accounts/mock')).status === 201, 'mock number');
  for (const [i, name] of ['Marie N.', 'Paul K.'].entries()) {
    const c = await call('POST', '/contacts', { name, phone: `+2376771000${String(i).padStart(2, '0')}`, consent: true });
    expect(c.status === 201, `contact: ${JSON.stringify(c)}`);
  }
  state.contacts = (await call('GET', '/contacts?pageSize=10')).json.items;
});

await step('a brand-new wallet is empty and the billing page says who pays', async () => {
  await page.goto(`${base}/billing`);
  const bal = page.locator('[data-testid=wallet-balance]');
  await bal.waitFor();
  expect((await bal.innerText()).trim().startsWith('0'), `balance should start at 0, got ${await bal.innerText()}`);
  await page.getByText(/You pay for the gifts your participants receive/).waitFor();
  await page.getByText(/plus a 5% processing fee/).waitFor();
  await shot('01-wallet-empty');
});

await step('builder: an airtime gift shows its true cost to the owner and warns that the wallet is empty', async () => {
  const s = await call('POST', '/surveys', {
    title: 'Wallet test', language: 'en',
    questions: [
      { text: 'How was it?', type: 'button', required: true, options: [{ id: 'g', label: 'Good' }, { id: 'b', label: 'Bad' }] },
      { text: 'Anything to add?', type: 'text', required: false },
    ],
    gift: { giftType: 'airtime', giftValue: '500 FCFA airtime', giftAmount: 500, giftDeliveryMode: 'immediate', giftMaxCount: 5 },
  });
  expect(s.status === 201, `survey: ${JSON.stringify(s)}`);
  state.survey = s.json;
  await page.goto(`${base}/surveys/${s.json.id}`);
  const panel = page.locator('[data-testid=gift-cost-panel]');
  await panel.waitFor({ timeout: 15000 });
  const txt = await panel.innerText();
  expect(/525\s*FCFA/.test(txt), `unit cost 525 (500 + 5% fee) expected in: ${txt}`);
  expect(/2,625\s*FCFA/.test(txt), `max spend 5 × 525 = 2,625 expected in: ${txt}`);
  expect(/Your wallet is empty/.test(txt), 'empty-wallet warning expected');
  await shot('02-builder-cost-panel');
});

await step('publishing with an empty wallet is allowed but never silent', async () => {
  await page.getByRole('button', { name: 'Publish' }).first().click();
  await toast(/gift wallet is empty/i);
  await page.getByText(/Your gift wallet is empty: nobody will receive a gift/).waitFor({ timeout: 15000 });
  await shot('03-send-panel-warning');
  await page.getByRole('button', { name: /Send survey via WhatsApp/ }).click();
  await toast(/2 invitation\(s\) queued/);
  await call('POST', '/dev/jobs/run');
});

await step('a participant finishes while the wallet is empty: plain thank-you, no promise, gift parked as unfunded', async () => {
  const sid = state.survey.id;
  const cid = state.contacts[0].id;
  const send = (b) => call('POST', `/dev/simulator/${cid}/send`, b);
  await send({ type: 'template', payload: `START:${sid}`, title: 'Start' });
  const q = (await call('GET', `/surveys/${sid}`)).json.questions;
  await send({ type: 'reply', id: `a:${q[0].id}:${q[0].options[0].id}`, title: 'Good' });
  const snap = await send({ type: 'text', text: 'All good' });
  const last = JSON.stringify(snap.json.chat.filter((c) => c.direction === 'out').at(-1));
  expect(!/airtime/i.test(last), `thank-you must NOT promise a gift that is not funded: ${last}`);
  const gifts = (await call('GET', `/surveys/${sid}/gifts`)).json;
  expect(gifts.money.unfunded.count === 1 && gifts.money.sent.count === 0, `expected 1 unfunded, got ${JSON.stringify(gifts.money)}`);
});

await step('analytics tells the owner exactly what happened and offers the next step (top up first)', async () => {
  await page.goto(`${base}/surveys/${state.survey.id}/analytics`);
  const box = page.locator('[data-testid=gift-unfunded]');
  await box.waitFor({ timeout: 15000 });
  expect(/finished while your wallet was empty/.test(await box.innerText()), 'unfunded explanation expected');
  await box.getByRole('link', { name: 'Top up first' }).waitFor();
  expect(await page.getByText('Download receipt').count() === 0, 'no receipt link before any gift was delivered');
  expect(await page.getByTestId('gift-receipts').count() === 0, 'no delivered-gifts list before any gift was delivered');
  await shot('04-analytics-unfunded');
});

await step('top up 10,000 FCFA through the payment layer: nothing is credited until the PSP confirms', async () => {
  await page.goto(`${base}/billing`);
  await page.getByRole('button', { name: 'Top up', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: '10,000', exact: true }).click();
  await shot('05-topup-dialog');
  await dlg.getByRole('button', { name: /Add 10,000 FCFA/ }).click();
  await page.waitForURL(/mock-checkout/, { timeout: 30000 });
  const mid = (await call('GET', '/wallet')).json.balance;
  expect(mid === 0, `balance must still be 0 while the payment is pending, got ${mid}`);
  await page.getByRole('button', { name: 'Pay (success)' }).click();
  await page.getByRole('heading', { name: 'Wallet topped up' }).waitFor({ timeout: 20000 });
  await page.getByRole('link', { name: 'Gift wallet', exact: true }).click();
  await page.waitForURL(/\/billing/);
  await page.locator('[data-testid=wallet-balance]').filter({ hasText: '10,000' }).waitFor({ timeout: 15000 });
  await page.getByText(/1 waiting for funds · 525 FCFA/).waitFor();
  await shot('06-wallet-funded');
});

await step('release the backlog: debits exactly one gift (525), and the gift is delivered with a template notice', async () => {
  await page.goto(`${base}/surveys/${state.survey.id}/analytics`);
  await page.getByRole('button', { name: /Pay these gifts \(525 FCFA\)/ }).click();
  await toast(/1 gift\(s\) paid and on their way/);
  await call('POST', '/dev/jobs/run');
  await call('POST', '/dev/jobs/run'); // second pass sends the gift notice enqueued by the first
  const gifts = (await call('GET', `/surveys/${state.survey.id}/gifts`)).json;
  expect(gifts.money.sent.count === 1 && gifts.money.unfunded.count === 0, `expected 1 sent, got ${JSON.stringify(gifts.money)}`);
  await page.reload();
  await page.getByTestId('gift-spent').filter({ hasText: '525 FCFA charged so far' }).waitFor({ timeout: 15000 });
  const w = (await call('GET', '/wallet')).json;
  expect(w.balance === 9475, `10,000 − 525 = 9,475, got ${w.balance}`);
  const snap = (await call('GET', `/dev/simulator/${state.contacts[0].id}`)).json;
  expect(JSON.stringify(snap.chat).includes('survey_gift_notice'), 'late gift must be announced with the approved template, not free text');
  await shot('07-analytics-paid');

  // proof of gift: the link exists only now that the gift was delivered, and it opens a real PDF with no login
  const link = page.getByTestId('gift-receipts').getByRole('link', { name: 'Download receipt' });
  await link.waitFor({ timeout: 15000 });
  const href = await link.getAttribute('href');
  const pdf = await page.request.get(href); // no cookies of the owner session needed: the participant has no account
  expect(pdf.status() === 200 && (pdf.headers()['content-type'] ?? '').includes('application/pdf'), `receipt should be a PDF, got ${pdf.status()} ${pdf.headers()['content-type']}`);
  expect((await pdf.body()).subarray(0, 4).toString() === '%PDF', 'receipt body should start with %PDF');
  const tampered = await page.request.get(href.slice(0, -2) + 'xx');
  expect(tampered.status() === 404, `a tampered receipt link must 404, got ${tampered.status()}`);
  // and the participant's WhatsApp notice carries the same link as a "Download receipt" button
  await page.goto(`${base}/simulator`);
  await page.locator('#sim-contact').click();
  await page.getByRole('option').nth(0).click();
  const btn = page.locator('[aria-label="Simulated chat"]').getByRole('link', { name: 'Download receipt' });
  await btn.waitFor({ timeout: 15000 });
  expect((await btn.getAttribute('href')).startsWith('/proxy/receipts/'), 'simulator button should point at the receipt');
  await shot('07b-simulator-receipt-button');
});

await step('double release is a no-op (nothing left, nothing charged twice)', async () => {
  const again = (await call('POST', `/surveys/${state.survey.id}/gifts/release`)).json;
  expect(again.released === 0 && again.remaining === 0, JSON.stringify(again));
  expect((await call('GET', '/wallet')).json.balance === 9475, 'balance must not move');
});

await step('wallet history explains every movement and the header chip shows the balance', async () => {
  await page.goto(`${base}/billing`);
  await page.getByRole('cell', { name: /^Top-up/ }).first().waitFor();
  await page.getByRole('cell', { name: /^Gift/ }).first().waitFor();
  await page.getByRole('link', { name: /Gift wallet: 9,475 FCFA/ }).waitFor();
  await shot('08-wallet-history');
});

await step('funded wallet, participant answers in the open 24 h window: the sent-notice has a "Download receipt" BUTTON, not a raw URL', async () => {
  // The other path (batch / late gift) is a template and was checked above; this is the free-text window path, which must look the same.
  const sid = state.survey.id;
  const cid = state.contacts[1].id;
  const send = (b) => call('POST', `/dev/simulator/${cid}/send`, b);
  await send({ type: 'template', payload: `START:${sid}`, title: 'Start' });
  const q = (await call('GET', `/surveys/${sid}`)).json.questions;
  await send({ type: 'reply', id: `a:${q[0].id}:${q[0].options[0].id}`, title: 'Good' });
  await send({ type: 'text', text: 'All good' });
  await call('POST', '/dev/jobs/run');
  const chat = (await call('GET', `/dev/simulator/${cid}`)).json.chat.filter((c) => c.direction === 'out');
  const notice = chat.at(-1).message;
  expect(notice?.kind === 'link' && notice.buttonLabel === 'Download receipt' && /\/api\/receipts\//.test(notice.url), `expected a link-button message, got ${JSON.stringify(chat.at(-1))}`);
  expect(!/receipts/.test(notice.body), `the text must not contain the URL: ${notice.body}`);
  await page.goto(`${base}/simulator`);
  await page.locator('#sim-contact').click();
  await page.getByRole('option').nth(1).click();
  const sim = page.locator('[aria-label="Simulated chat"]');
  const btn = sim.getByRole('link', { name: 'Download receipt' });
  await btn.waitFor({ timeout: 15000 });
  expect((await btn.getAttribute('href')).startsWith('/proxy/receipts/'), 'simulator button should point at the receipt');
  expect(!/localhost:4223|\/api\/receipts\//.test(await sim.innerText()), 'no raw receipt URL may be visible in the chat');
  const pdf = await page.request.get(new URL(await btn.getAttribute('href'), base).toString());
  expect(pdf.status() === 200 && (pdf.headers()['content-type'] ?? '').includes('application/pdf'), `the button must open a PDF, got ${pdf.status()}`);
  await shot('07c-simulator-receipt-button-in-window');
});

await step('French UI: the wallet and cost warnings are fully translated', async () => {
  await ctx.addCookies([{ name: 'sf_lang', value: 'fr', url: base }]);
  await page.goto(`${base}/billing`);
  await page.getByText('Portefeuille cadeaux').first().waitFor();
  await page.getByText(/C’est vous qui payez les cadeaux/).waitFor();
  await page.getByRole('button', { name: 'Recharger', exact: true }).waitFor();
  await shot('09-wallet-fr');
  await ctx.addCookies([{ name: 'sf_lang', value: 'en', url: base }]);
});

await step('mobile (390px): wallet card fits without horizontal scroll', async () => {
  const m = await ctx.newPage();
  await m.setViewportSize({ width: 390, height: 844 });
  await m.goto(`${base}/billing`);
  await m.locator('[data-testid=wallet-balance]').waitFor();
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow <= 0, `horizontal overflow of ${overflow}px on mobile`);
  await m.screenshot({ path: `${out}/10-wallet-mobile.png`, fullPage: true });
  await m.close();
});

await browser.close();
if (problems.length) {
  console.log('\nBrowser problems:\n' + [...new Set(problems)].map((p) => '  ' + p).join('\n'));
  process.exit(1);
}
console.log(`\nAll ${n} steps passed. Screenshots in ${out}`);
