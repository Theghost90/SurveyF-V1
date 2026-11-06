// Real-browser end-to-end test of the screens added on 2026-10-31 (web :4222 + API :4223, mock WhatsApp / mock PSP / mock e-mail):
//   WA-03  the marketing-cost warning in the send panel, and the "follows a transaction" switch that makes a survey a utility message
//   DAT-01 Settings, Your data: the whole-account download, scheduling the deletion, the read-only banner, cancelling
//   BIZ-04 Settings, Team: inviting a colleague, accepting in a second browser, working in the workspace as an editor, being removed
// Usage: node scripts/e2e-new.mjs [outDir] [baseUrl]
// Needs a database the script can reach with psql (DATABASE_URL, default the local one) to set what a person cannot set in a screen: the paid plan, and a
// colleague's two-step verification (setting up an authenticator app is covered by e2e-security.mjs).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { chromePath } from './lib/browser-path.mjs';
import { confirmAndSignIn } from './lib/signup.mjs';
import { connectSimulated } from './lib/sim-signup.mjs';

const exe = await chromePath();
const [out = '/tmp/e2e-new', base = 'http://localhost:4222'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const DB = process.env.DATABASE_URL ?? 'postgresql://surveyflow:surveyflow@127.0.0.1:5432/surveyflow';
const sql = (q) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
const PASSWORD = 'a-long-test-password';

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const problems = [];
const watch = (page, label) => {
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
  const benign = (t) => /Failed to fetch RSC payload|CLIENT_FETCH_ERROR|status of 40[1-3]|status of 42[3]|Failed to load resource: the server responded with a status of (401|403|404|423)/.test(t);
  page.on('console', (m) => m.type() === 'error' && !benign(m.text()) && problems.push(`${label} console: ${m.text().slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`${label} HTTP ${r.status()} ${r.url().replace(base, '')}`); });
};
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-GB', acceptDownloads: true });
const page = await ctxA.newPage();
watch(page, 'owner');

let n = 0;
let current = '';
const step = async (name, fn) => {
  current = name;
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
const shot = (p, name) => p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
const toast = (p, text) => p.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 10000 });
const call = (p, method, path, body, headers = {}) => p.evaluate(async ([m, u, b, h]) => {
  const r = await fetch(`/proxy${u}`, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...h }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, json: j };
}, [method, path, body, headers]);
const confirmItsYou = async (p) => {
  const dialog = p.getByRole('dialog').getByRole('heading', { name: /confirm it is you/i });
  if (await dialog.isVisible().catch(() => false)) { await p.fill('#su-secret', PASSWORD); await p.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click(); await dialog.waitFor({ state: 'hidden', timeout: 10000 }); }
};

const ownerEmail = `new${Date.now()}@example.com`;
const colleagueEmail = `colleague${Date.now()}@example.com`;
const survey = { title: 'Order feedback', language: 'en', questions: [{ text: 'How was it?', type: 'button', required: true, options: [{ id: 'g', label: 'Good' }, { id: 'b', label: 'Bad' }] }] };
let s1, s2;

await step('set up: an owner on a paid plan with a simulated number, three contacts and two published surveys', async () => {
  await page.goto(`${base}/register`);
  await page.fill('#businessName', 'Café Nouveau');
  await page.fill('#name', 'Awa Owner');
  await page.fill('#phone', '+237 677 11 22 33');
  await page.fill('#email', ownerEmail);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await confirmAndSignIn(page, base, { email: ownerEmail });
  await page.getByRole('radio', { name: /Businesses/ }).click();
  await page.getByRole('heading', { name: 'Connect WhatsApp' }).waitFor({ timeout: 10000 });
  await page.getByTestId('situation-new').click(); // the question before the Connect button (D-19)
  await connectSimulated(page);
  await page.getByTestId('ob-connected').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /go to dashboard/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  sql(`update "User" set plan = 'growth' where email = '${ownerEmail}'; update "Subscription" set plan = 'growth' where "userId" = (select id from "User" where email = '${ownerEmail}')`);
  for (let i = 0; i < 3; i++) expect((await call(page, 'POST', '/contacts', { name: `Person ${i + 1}`, phone: `+237 677 20 00 0${i}`, consent: true })).status === 201, 'contact created');
  s1 = (await call(page, 'POST', '/surveys', survey)).json.id;
  s2 = (await call(page, 'POST', '/surveys', { ...survey, title: 'Visit feedback' })).json.id;
  for (const id of [s1, s2]) expect((await call(page, 'POST', `/surveys/${id}/publish`)).status === 200, 'published');
});

await step('WA-03: a survey that does not say it follows something the people did is marketing: the warning is on screen and the send button waits for the tick', async () => {
  await page.goto(`${base}/surveys/${s1}`);
  const card = page.getByTestId('message-category');
  await card.waitFor({ timeout: 20000 });
  expect(await card.getAttribute('data-category') === 'marketing', 'the builder says marketing');
  await page.getByTestId('send-cost-warning').waitFor({ timeout: 20000 });
  const send = page.getByRole('button', { name: /send survey via whatsapp/i });
  expect(await send.isDisabled(), 'the send button is disabled until the cost is accepted');
  await shot(page, 'wa03-warning');
  await page.getByTestId('send-cost-accept').click();
  expect(!(await send.isDisabled()), 'the send button is enabled after the tick');
  await send.click();
  await page.getByText('3 invitation(s) queued.').first().waitFor({ timeout: 15000 });
});

await step('WA-03: saying the survey follows something the people did, with nothing promotional in it, makes it a utility message: no warning, and the send goes out', async () => {
  await page.goto(`${base}/surveys/${s2}`);
  const card = page.getByTestId('message-category');
  await card.waitFor({ timeout: 20000 });
  await page.locator('#follows-transaction').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="message-category"]')?.getAttribute('data-category') === 'utility', null, { timeout: 5000 });
  await shot(page, 'wa03-utility');
  await page.getByRole('button', { name: /save draft|save/i }).first().click();
  await toast(page, 'Saved');
  await page.reload();
  await page.getByTestId('message-category').waitFor({ timeout: 20000 });
  expect(await page.getByTestId('message-category').getAttribute('data-category') === 'utility', 'the declaration was saved');
  await page.getByRole('button', { name: /send survey via whatsapp/i }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(800); // the audience answer arrives after the panel
  expect((await page.getByTestId('send-cost-warning').count()) === 0, 'a utility survey shows no cost warning');
  await page.getByRole('button', { name: /send survey via whatsapp/i }).click();
  await page.getByText('3 invitation(s) queued.').first().waitFor({ timeout: 15000 });
  // a gift makes it marketing again, whatever was declared
  const withGift = (await call(page, 'POST', '/surveys', { ...survey, title: 'With a gift', followsTransaction: true, gift: { giftType: 'custom', giftValue: null } })).json.id;
  await call(page, 'POST', `/surveys/${withGift}/publish`);
  await page.goto(`${base}/surveys/${withGift}`);
  await page.getByTestId('message-category').waitFor({ timeout: 20000 });
  expect(await page.getByTestId('message-category').getAttribute('data-category') === 'marketing', 'a reward makes it marketing, even when declared a follow-up');
});

await step('WA-05: on a live survey the owner switches the join link on: a link, a QR code and an end date appear, and the limits can be saved', async () => {
  await page.goto(`${base}/surveys/${s1}`);
  await page.getByTestId('join-on').waitFor({ timeout: 20000 });
  await page.getByTestId('join-on').click();
  await page.getByTestId('join-link').waitFor({ timeout: 15000 });
  const link = await page.getByTestId('join-link').inputValue();
  expect(/^https:\/\/wa\.me\/\d+\?text=JOIN%20[a-z2-7]{26}$/.test(link), `a wa.me link that types the join words: ${link}`);
  expect((await page.getByTestId('join-qr').getAttribute('src'))?.startsWith('data:image/png'), 'a QR code');
  await page.getByTestId('join-max').fill('40');
  await page.getByTestId('join-countries').fill('cm, ci');
  await page.getByTestId('join-save').click();
  await toast(page, 'Saved');
  await page.reload();
  await page.getByTestId('join-max').waitFor({ timeout: 20000 });
  expect((await page.getByTestId('join-max').inputValue()) === '40', 'the maximum was saved');
  expect((await page.getByTestId('join-countries').inputValue()) === 'CM, CI', 'the countries were saved, upper-cased');
  expect((await page.getByTestId('join-gifts').isDisabled()), 'with no gift on the survey, the gifts switch is off and disabled');
  await shot(page, 'wa05-join-card');
  await page.getByTestId('join-rotate').click();
  await page.waitForFunction((old) => document.querySelector('[data-testid=join-link]')?.value !== old, link, { timeout: 10000 });
  await page.getByTestId('join-off').click();
  await page.getByTestId('join-on').waitFor({ timeout: 10000 });
});

await step('PAY-12: after the plan was paid for, the price of the next plan shows the credit for the days left, in the card and in the checkout', async () => {
  sql(`update "Subscription" set "amountFCFA" = 39000, "currentPeriodStart" = now() - interval '9.5 days', "currentPeriodEnd" = now() + interval '20.5 days', status = 'active' where "userId" = (select id from "User" where email = '${ownerEmail}')`);
  await page.goto(`${base}/billing`);
  const credit = page.getByTestId('plan-credit');
  await credit.first().waitFor({ timeout: 20000 });
  expect(/−|-/.test(await credit.first().innerText()), 'a credit line on the bigger plan');
  expect((await credit.count()) === 1, 'only the Business plan is a move up from Growth');
  await shot(page, 'pay12-credit');
  await page.getByRole('button', { name: /^activate$/i }).last().click();
  const note = page.getByTestId('no-proration');
  await note.waitFor({ timeout: 10000 });
  expect(/unused days of your current plan/.test(await note.innerText()), 'the checkout says what is credited');
  await shot(page, 'pay12-checkout');
  await page.keyboard.press('Escape');
});

await step('PAY-09: the owner agrees to be invoiced for responses beyond the plan; an open invoice shows with its Pay button', async () => {
  await page.goto(`${base}/billing`);
  await page.getByTestId('overage-card').waitFor({ timeout: 20000 });
  await page.getByTestId('overage-optin').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=overage-optin]')?.getAttribute('data-state') === 'checked', null, { timeout: 8000 });
  sql(`insert into "OverageInvoice" (id, "userId", period, plan, allowance, responses, units, "amountFCFA", status, "dueAt") select 'inv_e2e', id, '2026-10-01', 'growth', 3000, 3250, 3, 1500, 'open', now() + interval '10 days' from "User" where email = '${ownerEmail}'`);
  await page.reload();
  await page.getByTestId('overage-invoice').waitFor({ timeout: 20000 });
  expect(/250 responses beyond 3000/.test(await page.getByTestId('overage-invoice').innerText()), 'the invoice says how many responses beyond what');
  expect((await page.getByTestId('overage-pay').count()) === 1, 'a Pay button');
  await shot(page, 'pay09-overage');
});

await step('DAT-01: the whole account downloads as one file after "confirm it is you", with no password or secret in it', async () => {
  await page.goto(`${base}/settings?tab=data`);
  await page.getByTestId('dt-export').waitFor({ timeout: 20000 });
  await shot(page, 'dat01-tab');
  const downloading = page.waitForEvent('download', { timeout: 30000 });
  await page.getByTestId('dt-export').click();
  await page.getByRole('dialog').getByRole('heading', { name: /confirm it is you/i }).waitFor({ timeout: 15000 });
  await page.fill('#su-secret', PASSWORD);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  const download = await downloading;
  expect(/^surveyflow-account-\d{4}-\d\d-\d\d\.json$/.test(download.suggestedFilename()), `file name ${download.suggestedFilename()}`);
  const path = `${out}/${download.suggestedFilename()}`;
  await download.saveAs(path);
  expect(statSync(path).size > 500, 'the file arrived');
  const text = readFileSync(path, 'utf8');
  const file = JSON.parse(text);
  expect(file.profile.email === ownerEmail && file.participants.length === 3 && file.surveys.length >= 3, 'the file holds the account, the participants and the surveys');
  expect(!/passwordHash|accessToken|refreshToken|totpSecret|\$argon2/.test(text), 'no password hash, token or secret in the file');
});

await step('DAT-01: scheduling the deletion needs the word DELETE, then the whole account reads only, with a banner and the way back', async () => {
  const del = page.getByTestId('dt-delete');
  expect(await del.isDisabled(), 'the button waits for the word');
  await page.fill('#dt-word', 'delete');
  expect(await del.isDisabled(), 'lower case is not the word');
  await page.fill('#dt-word', 'DELETE');
  await del.click();
  await confirmItsYou(page);
  await page.getByTestId('dt-scheduled').waitFor({ timeout: 15000 });
  await page.getByTestId('deletion-banner').waitFor({ timeout: 15000 });
  await shot(page, 'dat01-scheduled');
  const blocked = await call(page, 'POST', '/contacts', { name: 'Late', phone: '+237 677 30 00 00', consent: true });
  expect(blocked.status === 423 && blocked.json.error === 'account_pending_deletion', `changes are refused while scheduled, got ${blocked.status}`);
  expect((await call(page, 'GET', '/contacts')).status === 200, 'reading still works');
  await page.getByTestId('dt-cancel').click();
  await page.getByTestId('dt-export').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="deletion-banner"]'), null, { timeout: 15000 });
  expect((await call(page, 'POST', '/contacts', { name: 'After', phone: '+237 677 30 00 01', consent: true })).status === 201, 'cancelled: changes work again');
});

await step('BIZ-04: the owner invites a colleague as an editor; the invitation shows as pending', async () => {
  await page.goto(`${base}/settings?tab=team`);
  await page.locator('#tm-email').waitFor({ timeout: 20000 });
  await page.fill('#tm-email', colleagueEmail);
  await page.locator('#tm-role').click();
  await page.getByRole('option', { name: 'Editor' }).click();
  await page.getByTestId('tm-invite').click();
  await confirmItsYou(page);
  await toast(page, 'Invitation sent');
  await page.getByTestId('tm-invites').getByText(colleagueEmail).waitFor({ timeout: 10000 });
  await shot(page, 'biz04-invited');
});

let inviteLink;
await step('BIZ-04: the colleague, in their own browser, creates an account with that address, turns on two-step verification, and accepts', async () => {
  inviteLink = await page.evaluate(async (to) => {
    const items = (await (await fetch(`/proxy/dev/mailbox?to=${encodeURIComponent(to)}`)).json()).items;
    return items.flatMap((i) => i.links ?? []).find((l) => l.includes('/team/accept')) ?? null;
  }, colleagueEmail);
  expect(!!inviteLink, 'the invitation e-mail has a link');
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-GB' });
  global.pageB = await ctxB.newPage();
  const b = global.pageB;
  watch(b, 'colleague');
  await b.goto(`${base}/register`);
  await b.fill('#businessName', 'Colleague Co'); await b.fill('#name', 'Chantal Colleague'); await b.fill('#phone', '+237 677 44 55 66'); await b.fill('#email', colleagueEmail); await b.fill('#password', PASSWORD);
  await b.click('button[type=submit]');
  await confirmAndSignIn(b, base, { email: colleagueEmail });
  await b.getByRole('radio', { name: /Businesses/ }).click();
  await b.getByRole('heading', { name: 'Connect WhatsApp' }).waitFor({ timeout: 10000 });
  // the one thing set outside a screen: an authenticator app's enrolment (covered by e2e-security.mjs)
  sql(`update "User" set "totpEnabledAt" = now() where email = '${colleagueEmail}'`);
  await b.goto(inviteLink.replace(/^https?:\/\/[^/]+/, base));
  await b.getByTestId('tm-accept').waitFor({ timeout: 20000 });
  await shot(b, 'biz04-accept');
  await b.getByTestId('tm-accept').click();
  await b.getByTestId('tm-open').waitFor({ timeout: 15000 });
  await b.getByTestId('tm-open').click();
  await b.waitForURL(/\/dashboard/, { timeout: 15000 });
});

await step('BIZ-04: in the workspace the editor sees the owner\'s surveys and participants (masked), a banner, and no billing; their calls to the owner\'s money are refused', async () => {
  const b = global.pageB;
  await b.getByTestId('member-banner').waitFor({ timeout: 20000 });
  expect(/Café Nouveau/.test(await b.getByTestId('member-banner').innerText()) && /Editor/.test(await b.getByTestId('member-banner').innerText()), 'the banner names the workspace and the role');
  await b.goto(`${base}/contacts`);
  await b.getByText('Person 1').first().waitFor({ timeout: 20000 });
  const body = await b.locator('main').innerText();
  expect(!/677\s?20\s?00\s?0\d/.test(body), 'participants\' numbers are masked for the editor');
  await shot(b, 'biz04-editor-contacts');
  await b.locator('[aria-label="Account"]').click();
  expect((await b.getByRole('menuitem', { name: /billing/i }).count()) === 0, 'no billing in a member\'s account menu');
  await b.keyboard.press('Escape');
  const ws = await b.evaluate(() => localStorage.getItem('sf.workspace'));
  for (const path of ['/wallet', '/payments', '/subscription', '/team']) {
    const r = await call(b, 'GET', path, null, { 'x-workspace': ws });
    expect(r.status === 403 && r.json.error === 'forbidden_role', `${path} is refused to a member (got ${r.status})`);
  }
  expect((await call(b, 'GET', '/surveys', null, { 'x-workspace': ws })).json.items.length >= 3, 'the owner\'s surveys are reachable');
});

await step('BIZ-04: the owner sees what the editor did, and removing them ends their access at their next page', async () => {
  const ws = await page.evaluate(() => null);
  void ws;
  await call(global.pageB, 'POST', '/contacts', { name: 'Added by Chantal', phone: '+237 677 50 00 00', consent: true }, { 'x-workspace': await global.pageB.evaluate(() => localStorage.getItem('sf.workspace')) });
  await page.goto(`${base}/settings?tab=team`);
  await page.getByTestId('tm-members').getByText('Chantal Colleague').waitFor({ timeout: 20000 });
  await page.getByTestId('tm-trail').getByText('Chantal Colleague').first().waitFor({ timeout: 20000 });
  expect(/made a change/.test(await page.getByTestId('tm-trail').innerText()), 'the trail shows the change, with who');
  await shot(page, 'biz04-trail');
  await page.getByTestId('tm-members').getByRole('button', { name: 'Remove' }).click();
  await page.getByTestId('tm-members').waitFor({ state: 'detached', timeout: 10000 });
  const b = global.pageB;
  await b.goto(`${base}/dashboard`);
  // the first call into the workspace is refused (not a member any more): the app forgets the workspace and goes back to the person's own account
  await b.waitForFunction(() => localStorage.getItem('sf.workspace') === null, null, { timeout: 20000 });
  await b.getByRole('link', { name: /dashboard/i }).first().waitFor({ timeout: 20000 });
  await b.waitForFunction(() => !document.querySelector('[data-testid="member-banner"]'), null, { timeout: 20000 });
  expect((await b.getByTestId('member-banner').count()) === 0, 'no workspace banner any more: the colleague is on their own account');
});

console.log(problems.length ? `\nProblems seen while running:\n - ${problems.join('\n - ')}` : '\nNo page error, console error or HTTP 5xx while running.');
await browser.close();
process.exit(problems.length ? 1 : 0);
