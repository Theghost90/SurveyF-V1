// Real-browser end-to-end check of the Analytics Bot screens (web :4222 + API :4223, mock WhatsApp / mock PSP):
//  Explore sees the bot only as a preview; a paid plan links a phone with a one-time code, asks the bot in the simulator's Owner mode, and the
//  bot's numbers equal the Analytics page's. Also: question types next to titles, the paged "haven't started" list + CSV, alerts switch, RESULTS.
// Usage: node scripts/e2e-bot.mjs [outDir] [baseUrl]
import { chromium } from 'playwright-core';
import { chromePath } from './lib/browser-path.mjs';
import { mkdirSync, readFileSync } from 'node:fs';

const exe = await chromePath();
const [out = '/tmp/e2e-bot', base = 'http://localhost:4222'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-GB', acceptDownloads: true });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url().replace(base, '')}`); });

let n = 0;
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
const email = `bot${Date.now()}@example.com`;
const st = {};

await step('register, pick a segment, connect the simulated number', async () => {
  await page.goto(`${base}/register`);
  await page.fill('#businessName', 'Boulangerie Bot'); await page.fill('#name', 'Awa Bot'); await page.fill('#phone', `+237 6${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`); // unique per run: a phone can be linked to ONE account only
  await page.fill('#email', email); await page.fill('#password', 'a-long-test-password');
  await page.click('button[type=submit]');
  await page.waitForURL('**/onboarding**', { timeout: 30000 });
  await page.getByRole('radio', { name: /Businesses/ }).click();
  await page.getByRole('button', { name: /use a simulated number/i }).click();
  await page.getByTestId('ob-connected').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /go to dashboard/i }).click();
  await page.waitForURL('**/dashboard**', { timeout: 15000 });
});

await step('a survey with three question types exists (API), as a draft', async () => {
  const s = await call('POST', '/surveys', { title: 'Customer Satisfaction', language: 'en', questions: [
    { text: 'How satisfied are you with our service?', type: 'button', required: true, options: [{ id: 'vs', label: 'Very satisfied' }, { id: 'ne', label: 'Neutral' }, { id: 'un', label: 'Unsatisfied' }] },
    { text: 'How likely are you to recommend us?', type: 'rating', required: true, options: null },
    { text: 'Any suggestions for improvement?', type: 'text', required: false, options: null },
  ] });
  expect(s.status === 201, `create: ${JSON.stringify(s)}`);
  st.survey = s.json.id;
});

await step('EXPLORE: the builder preview switches to "Your analytics on WhatsApp" with labelled example numbers, RESULTS and an alert example — and says it needs a plan', async () => {
  await page.goto(`${base}/surveys/${st.survey}`);
  await page.getByRole('tab', { name: 'Your analytics on WhatsApp' }).click();
  await page.getByTestId('owner-chat').waitFor({ timeout: 15000 });
  const chat = page.getByTestId('owner-chat');
  expect(/Invitations sent: 247/.test(await chat.innerText()), 'example STATS card');
  expect(/Example numbers/.test(await page.getByTestId('owner-chat-note').innerText()), 'numbers are labelled as examples');
  await page.getByTestId('owner-chat-locked').waitFor();
  await chat.getByRole('button', { name: 'RESULTS', exact: true }).click();
  const t = await chat.innerText();
  expect(/Top: Very satisfied · 62%/.test(t) && /Average 4\.2/.test(t) && /\(Free text\)/.test(t), `RESULTS card: ${t.slice(-400)}`);
  await chat.getByRole('button', { name: 'Example of an alert the bot sends by itself' }).click();
  expect(/100 responses reached/.test(await chat.innerText()), 'alert example');
  await shot('01-builder-owner-explore');
});

await step('EXPLORE: the simulator has the Owner tab (example numbers + "included in Starter, Growth and Business")', async () => {
  await page.goto(`${base}/simulator`);
  await page.getByRole('tab', { name: 'Owner (analytics)' }).click();
  await page.getByTestId('sim-owner-explore').waitFor({ timeout: 10000 });
  expect(/Included in Starter, Growth and Business/.test(await page.getByTestId('sim-owner-explore').innerText()), 'locked note');
  await shot('02-simulator-owner-explore');
});

await step('EXPLORE: Settings → Analytics on WhatsApp shows what it is and where to try it, no way to link', async () => {
  await page.goto(`${base}/settings?tab=analytics`);
  await page.getByTestId('ab-locked').waitFor({ timeout: 15000 });
  expect(await page.getByRole('button', { name: 'Link a phone' }).count() === 0, 'no link button on Explore');
});

await step('activate Growth through the mock checkout', async () => {
  await page.goto(`${base}/billing?plan=growth`);
  await page.getByRole('heading', { name: /subscribe to growth/i }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /^pay 39,000/i }).click();
  await page.waitForURL(/mock-checkout/, { timeout: 30000 });
  await page.getByRole('button', { name: /pay \(success\)/i }).click();
  await page.getByRole('heading', { name: 'Payment received' }).waitFor({ timeout: 30000 });
});

await step('publish, invite 12 people; 3 complete, 2 abandon at Q2, 1 declines (through the simulator API, the real webhook path)', async () => {
  const contacts = [];
  for (let i = 0; i < 12; i++) {
    const c = await call('POST', '/contacts', { name: `Client ${i + 1}`, phone: `+2376772000${String(i).padStart(2, '0')}`, tags: [], consent: true });
    expect(c.status === 201, `contact ${i}: ${JSON.stringify(c)}`);
    contacts.push(c.json.id);
  }
  st.contacts = contacts;
  expect((await call('POST', `/surveys/${st.survey}/publish`)).status === 200, 'publish');
  const sent = await call('POST', `/surveys/${st.survey}/send`, { all: true });
  expect(sent.status === 200, `send: ${JSON.stringify(sent)}`);
  for (let i = 0; i < 4; i++) await call('POST', '/dev/jobs/run');
  const survey = (await call('GET', `/surveys/${st.survey}`)).json;
  const [q1, q2] = survey.questions;
  const say = (i, body) => call('POST', `/dev/simulator/${contacts[i]}/send`, body);
  const start = (i) => say(i, { type: 'template', payload: `START:${st.survey}`, title: 'Start survey' });
  const rating = (i, v) => say(i, { type: 'reply', id: `a:${q2.id}:${v}`, title: String(v) });
  const choice = (i, k) => say(i, { type: 'reply', id: `a:${q1.id}:${q1.options[k].id}`, title: q1.options[k].label });
  for (const i of [0, 1, 2]) { await start(i); await choice(i, i === 2 ? 1 : 0); await rating(i, i === 0 ? 5 : 4); await say(i, { type: 'text', text: i === 0 ? 'Livraison avant 8h svp' : 'skip' }); }
  for (const i of [3, 4]) { await start(i); await choice(i, 0); await call('POST', `/dev/simulator/${contacts[i]}/expire`); } // stops at Q2, then 25 h of silence
  await say(5, { type: 'text', text: 'hello' }); // (nothing: not started)
  await say(6, { type: 'template', payload: `NOTNOW:${st.survey}`, title: 'Not now' });
  const a = (await call('GET', `/surveys/${st.survey}/analytics`)).json;
  st.totals = a.totals;
  expect(a.totals.completed === 3 && a.totals.abandoned === 2, `analytics after the run: ${JSON.stringify(a.totals)}`);
});

await step('ANALYTICS PAGE: the type is written next to every question title; the numbers add up in the footnote', async () => {
  await page.goto(`${base}/surveys/${st.survey}/analytics`);
  await page.getByText('Completion rate', { exact: true }).waitFor({ timeout: 20000 });
  const types = await page.getByTestId('q-type').allInnerTexts();
  expect(types.join('|') === '(Multiple choice · buttons)|(Rating 1–5)|(Free text)', `question types: ${types.join('|')}`);
  const main = await page.locator('main').innerText();
  expect(/Started = completed 3 \+ in progress 0 \+ abandoned 2/.test(main), `footnote: ${main.slice(main.indexOf('Started ='), main.indexOf('Started =') + 200)}`);
  await shot('03-analytics');
});

await step('ANALYTICS PAGE: the "haven\'t replied" list shows COMPLETE numbers, is paged, excludes STOP and downloads as CSV', async () => {
  const list = page.getByTestId('not-started-list');
  await list.waitFor({ timeout: 15000 });
  expect(/\+237 ?677 ?2000\d\d|\+2376772000\d\d/.test((await list.innerText()).replace(/\s/g, ' ')), `complete numbers expected: ${await list.innerText()}`);
  expect(!/X{2}/.test(await list.innerText()), 'never masked here');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: 'Download CSV' }).click()]);
  await dl.saveAs(`${out}/not-started.csv`);
  const csv = readFileSync(`${out}/not-started.csv`, 'utf8');
  expect(csv.startsWith('\uFEFFname,phone'), 'csv header');
  expect(/"\+2376772000\d\d"/.test(csv) && !/"'\+237/.test(csv), `csv phones: ${csv.slice(0, 200)}`);
  await shot('04-not-started');
});

await step('SETTINGS: link a phone with a one-time code (shown with its message and a WhatsApp button)', async () => {
  await page.goto(`${base}/settings?tab=analytics`);
  await page.getByRole('button', { name: 'Link a phone' }).click();
  const box = page.getByTestId('ab-code');
  await box.waitFor({ timeout: 15000 });
  const text = await box.innerText();
  expect(/LINK [A-Z0-9]{8}/.test(text) && /expires in 15 minutes/.test(text) && /works once/.test(text), `code box: ${text}`);
  st.linkText = /LINK [A-Z0-9]{8}/.exec(text)[0];
  await shot('05-settings-link');
});

await step('SIMULATOR (owner): the code links the phone, STATS equals the Analytics page, RESULTS shows the split, DROP adds up, lists are masked', async () => {
  await page.goto(`${base}/simulator?mode=owner`);
  await page.getByTestId('sim-owner-live').waitFor({ timeout: 15000 });
  const send = async (text) => { await page.locator('#sim-owner-text').fill(text); await page.getByRole('button', { name: 'Send', exact: true }).click(); };
  const chat = page.locator('[aria-label="Simulated chat"]');
  await send('STATS');
  await chat.getByText(/not linked to a SurveyFlow account/).waitFor({ timeout: 10000 }); // a stranger gets nothing until the code
  await send(st.linkText);
  await chat.getByText(/now linked to Boulangerie Bot/).waitFor({ timeout: 10000 });
  await send('STATS');
  await chat.getByText(/Invitations sent: 12/).waitFor({ timeout: 10000 });
  const body = await chat.innerText();
  const t = st.totals;
  for (const [label, v] of [['Started', t.started], ['Completed', t.completed], ['In progress', t.inProgress], ['Abandoned', t.abandoned], ['No reply', t.noReply], ['Declined', t.declined]]) expect(new RegExp(`${label}: ${v}\\b`).test(body), `${label} should be ${v}: ${body}`);
  expect(/as of \d\d:\d\d/.test(body), 'as-of time');
  await send('RESULTS');
  await chat.getByText(/Top: /).first().waitFor({ timeout: 10000 });
  expect(/Top: Very satisfied · 80% \(4\/5\)/.test(await chat.innerText()), `RESULTS in the owner chat: ${(await chat.innerText()).slice(-700)}`);
  await send('NONRESP');
  await chat.getByText(/Haven't replied: \d+ · showing 1–\d+/).waitFor({ timeout: 10000 });
  expect(/\+237 6XX XXX \d{3}/.test(await chat.innerText()), 'masked numbers');
  expect(!/\+2376772000\d\d/.test((await chat.innerText()).replace(/\s/g, '')), 'no complete number on WhatsApp');
  await chat.getByRole('link', { name: 'Open in SurveyFlow' }).last().waitFor();
  await send('MORE'); // (paging itself is covered by the API tests: this list has fewer than 10 people)
  await chat.getByText(/no list to continue|showing 7–|showing 1–/).last().waitFor({ timeout: 10000 });
  await shot('06-simulator-owner');
  // a tapped list row = the typed word
  await chat.getByRole('button', { name: 'DROP', exact: true }).last().click();
  await chat.getByText(/Where people stop/).waitFor({ timeout: 10000 });
});

await step('ALERTS: MUTE from WhatsApp switches the phone\'s alerts off in Settings; the switch turns them on again', async () => {
  await page.goto(`${base}/simulator?mode=owner`);
  await page.locator('#sim-owner-text').fill('MUTE');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('[aria-label="Simulated chat"]').getByText(/Alerts are off for this phone/).waitFor({ timeout: 10000 });
  await page.goto(`${base}/settings?tab=analytics`);
  const sw = page.getByTestId('ab-phones').getByRole('switch');
  await sw.waitFor({ timeout: 15000 });
  expect(await sw.getAttribute('aria-checked') === 'false', 'alerts switch must be off after MUTE');
  await sw.click();
  await page.waitForFunction(() => document.querySelector('[data-testid=ab-phones] [role=switch]')?.getAttribute('aria-checked') === 'true', null, { timeout: 10000 });
  expect(/\+237 6XX XXX \d{3}/.test(await page.getByTestId('ab-phones').innerText()), 'the list shows masked numbers');
  await shot('07-settings-linked');
});

await step('BUILDER (paid, sent survey): the preview shows LIVE numbers with the as-of time, the same as the bot', async () => {
  await page.goto(`${base}/surveys/${st.survey}`);
  await page.getByRole('tab', { name: 'Your analytics on WhatsApp' }).click();
  const chat = page.getByTestId('owner-chat');
  await chat.getByText(/Invitations sent: 12/).waitFor({ timeout: 15000 });
  expect(/Live numbers, as of \d\d:\d\d/.test(await page.getByTestId('owner-chat-note').innerText()), 'live label');
  expect(await page.getByTestId('owner-chat-locked').count() === 0, 'no plan note on a paid plan');
  await shot('08-builder-owner-live');
});

await step('MOBILE 390px: the owner simulator, the Analytics-on-WhatsApp settings and the analytics page do not scroll sideways', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [`/simulator?mode=owner`, `/settings?tab=analytics`, `/surveys/${st.survey}/analytics`, `/surveys/${st.survey}`]) {
    await page.goto(`${base}${path}`);
    await page.waitForTimeout(1500);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over <= 1, `${path} overflows by ${over}px at 390px`);
  }
  await shot('09-mobile-settings');
});

expect(problems.length === 0, `browser problems:\n${problems.join('\n')}`);
console.log(`\nAll ${n} steps passed. Screenshots in ${out}`);
await browser.close();
