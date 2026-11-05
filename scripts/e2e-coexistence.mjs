// Real-browser end-to-end check of Embedded Signup with and without coexistence (WA-11..WA-14, D-19), with SIMULATED numbers (web :4222 + API :4223, mock WhatsApp):
//   Armand  = a number that never had WhatsApp: standard onboarding, nothing to sync, no app limits shown.
//   Mireille = a number in a WhatsApp Business app: the limits are shown before Connect, the sync card appears, her contacts wait for her confirmation, the history
//              arrives, the app activity shows, the number is disconnected by Meta (banner, nothing is sent), then reconnected in place.
//   Share kit = the join link of a published survey offers "Share on WhatsApp" (WhatsApp's own picker, message filled in) and "Copy the message".
// What this cannot prove: that Meta's real screens, QR code and webhooks behave as documented. That is the second round of docs/META_CHECK.md (real numbers).
// Usage: node scripts/e2e-coexistence.mjs [outDir] [baseUrl]
import { chromium } from 'playwright-core';
import { chromePath } from './lib/browser-path.mjs';
import { confirmAndSignIn } from './lib/signup.mjs';
import { mkdirSync } from 'node:fs';

const exe = await chromePath();
const [out = '/tmp/e2e-coexistence', base = 'http://localhost:4222'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const problems = [];
let page;
let liveSurvey = null;
let n = 0;
const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-GB' });
  page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url().replace(base, '')}`); });
};
const step = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); console.log(`✓ ${String(++n).padStart(2, '0')} ${name} (${Date.now() - t0}ms)`); }
  catch (err) {
    await page.screenshot({ path: `${out}/FAIL-${n + 1}.png`, fullPage: true }).catch(() => {});
    console.log(`✗ ${String(++n).padStart(2, '0')} ${name}\n    ${String(err.message).split('\n').slice(0, 6).join('\n    ')}`);
    await browser.close(); process.exit(1);
  }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const shot = (name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch('/proxy' + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
}, [method, path, body]);

async function register(email, business) {
  await page.goto(`${base}/register`);
  await page.fill('#businessName', business); await page.fill('#name', 'Owner Test'); await page.fill('#phone', `+237 6${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`);
  await page.fill('#email', email); await page.fill('#password', 'a-long-test-password');
  await page.click('button[type=submit]');
  await confirmAndSignIn(page, base, { email });
  await page.getByRole('radio', { name: /Businesses/ }).click();
}

// ---------------------------------------------------------------- Armand
await newPage();
await step('ARMAND: the Connect step asks where the number is, and cannot go on until it is answered', async () => {
  await register(`armand${Date.now()}@example.com`, 'Armand Thesis');
  await page.getByTestId('situation').waitFor({ timeout: 15000 });
  expect(await page.getByTestId('sim-new').isDisabled(), 'the simulated-number buttons wait for the answer');
  expect(await page.getByTestId('sim-app').isDisabled(), 'both of them');
  expect((await page.getByTestId('app-limits').count()) === 0, 'the app limits are not shown yet');
  await shot('01-armand-question');
});

await step('ARMAND: "never on WhatsApp" shows no app limits, and connects as a number used through SurveyFlow only', async () => {
  await page.getByTestId('situation-new').click();
  expect((await page.getByTestId('app-limits').count()) === 0, 'no limits for a new number');
  await page.getByTestId('sim-new').click();
  await page.getByTestId('ob-connected').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: /go to dashboard/i }).click();
  await page.waitForURL('**/dashboard**', { timeout: 15000 });
  await page.goto(`${base}/settings?tab=whatsapp`);
  await page.getByTestId('mode').waitFor({ timeout: 15000 });
  expect(/Used through SurveyFlow only/.test(await page.getByTestId('mode').innerText()), 'mode says SurveyFlow only');
  expect((await page.getByTestId('sync').count()) === 0, 'no sync card for a new number');
  expect((await page.getByTestId('mock-events').count()) === 0, 'no coexistence simulator for a new number');
  expect((await page.getByTestId('register-failed').count()) === 0, 'registered');
  const a = await call('GET', '/whatsapp/accounts');
  expect(a.json.items[0].mode === 'cloud' && a.json.items[0].registered === true && a.json.items[0].signupVersion === 'v5', `account: ${JSON.stringify(a.json.items[0]).slice(0, 300)}`);
  await shot('02-armand-connected');
});

// ---------------------------------------------------------------- Mireille
await newPage();
await step('MIREILLE: choosing "in my WhatsApp Business app" shows what changes in the app, before anything is connected', async () => {
  await register(`mireille${Date.now()}@example.com`, 'Boulangerie Mireille');
  await page.getByTestId('situation').waitFor({ timeout: 15000 });
  await page.getByTestId('situation-business_app').click();
  const limits = page.getByTestId('app-limits');
  await limits.waitFor();
  const text = await limits.innerText();
  expect(/linked to the app/.test(text) && /Broadcast lists/.test(text) && /20 per second/.test(text) && /14 days/.test(text) && /2\.24\.17/.test(text), `five limits: ${text.slice(0, 400)}`);
  await shot('03-mireille-limits');
});

await step('MIREILLE: connects in coexistence: her app is kept, the sync card says so, and she is told to keep the app open', async () => {
  await page.getByTestId('sim-app').click();
  await page.getByTestId('ob-connected').waitFor({ timeout: 20000 });
  await page.getByTestId('sync').waitFor({ timeout: 15000 });
  expect(/Waiting for WhatsApp to send your contacts/.test(await page.getByTestId('sync-text').innerText()), 'pending text');
  expect(/Keep the app open/.test(await page.getByTestId('sync').innerText()), 'keep the app open');
  await page.getByRole('button', { name: /go to dashboard/i }).click();
  await page.waitForURL('**/dashboard**', { timeout: 15000 });
  await page.goto(`${base}/settings?tab=whatsapp`);
  await page.getByTestId('mode').waitFor({ timeout: 15000 });
  expect(/Also in your WhatsApp Business app/.test(await page.getByTestId('mode').innerText()), 'mode says also in the app');
  expect((await page.getByTestId('mismatch').count()) === 0, 'she said app and it is in the app: no warning');
  await shot('04-mireille-connected');
});

await step('MIREILLE: her contacts arrive and wait for her confirmation; the button needs the tick; confirming clears the card', async () => {
  await page.getByTestId('mock-contacts').click();
  await page.getByTestId('app-contacts').waitFor({ timeout: 15000 });
  expect(/4 contacts came from your WhatsApp Business app/.test(await page.getByTestId('app-contacts').innerText()), 'four contacts waiting');
  expect(/Contacts received: 4/.test(await page.getByTestId('sync-text').innerText()), 'sync shows 4 contacts');
  expect(await page.getByTestId('confirm-contacts').isDisabled(), 'confirm needs the tick');
  await page.getByTestId('attest').click();
  expect(!(await page.getByTestId('confirm-contacts').isDisabled()), 'tick enables it');
  await shot('05-mireille-contacts');
  await page.getByTestId('confirm-contacts').click();
  await page.getByTestId('app-contacts').waitFor({ state: 'detached', timeout: 15000 });
  const list = await call('GET', '/contacts?pageSize=50');
  expect(list.status === 200, `contacts: ${list.status}`);
});

await step('MIREILLE: the history arrives (counted, not read) and the app activity shows', async () => {
  await page.getByTestId('mock-history').click();
  await page.waitForFunction(() => /Import finished: 4 contacts/.test(document.querySelector('[data-testid=sync-text]')?.textContent ?? ''), null, { timeout: 15000 });
  await page.getByTestId('mock-echo').click();
  await page.getByText(/App last used/).waitFor({ timeout: 15000 });
  await shot('06-mireille-synced');
});

await step('MIREILLE: Meta disconnects the number (14 days without opening the app): a banner says why in plain words, publishing and sending are refused', async () => {
  const s = await call('POST', '/surveys', { title: 'Avis', language: 'en', questions: [{ text: 'Comment ?', type: 'text', required: true }] });
  expect((await call('POST', `/surveys/${s.json.id}/publish`)).status === 200, 'publish works while connected');
  liveSurvey = s.json.id; // Explore allows one live survey: the share-kit step reuses this one
  await page.getByTestId('mock-disconnect').click();
  const b = page.getByTestId('disconnected-banner');
  await b.waitFor({ timeout: 15000 });
  const t = await b.innerText();
  expect(/not been opened for about 14 days/.test(t) && /paused/i.test(t) && !/PRIMARY_INACTIVITY/.test(t), `banner: ${t.slice(0, 400)}`);
  const send = await call('POST', `/surveys/${s.json.id}/send`, { all: true, acceptMarketingCost: true });
  expect(send.status === 409 && send.json.error === 'whatsapp_not_connected', `send while disconnected: ${send.status} ${JSON.stringify(send.json)}`);
  const s2 = await call('POST', '/surveys', { title: 'Autre', language: 'en', questions: [{ text: 'Comment ?', type: 'text', required: true }] });
  expect((await call('POST', `/surveys/${s2.json.id}/publish`)).status === 409, 'publishing is refused too');
  await shot('07-mireille-disconnected');
});

await step('MIREILLE: she reconnects from the banner: same account, banner gone, sync asked again', async () => {
  const before = (await call('GET', '/whatsapp/accounts')).json.items[0].id;
  const b = page.getByTestId('disconnected-banner');
  await b.getByTestId('situation-business_app').click();
  await b.getByTestId('sim-app').click();
  await b.waitFor({ state: 'detached', timeout: 20000 });
  const a = (await call('GET', '/whatsapp/accounts')).json.items[0];
  expect(a.id === before && a.status === 'active' && a.mode === 'coexistence' && a.sync.state === 'pending', `reconnected in place: ${JSON.stringify(a).slice(0, 300)}`);
  await shot('08-mireille-reconnected');
});

await step('SHARE KIT: the join link offers WhatsApp’s own picker with the message filled in, and a copy button', async () => {
  const on = await call('PUT', `/surveys/${liveSurvey}/join`, { enabled: true });
  expect(on.status === 200, `join on: ${on.status} ${JSON.stringify(on.json).slice(0, 200)}`);
  await page.goto(`${base}/surveys/${liveSurvey}`);
  const wa = page.getByTestId('share-wa');
  await wa.waitFor({ timeout: 20000 });
  const href = await wa.getAttribute('href');
  expect(/^https:\/\/wa\.me\/\?text=/.test(href), `href: ${href}`);
  const msg = decodeURIComponent(href.split('?text=')[1]);
  expect(/Avis/.test(msg) && /Your opinion counts/.test(msg) && /https:\/\/wa\.me\/\d+\?text=JOIN%20[a-z2-7]{26}/.test(msg), `message: ${msg}`);
  expect((await wa.getAttribute('target')) === '_blank' && /noopener/.test(await wa.getAttribute('rel')), 'opens in a new tab without leaking the opener');
  await page.getByTestId('share-copy').waitFor();
  await shot('09-share-kit');
});

await step('no page error and no server error during the whole run', async () => { expect(problems.length === 0, problems.join('\n')); });
await browser.close();
console.log(`\nall ${n} steps passed; screenshots in ${out}`);
