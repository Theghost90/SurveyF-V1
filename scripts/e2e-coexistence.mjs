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
import { connectSimulated } from './lib/sim-signup.mjs';
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1300 }, locale: 'en-GB' });
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
const shotDialog = (name) => page.getByTestId('sim-dialog').screenshot({ path: `${out}/${name}.png` });
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
const stamp = String(Date.now()).slice(-6);
const itemState = async (k) => page.getByTestId(`sim-item-${k}`).getAttribute('data-state');
const itemCount = async () => page.locator('[data-testid^="sim-item-"]').count();
const openTester = async () => { await page.getByTestId('sim-tester').locator('summary').click(); }; // the technical list is for testers: closed unless asked
const traceKeys = async () => page.locator('[data-testid^="sim-trace-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('sim-trace-', '')));
await newPage();
await step('ARMAND: the Connect step asks where the number is, and the simulation cannot start until it is answered', async () => {
  await register(`armand${Date.now()}@example.com`, 'Armand Thesis');
  await page.getByTestId('situation').waitFor({ timeout: 15000 });
  expect(await page.getByTestId('sim-open').isDisabled(), 'the simulated Facebook button waits for the answer');
  expect((await page.getByTestId('app-limits').count()) === 0, 'the app limits are not shown yet');
  await shot('01-armand-question');
});

await step('ARMAND: Meta’s popup, screen by screen: login, access, a number in the ordinary WhatsApp app is refused, a new number gets an SMS code', async () => {
  await page.getByTestId('situation-new').click();
  expect((await page.getByTestId('app-limits').count()) === 0, 'no limits for a new number');
  await page.getByTestId('sim-open').click();
  expect(/SIMULATION/.test(await page.getByTestId('sim-banner').innerText()), 'the window says it is a simulation');
  const first = await page.getByTestId('sim-side').innerText();
  expect(/never sees your password/.test(first) && /Now/.test(first), `first step explained while it is the one to do: ${first.slice(0, 300)}`);
  expect(!/is_on_biz_app|WA_EMBEDDED|webhook|token|FINISH/.test(first), 'no technical text on the customer side');
  await shotDialog('02-popup-login');
  await page.getByTestId('sim-login-btn').click();
  await shotDialog('03-popup-access');
  await page.getByTestId('sim-auth-btn').click();
  await page.getByTestId('sim-phone').fill(`+237 699 ${stamp}3`); // ends in 3: in the ordinary WhatsApp app
  await shotDialog('04-popup-phone');
  await page.getByTestId('sim-phone-next').click();
  await page.getByTestId('sim-refused').waitFor();
  await shotDialog('05-popup-refused');
  await page.getByTestId('sim-refused-btn').click();
  expect((await itemState('phone')) !== 'done', 'the refused number is not ticked as given');
  await page.getByTestId('sim-phone').fill(`+237 699 ${stamp}1`); // ends in 1: new
  await page.getByTestId('sim-phone-next').click();
  await page.getByTestId('sim-sms').waitFor();
  expect(/482913/.test(await page.getByTestId('sim-sms').innerText()), 'the simulated SMS shows the code');
  await shotDialog('06-popup-sms');
  await page.getByTestId('sim-code').fill('000000');
  await page.getByTestId('sim-verify-btn').click();
  await page.getByText(/not right/).waitFor();
  await page.getByTestId('sim-code').fill('482913');
  await page.getByTestId('sim-verify-btn').click();
  await shotDialog('07-popup-business');
  await page.getByTestId('sim-biz-next').click();
  await shotDialog('08-popup-permissions');
  await page.getByTestId('sim-perm-btn').click();
  await shotDialog('09-popup-ready');
  expect((await itemCount()) === 8, 'eight steps for a new number');
  const states = [];
  for (const k of ['login', 'auth', 'phone', 'verify', 'biz', 'perm', 'pay', 'ready']) states.push(await itemState(k));
  expect(states.join(',') === 'done,done,done,done,done,done,current,todo', `ticks: ${states.join(',')}`);
  const side = await page.getByTestId('sim-side').innerText();
  expect(/Add a payment method \(required\)/.test(side) && /Visa and Mastercard cards linked to your Mobile Money/.test(side) && /SurveyFlow never sees your card/.test(side), `customer text: ${side.slice(0, 600)}`);
  expect(!/is_on_biz_app|WA_EMBEDDED|PIN|webhook|token|FINISH/.test(side), `no technical text on the customer side: ${side}`);
});

await step('ARMAND: Finish: what the popup tells SurveyFlow, then SurveyFlow’s own steps (registered with a PIN, no sync), then Meta’s payment method', async () => {
  await page.getByTestId('sim-done-btn').click();
  await page.getByTestId('sim-connecting').waitFor({ timeout: 20000 });
  await page.getByTestId('sim-work-continue').waitFor({ timeout: 30000 });
  await openTester();
  const ev = await page.getByTestId('sim-event').innerText();
  expect(/"event": "FINISH"/.test(ev) && /"is_on_biz_app": false/.test(ev) && /messaging_account_ids/.test(ev), `popup event: ${ev.slice(0, 300)}`);
  const keys = await traceKeys();
  expect(keys.join(',') === 'token,details,mode,subscribe,register,drafts,templates,done', `trace: ${keys.join(',')}`);
  const side = await page.getByTestId('sim-tester').innerText();
  expect(/no\. Standard onboarding/.test(side) && /random PIN/.test(side) && /\+237699\d+1 \(simulated\)/.test(side) && !/sync|chat history/i.test(side.replace(/is_on_biz_app/g, '')), `trace text: ${side.slice(0, 500)}`);
  await shotDialog('10-armand-behind-the-scenes');
  await page.getByTestId('sim-work-continue').click();
  expect((await itemState('pay')) === 'current', 'the payment method is now the step to do');
  await shotDialog('11-popup-billing');
  await page.getByTestId('sim-bill-later').click();
  expect(/Still required/.test(await page.getByTestId('sim-bill-warn').innerText()) && /1,000 conversations/.test(await page.getByTestId('sim-bill-warn').innerText()), 'the consequence of no payment method is said');
  expect((await itemState('pay')) === 'attention' && (await itemState('ready')) === 'done', 'the payment step stays flagged as required while the number is connected');
  const notices = await page.getByTestId('sim-notices').innerText();
  expect(/few minutes, sometimes up to a day/.test(notices) && /payment method is still missing/.test(notices) && !/Keep the app open/.test(notices), `waiting notices: ${notices}`);
  await shotDialog('11b-popup-connected-without-card');
  await page.getByTestId('sim-bill-close').click();
  await page.getByTestId('ob-connected').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: /go to dashboard/i }).click();
  await page.waitForURL('**/dashboard**', { timeout: 15000 });
  await page.goto(`${base}/settings?tab=whatsapp`);
  await page.getByTestId('mode').waitFor({ timeout: 15000 });
  expect(/Used through SurveyFlow only/.test(await page.getByTestId('mode').innerText()), 'mode says SurveyFlow only');
  expect((await page.getByTestId('sync').count()) === 0 && (await page.getByTestId('mock-events').count()) === 0 && (await page.getByTestId('register-failed').count()) === 0, 'no sync card, no coexistence panel, registered');
  const a = await call('GET', '/whatsapp/accounts');
  expect(a.json.items[0].mode === 'cloud' && a.json.items[0].registered === true && a.json.items[0].signupVersion === 'v5' && /^\+237699\d+1 \(simulated\)$/.test(a.json.items[0].displayPhone), `account: ${JSON.stringify(a.json.items[0]).slice(0, 300)}`);
  await shot('12-armand-connected');
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
  await shot('13a-mireille-limits');
});

await step('MIREILLE: Meta’s popup for a number in the WhatsApp Business app: profile, business, QR scan, time zone; then SurveyFlow’s steps (no registration, sync asked)', async () => {
  await page.getByTestId('sim-open').click();
  await page.getByTestId('sim-login-btn').click();
  await page.getByTestId('sim-auth-btn').click();
  await page.getByTestId('sim-phone').fill(`+237 699 ${stamp}2`); // ends in 2: in a WhatsApp Business app
  await page.getByTestId('sim-phone-next').click();
  await page.getByTestId('sim-profile-btn').waitFor();
  await shotDialog('13-popup-business-app-profile');
  await page.getByTestId('sim-profile-btn').click();
  await page.getByTestId('sim-biz-next').click();
  await page.getByTestId('sim-qr-btn').waitFor();
  await shotDialog('14-popup-qr');
  await page.getByTestId('sim-qr-btn').click();
  expect((await page.getByTestId('sim-tz-next').isDisabled()), 'the terms must be ticked');
  await page.getByTestId('sim-tz-terms').click();
  await shotDialog('15-popup-time-zone-terms');
  await page.getByTestId('sim-tz-next').click();
  expect((await itemCount()) === 5, 'five steps for a number in the WhatsApp Business app');
  const mst = []; for (const k of ['access', 'number', 'scan', 'pay', 'ready']) mst.push(await itemState(k));
  expect(mst.join(',') === 'done,done,done,current,todo', `ticks: ${mst.join(',')}`);
  expect(!/code by SMS/.test(await page.getByTestId('sim-side').innerText()), 'no SMS step for a number in the app');
  await page.getByTestId('sim-done-btn').click();
  await page.getByTestId('sim-work-continue').waitFor({ timeout: 30000 });
  await openTester();
  const ev = await page.getByTestId('sim-event').innerText();
  expect(/FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING/.test(ev) && /"is_on_biz_app": true/.test(ev), `popup event: ${ev.slice(0, 300)}`);
  const keys = await traceKeys();
  expect(keys.join(',') === 'token,details,mode,subscribe,register_skipped,sync,drafts,templates,done', `trace: ${keys.join(',')}`);
  const side = await page.getByTestId('sim-tester').innerText();
  expect(/yes\. Coexistence/.test(side) && /Does not register the number/.test(side) && /contacts and chat history/.test(side), `trace text: ${side.slice(0, 600)}`);
  await shotDialog('16-mireille-behind-the-scenes');
  await page.getByTestId('sim-work-continue').click();
  await page.getByTestId('sim-bill-add').click();
  expect(/Messages can go out/.test(await page.getByTestId('sim-bill-added').innerText()), 'payment added');
  const all = []; for (const k of ['access', 'number', 'scan', 'pay', 'ready']) all.push(await itemState(k));
  expect(all.every((x) => x === 'done'), `everything ticked: ${all.join(',')}`);
  const mnotes = await page.getByTestId('sim-notices').innerText();
  expect(/Keep the app open/.test(mnotes) && /few minutes, sometimes up to a day/.test(mnotes) && !/payment method is still missing/.test(mnotes), `notices: ${mnotes}`);
  await shotDialog('16b-mireille-all-done');
  await page.getByTestId('sim-bill-close').click();
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
  await shot('17-mireille-connected');
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
  await connectSimulated(page, { app: true });
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
