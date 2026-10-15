// Real-browser end-to-end test against the running app (web :4222 + API :4223, mock WhatsApp / mock PSP).
// Usage: node scripts/e2e-ui.mjs [outDir] [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync, statSync } from 'node:fs';

const exe = process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const [out = '/tmp/e2e', base = 'http://localhost:4222'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-GB', acceptDownloads: true });
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
    console.log(`✗ ${String(++n).padStart(2, '0')} ${name}\n    ${String(err.message).split('\n').slice(0, 4).join('\n    ')}`);
    await browser.close();
    process.exit(1);
  }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const email = `e2e${Date.now()}@example.com`;
const shot = (name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
const toast = (text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 10000 });

await step('register a new account and land on onboarding', async () => {
  await page.goto(`${base}/register?plan=growth`);
  await page.fill('#businessName', 'Café Test');
  await page.fill('#name', 'Awa Test');
  await page.fill('#phone', '+237 677 11 22 33');
  await page.fill('#email', email);
  await page.fill('#password', 'a-long-test-password');
  await page.click('button[type=submit]');
  await page.waitForURL('**/onboarding**', { timeout: 30000 });
  expect(page.url().includes('plan=growth'), 'chosen plan should travel to onboarding');
  await page.getByRole('heading', { name: /get you set up/i }).waitFor();
});

await step('registration rejects a duplicate email with a field error', async () => {
  const p2 = await ctx.newPage();
  await p2.goto(`${base}/register`);
  await p2.fill('#businessName', 'X'); await p2.fill('#name', 'X'); await p2.fill('#phone', '+237 677 11 22 34'); await p2.fill('#email', email); await p2.fill('#password', 'a-long-test-password');
  await p2.click('button[type=submit]');
  await p2.getByText(/already exists/i).waitFor({ timeout: 10000 });
  await p2.close();
});

await step('onboarding 1/4: connect the simulated WhatsApp number', async () => {
  await page.getByRole('button', { name: /use a simulated number/i }).click();
  await page.getByText('Connected', { exact: true }).waitFor({ timeout: 15000 });
});

await step('onboarding 2/4: add a contact (consent required) and import a CSV', async () => {
  await page.getByRole('button', { name: /^next$/i }).click();
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await page.fill('#c-name', 'Marie N.');
  await page.fill('#c-phone', '+237 677 10 00 01');
  const submit = page.getByRole('dialog').getByRole('button', { name: /^add$/i });
  expect(await submit.isDisabled(), 'Add must stay disabled until the opt-in box is ticked');
  await page.getByLabel(/agreed to receive WhatsApp messages/i).check();
  await submit.click();
  await toast('Added');
  await page.getByRole('button', { name: /import csv/i }).click();
  const csv = 'nom;téléphone;tags\nPaul K.;677 10 00 02;vip\nAïcha M.;677 10 00 03;\nBad Row;12;\n';
  await page.setInputFiles('#c-file', { name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const imp = page.getByRole('dialog').getByRole('button', { name: /^import contacts$/i });
  expect(await imp.isDisabled(), 'Import must stay disabled until consent is ticked');
  await page.getByLabel(/agreed to receive WhatsApp messages/i).check();
  await imp.click();
  await page.getByText(/2 added · 0 updated · 1 skipped/).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /close/i }).first().click();
  await page.getByText('3 contacts').waitFor();
});

await step('onboarding 3/4: create a survey from the "Order & delivery" template', async () => {
  await page.getByRole('button', { name: /^next$/i }).click();
  await page.getByRole('link', { name: /choose a template/i }).click();
  await page.getByRole('button', { name: /order & delivery/i }).click();
  await page.waitForURL(/\/surveys\/[a-z0-9]+$/, { timeout: 30000 });
  await page.getByText('Question 1 of 3').first().waitFor({ timeout: 15000 });
});

await step('builder: validation errors are shown and block saving', async () => {
  await page.getByRole('button', { name: /^add question$/i }).click();
  await page.getByRole('button', { name: /save draft/i }).click();
  await page.getByText('Write the question.').first().waitFor();
  await page.getByText(/thing\(s\) to fix/).first().waitFor();
});

await step('builder: buttons are capped at 3 options, with a hint to use a list', async () => {
  const q4 = page.locator('ol > li').nth(3);
  await q4.locator('textarea').fill('Which day suits you?');
  // default type is "Buttons": 2 options, add a third, then the Add button disables
  const add = q4.getByRole('button', { name: /add option/i });
  await add.click();
  expect(await add.isDisabled(), 'Add option must disable at 3 buttons');
  await q4.getByText(/WhatsApp shows at most 3 buttons/).waitFor();
  const inputs = q4.locator('input[placeholder^="Option"]');
  for (let i = 0; i < 3; i++) await inputs.nth(i).fill(['Mon', 'Tue', 'Wed'][i]);
  await shot('builder-edited');
});

await step('builder: a 21-character button label is flagged', async () => {
  const q4 = page.locator('ol > li').nth(3);
  await q4.locator('input[placeholder^="Option"]').first().fill('x'.repeat(21));
  await page.getByRole('button', { name: /save draft/i }).click();
  await page.getByText(/Maximum 20 characters/).first().waitFor();
  await q4.locator('input[placeholder^="Option"]').first().fill('Mon');
});

await step('builder: reorder with the keyboard (accessible drag and drop)', async () => {
  const firstText = await page.locator('ol > li').nth(0).locator('textarea').inputValue();
  const handle = page.getByRole('button', { name: /drag to reorder question 1/i });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(250); // dnd-kit attaches its key listeners asynchronously after pick-up
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(250);
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  const second = await page.locator('ol > li').nth(1).locator('textarea').inputValue();
  expect(second === firstText, `Q1 should have moved to position 2 (got "${second}" vs "${firstText}")`);
});

await step('builder: save the draft, then switch survey language to French and see the preview change', async () => {
  await page.locator('#title').fill('Avis commandes — test');
  await page.getByRole('button', { name: /save draft/i }).click();
  await toast('Saved');
  await page.getByText('Français').click();
  await page.getByRole('tab', { name: 'Q1' }).click();
  await page.getByText(/Question 1 sur 4/).first().waitFor();
  await page.getByRole('button', { name: /save draft/i }).click();
  await toast('Saved');
});

await step('publish → send panel unlocks and shows the exact audience', async () => {
  await page.getByRole('button', { name: /^publish$/i }).first().click();
  await toast('Survey published');
  await page.getByText(/About 3 message\(s\) will be used/).waitFor({ timeout: 15000 });
});

await step('gift settings: Growth-only gifts are locked on a trial account', async () => {
  const locked = page.getByText('Airtime / data bundle');
  await locked.waitFor();
  await page.getByText(/Gift automation is included from the Growth plan/).waitFor();
});

await step('send the survey to all contacts', async () => {
  await page.getByRole('button', { name: /send survey via whatsapp/i }).click();
  await page.getByText('3 invitation(s) queued.').first().waitFor({ timeout: 15000 });
});

await step('simulator: run the queue, receive the invitation, tap Commencer and answer everything', async () => {
  await page.goto(`${base}/simulator`);
  await page.getByRole('button', { name: /run send queue/i }).click();
  await page.getByRole('button', { name: 'Commencer' }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Commencer' }).click();
  await page.getByText(/Question 1 sur 4/).first().waitFor();
  await shot('simulator-q1');
  // answer every question the way a participant would, following the question TEXT (the order was changed in the builder)
  const chat = page.locator('[aria-label="Simulated chat"]');
  const answered = new Set();
  for (let i = 0; i < 10; i++) {
    if (await page.getByText(/Merci d’avoir répondu/).count()) break;
    const html = await chat.innerText();
    const asks = ['What should we improve first?', 'How was the delivery time?', 'Anything else you would like to tell us?', 'Which day suits you?']
      .map((q) => [q, html.lastIndexOf(q)]).filter(([, at]) => at >= 0).sort((a, b) => b[1] - a[1]);
    const current = asks[0]?.[0];
    if (current && !answered.has(current)) {
      answered.add(current);
      if (current.startsWith('What should')) { await chat.getByRole('button', { name: 'Voir les options' }).last().click(); await chat.getByRole('button', { name: /Delivery time/ }).last().click(); }
      else if (current.startsWith('How was')) await chat.getByRole('button', { name: 'Fast' }).last().click();
      else if (current.startsWith('Anything else')) { await page.locator('#sim-text').fill('Livraison avant 8h svp'); await page.getByRole('button', { name: 'Send', exact: true }).click(); }
      else if (current.startsWith('Which day')) await chat.getByRole('button', { name: 'Mon' }).last().click();
    }
    await page.waitForTimeout(700);
  }
  await page.getByText(/Merci d’avoir répondu/).waitFor({ timeout: 15000 });
  await page.getByText('completed', { exact: true }).waitFor({ timeout: 10000 });
  await shot('simulator-done');
});

await step('simulator: 24 h of silence marks another participant as abandoned at the right question', async () => {
  const sel = page.locator('#sim-contact');
  await sel.click();
  await page.getByRole('option').nth(1).click();
  await page.getByRole('button', { name: /run send queue/i }).click();
  await page.getByRole('button', { name: 'Commencer' }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Commencer' }).click();
  await page.getByText(/Question 1 sur 4/).first().waitFor();
  const chat2 = page.locator('[aria-label="Simulated chat"]');
  await chat2.getByRole('button', { name: 'Voir les options' }).last().click();
  await chat2.getByRole('button', { name: /Delivery time/ }).last().click();
  await page.getByText(/Question 2 sur 4/).first().waitFor();
  await page.getByRole('button', { name: /skip 25 h of silence/i }).click();
  await page.getByText('abandoned', { exact: true }).waitFor({ timeout: 10000 });
});

await step('analytics: funnel, completion rate and the drop-off alert reflect what happened', async () => {
  await page.goto(`${base}/dashboard`);
  await page.getByRole('link', { name: /Avis commandes/ }).click();
  await page.waitForURL(/analytics$/, { timeout: 30000 });
  await page.getByText('Completion rate', { exact: true }).waitFor({ timeout: 15000 });
  const text = await page.locator('main').innerText();
  expect(/3\s+Sent/.test(text), 'Sent should be 3');
  expect(/Drop-off alert: 1 participant\(s\) left at Q2/.test(text), 'drop-off alert at Q2 expected');
  expect(/50%\s+Completion rate|50\.0?%\s+Completion/.test(text.replace(/\n/g, ' ')) || /50%/.test(text), 'completion rate should be 1/2 = 50%');
  await shot('analytics');
});

await step('exports: PDF and Excel download with sensible files', async () => {
  await page.getByRole('link', { name: /export & sync/i }).click();
  await page.getByRole('button', { name: /download pdf report/i }).waitFor();
  const [pdf] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByRole('button', { name: /download pdf report/i }).click()]);
  const pdfPath = `${out}/report.pdf`;
  await pdf.saveAs(pdfPath);
  expect(pdf.suggestedFilename().endsWith('.pdf'), 'pdf filename');
  expect(statSync(pdfPath).size > 15000, 'pdf should not be empty');
  const [xlsx] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByRole('button', { name: /download excel/i }).click()]);
  await xlsx.saveAs(`${out}/results.xlsx`);
  expect(xlsx.suggestedFilename().endsWith('.xlsx'), 'xlsx filename');
  expect(statSync(`${out}/results.xlsx`).size > 3000, 'xlsx should not be empty');
  await page.getByText(/Google Sheets sync is included from the Growth plan/).waitFor(); // trial: locked
});

await step('billing: subscribe to Growth through the mock checkout; plan, limits and invoice update', async () => {
  await page.goto(`${base}/billing?plan=growth`);
  await page.getByRole('heading', { name: /subscribe to growth/i }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /^pay 39,000/i }).click();
  await page.waitForURL(/mock-checkout/, { timeout: 30000 });
  await page.getByRole('button', { name: /pay \(success\)/i }).click();
  await page.getByRole('heading', { name: 'Payment received' }).waitFor({ timeout: 30000 });
  await page.goto(`${base}/billing`);
  await page.getByText('Growth', { exact: true }).first().waitFor();
  await page.getByText(/Renews on/).waitFor();
  await page.getByText('39,000 FCFA').last().waitFor();
  await shot('billing-after');
});

await step('Growth unlocks gifts in the builder', async () => {
  await page.goto(`${base}/surveys`);
  await page.goto(`${base}/surveys/new`);
  await page.getByRole('button', { name: /start from scratch/i }).click();
  await page.waitForURL(/\/surveys\/[a-z0-9]+$/);
  await page.getByText('Airtime / data bundle').click();
  await page.getByLabel(/amount per participant/i).fill('500');
  await page.getByLabel(/what participants are told/i).fill('500 FCFA airtime');
  await page.getByRole('tab', { name: 'Thank-you' }).click();
});

await step('language toggle: the dashboard switches to French and back', async () => {
  await page.goto(`${base}/dashboard`);
  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await page.getByRole('heading', { name: /Bonjour, Awa/ }).waitFor({ timeout: 15000 });
  await page.getByText('Sondages', { exact: true }).first().waitFor();
  await shot('dashboard-fr');
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await page.getByRole('heading', { name: /Hello, Awa/ }).waitFor({ timeout: 15000 });
});

await step('sign out, then protected pages redirect to login', async () => {
  await page.getByRole('button', { name: /account/i }).click();
  await page.getByRole('menuitem', { name: /sign out/i }).click();
  await page.waitForURL(`${base}/`, { timeout: 30000 });
  await page.goto(`${base}/dashboard`);
  await page.waitForURL(/\/login/, { timeout: 15000 });
});

// ---------- phone-width layout: no horizontal scroll, nothing cut off ----------
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, locale: 'en-GB' });
const m = await phone.newPage();
await step('mobile 390px: marketing pages have no horizontal overflow', async () => {
  for (const [name, path] of [['home', '/'], ['pricing', '/pricing'], ['login', '/login'], ['register', '/register']]) {
    await m.goto(base + path, { waitUntil: 'networkidle' });
    const over = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await m.screenshot({ path: `${out}/mobile-${name}.png`, fullPage: true });
    expect(over <= 1, `${path} overflows horizontally by ${over}px at 390px`);
  }
});
await step('mobile 390px: logged-in screens have no horizontal overflow', async () => {
  await m.goto(`${base}/login`);
  await m.fill('#email', 'demo@surveyflow.test');
  await m.fill('#password', 'demo-password-123');
  await Promise.all([m.waitForURL('**/dashboard'), m.click('button[type=submit]')]);
  await m.waitForLoadState('networkidle');
  const id = await m.evaluate(async () => (await (await fetch('/proxy/surveys')).json()).items.find((s) => s.status === 'active')?.id);
  for (const [name, path] of [['dashboard', '/dashboard'], ['surveys', '/surveys'], ['builder', `/surveys/${id}`], ['analytics', `/surveys/${id}/analytics`], ['contacts', '/contacts'], ['billing', '/billing']]) {
    await m.goto(base + path, { waitUntil: 'networkidle' });
    await m.waitForTimeout(700);
    const over = await m.evaluate(() => {
      // tables scroll inside their own box on purpose; only the PAGE must not scroll sideways
      return document.documentElement.scrollWidth - window.innerWidth;
    });
    await m.screenshot({ path: `${out}/mobile-${name}.png`, fullPage: true });
    expect(over <= 1, `${path} overflows horizontally by ${over}px at 390px`);
  }
});

await browser.close();
const unique = [...new Set(problems)];
console.log(unique.length ? `\nBrowser problems seen (${unique.length}):\n  ` + unique.join('\n  ') : '\nNo console errors or 5xx responses in the whole run.');
console.log(`\nAll ${n} steps passed.`);
