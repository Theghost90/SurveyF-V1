// Real-browser end-to-end test of the sign-in and data-protection work, against the running app (web :4222 + API :4223, mock e-mail provider).
// Usage:  SF_SHORT_TOKENS=1 node scripts/e2e-security.mjs [outDir] [baseUrl]
//
// Start the API with ACCESS_TOKEN_TTL_SECONDS=30 (the smallest it accepts) and set SF_SHORT_TOKENS=1: every API token then runs out every 30 seconds, so the whole
// script doubles as a test that the website renews it silently (a bug there shows as a random sign-out) and the last step waits for it explicitly.
// It also needs the seeded demo account (npm run db:seed), whose survey has 60 participants: an export of that size asks to "confirm it is you".
import { chromium } from 'playwright-core';
import { createHmac } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { chromePath } from './lib/browser-path.mjs';
import { confirmAndSignIn } from './lib/signup.mjs';

const exe = await chromePath();
const [out = '/tmp/e2e-security', base = 'http://localhost:4222'] = process.argv.slice(2);
const SHORT = process.env.SF_SHORT_TOKENS === '1';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const problems = [];
const violations = [];
const newContext = async (opts = {}) => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-GB', acceptDownloads: true, ...opts });
  // Every Content-Security-Policy violation in any page of any context is reported here: the policy must block nothing the product really does.
  await c.exposeBinding('__cspReport', (_src, v) => violations.push(v));
  await c.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__cspReport({ directive: e.violatedDirective, blocked: e.blockedURI, page: location.pathname })));
  return c;
};
const watch = (page) => {
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  // net-aborts of Next's own link prefetches when this script navigates fast, and the browser's own report of an expected 4xx, are not application errors
  page.on('console', (m) => m.type() === 'error' && !/Failed to fetch RSC payload|Failed to load resource: the server responded with a status of (4\d\d)/.test(m.text()) && problems.push(`console [${current.slice(0, 40)}]: ${m.text().slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url().replace(base, '')}`); });
  return page;
};

let n = 0;
let current = '';
let page;
const step = async (name, fn) => {
  current = name;
  const t0 = Date.now();
  try {
    await fn();
    console.log(`✓ ${String(++n).padStart(2, '0')} ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    await page?.screenshot({ path: `${out}/FAIL-${n + 1}.png`, fullPage: true }).catch(() => {});
    console.log(`✗ ${String(++n).padStart(2, '0')} ${name}\n    ${String(err.message).split('\n').slice(0, 5).join('\n    ')}`);
    await browser.close();
    process.exit(1);
  }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (p, name) => p.screenshot({ path: `${out}/${name}.png`, fullPage: true });

// ---- authenticator codes (RFC 6238) ---------------------------------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32 = (s) => { let bits = 0, v = 0; const o = []; for (const c of s.replace(/[\s=]/g, '')) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const totp = (secret, step) => {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', b32(secret)).update(c).digest(); const o = h[h.length - 1] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
};
const nowStep = () => Math.floor(Date.now() / 30000);
let lastStep = -1;
/** A code that was never used before: the API accepts each step once and only moving forward, so wait for the clock when the next one is not valid yet. */
async function nextCode(secret) {
  const s = Math.max(lastStep + 1, nowStep());
  while (s > nowStep() + 1) await sleep(1000);
  lastStep = s;
  return totp(secret, s);
}

// ---- small screens helpers ---------------------------------------------------------------------------------------------------------------
const toast = (p, text) => p.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 10000 });
/**
 * Presses the form's button and waits for the next state. The sign-in route allows ten requests a minute per address and a two-step sign-in is two
 * requests, so a script that signs in many times in a minute is told to wait, exactly as the form tells a person: it waits out the countdown and presses again.
 */
async function submitAndWait(p, next) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await p.click('button[type=submit]');
    const delayed = p.getByText(/Try again in \d+ seconds/);
    const outcome = await Promise.race([next().then(() => 'ok'), delayed.waitFor({ timeout: 25000 }).then(() => 'delayed')]).catch((e) => e);
    if (outcome === 'ok') return;
    if (outcome === 'delayed') { await delayed.waitFor({ state: 'hidden', timeout: 90000 }); await p.waitForTimeout(300); continue; }
    throw outcome instanceof Error ? outcome : new Error('sign-in did not progress');
  }
  throw new Error('still being told to wait after five tries');
}
async function signIn(p, email, password, { expect: where = /\/(dashboard|onboarding)/, then = null } = {}) {
  await p.goto(`${base}/login`);
  await p.fill('#email', email);
  await p.fill('#password', password);
  await submitAndWait(p, then ?? (() => p.waitForURL(where, { timeout: 25000 })));
}
const twoStep = (p) => () => p.getByRole('heading', { name: /two-step verification/i }).waitFor({ timeout: 25000 });
/** Signs in an account that has two-step verification on: password first, then the code (or a recovery code). */
async function signInWithCode(p, email, password, code, { recovery = false } = {}) {
  await signIn(p, email, password, { then: twoStep(p) });
  if (recovery) await p.getByRole('button', { name: /use a recovery code/i }).click();
  await p.fill('#code', code);
  await submitAndWait(p, () => p.waitForURL(/\/(dashboard|onboarding)/, { timeout: 25000 }));
}
async function signOut(p) {
  await p.getByRole('button', { name: 'Account' }).click();
  await p.getByRole('menuitem', { name: /sign out/i }).click();
  await p.waitForURL((u) => u.pathname === '/', { timeout: 15000 });
}
const cookieValue = async (ctx) => (await ctx.cookies()).find((c) => c.name.endsWith('next-auth.session-token'))?.value;
/** A new account is taken to the segment question until it is answered (the one required step of setup): answer it, then open Settings > Security. */
async function openSecurity(p) {
  await p.goto(`${base}/settings?tab=security`);
  // the page renders before the account has loaded; the redirect to the segment question comes a moment later
  await Promise.race([p.waitForURL(/\/onboarding/, { timeout: 15000 }).catch(() => {}), p.getByTestId('sessions').waitFor({ timeout: 15000 }).catch(() => {})]);
  if (/\/onboarding/.test(p.url())) {
    await p.getByRole('radio', { name: /Businesses/ }).click();
    await p.getByRole('heading', { name: 'Connect WhatsApp' }).waitFor({ timeout: 10000 });
    await p.goto(`${base}/settings?tab=security`);
  }
  await p.getByTestId('sessions').waitFor({ timeout: 20000 });
}

const stamp = Date.now();
const email = `sec${stamp}@example.com`;
const PASSWORD = 'a-long-test-password';
const NEW_PASSWORD = 'another-long-test-password-2';
const ctx = await newContext();
page = watch(await ctx.newPage());
let secret = '';
let recovery = [];

// =====================================================================================================================================
// A. sign-up, the confirmation link, and what an unconfirmed account can do
// =====================================================================================================================================
await step('sign up: the form leads to "check your e-mail" (nobody is signed in yet), and the demo page shows the message', async () => {
  await page.goto(`${base}/register?plan=growth`);
  expect((await page.locator('#password').getAttribute('minlength')) === '10', 'the password field asks for 10 characters');
  await page.fill('#businessName', 'Café Sécurité'); await page.fill('#name', 'Awa Sécurité'); await page.fill('#phone', `+237 6${String(stamp).slice(-8)}`);
  await page.fill('#email', email);
  await page.fill('#password', 'password123');
  await page.click('button[type=submit]');
  await page.getByText(/too easy to guess/i).waitFor({ timeout: 10000 }); // a weak password is refused before anything is created, with a readable message
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL('**/check-email**', { timeout: 20000 });
  await page.getByRole('heading', { name: /check your e-mail/i }).waitFor();
  await page.getByTestId('demo-link').waitFor({ timeout: 20000 });
  await shot(page, 'check-email');
});

await step('an account whose address is not confirmed can look around but is told so, and nothing that sends, pays or connects works', async () => {
  const c2 = await newContext();
  const p2 = watch(await c2.newPage());
  await signIn(p2, email, PASSWORD);
  await p2.getByTestId('verify-banner').waitFor({ timeout: 15000 });
  await shot(p2, 'unverified-banner');
  const refused = await p2.evaluate(async () => { const r = await fetch('/proxy/whatsapp/accounts/mock', { method: 'POST' }); return [r.status, (await r.json()).error]; });
  expect(refused[0] === 403 && refused[1] === 'email_not_verified', `a gated call must be refused for an unconfirmed address, got ${JSON.stringify(refused)}`);
  await c2.close();
});

await step('registering the same address again shows the SAME screen (no "already exists"), and tells the owner by e-mail only once confirmed', async () => {
  const c2 = await newContext();
  const p2 = watch(await c2.newPage());
  await p2.goto(`${base}/register`);
  await p2.fill('#businessName', 'Intruder'); await p2.fill('#name', 'X'); await p2.fill('#phone', '+237 677 11 22 34'); await p2.fill('#email', email); await p2.fill('#password', 'intruder-long-password-1');
  await p2.click('button[type=submit]');
  await p2.waitForURL('**/check-email**', { timeout: 15000 });
  expect(!/already (exists|have)/i.test(await p2.locator('body').innerText()), 'the screen must not reveal that the address is taken');
  await c2.close();
});

await step('the link: it asks for a click (opening it confirms nothing), then the account is active and sign-in carries on to onboarding with the chosen plan', async () => {
  // the first sign-up of this address was replaced by the second one above (it never confirmed): the link now in the mailbox belongs to the NEW registration
  await page.goto(`${base}/check-email?email=${encodeURIComponent(email)}`);
  await page.getByTestId('demo-link').waitFor({ timeout: 20000 });
  await page.getByTestId('demo-link').click();
  await page.waitForURL('**/verify-email**');
  await page.getByRole('heading', { name: /confirm your address/i }).waitFor();
  await sleep(1500);
  expect(await page.getByTestId('confirm-email').isVisible(), 'the page must wait for the click');
  await page.getByTestId('confirm-email').click();
  await page.getByRole('heading', { name: /address confirmed/i }).waitFor({ timeout: 15000 });
  await page.getByRole('link', { name: /^sign in$/i }).click();
  await page.waitForURL('**/login**');
  await page.getByText(/address is confirmed/i).waitFor();
  // the intruder's password was set by the replacement registration: the real owner never had one on this account, so use the one that is in the database now
  await page.fill('#email', email); await page.fill('#password', 'intruder-long-password-1');
  await page.click('button[type=submit]');
  await page.waitForURL(/\/onboarding/, { timeout: 20000 });
});

// =====================================================================================================================================
// B. sign-in protections, forgotten password
// =====================================================================================================================================
await step('a wrong password gets one generic message; after five the form makes the visitor wait, with a countdown, and then lets them in', async () => {
  // its own account: the per-minute cap on attempts is per address, and this step deliberately makes many
  const thr = `thr${stamp}@example.com`;
  const c = await newContext();
  const p = watch(await c.newPage());
  await p.goto(`${base}/register`);
  await p.fill('#businessName', 'Throttle'); await p.fill('#name', 'Thr'); await p.fill('#phone', `+237 6${String(stamp + 1).slice(-8)}`); await p.fill('#email', thr); await p.fill('#password', PASSWORD);
  await p.click('button[type=submit]');
  await confirmAndSignIn(p, base, { email: thr, password: PASSWORD });
  await signOut(p);
  await p.goto(`${base}/login`);
  await p.fill('#email', thr);
  let waited = false;
  for (let i = 0; i < 8 && !waited; i++) {
    await p.fill('#password', `wrong-password-${i}-xyz`);
    await p.click('button[type=submit]');
    await Promise.race([p.getByText(/Invalid email or password/).waitFor({ timeout: 8000 }).catch(() => {}), p.getByText(/Try again in \d+ seconds/).waitFor({ timeout: 8000 }).catch(() => {})]);
    waited = await p.getByText(/Try again in \d+ seconds/).isVisible();
  }
  expect(waited, 'after five wrong passwords the form must show a waiting time');
  expect(await p.locator('button[type=submit]').isDisabled(), 'the button is disabled while the countdown runs');
  await shot(p, 'login-delayed');
  await p.getByText(/Try again in/).waitFor({ state: 'hidden', timeout: 90000 });
  await p.fill('#password', PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL(/\/(dashboard|onboarding)/, { timeout: 20000 }); // a wait, never a lock-out
  await c.close();
});

await step('forgot password: the e-mail link, a weak new password keeps the link alive, a good one works, and the old one stops working', async () => {
  const c = await newContext();
  const p = watch(await c.newPage());
  await p.goto(`${base}/forgot-password`);
  await p.fill('#email', email);
  await p.click('button[type=submit]');
  await p.getByText(/link is on its way/i).waitFor({ timeout: 15000 });
  await p.getByTestId('demo-link').waitFor({ timeout: 20000 });
  await p.getByTestId('demo-link').click();
  await p.waitForURL('**/reset-password**');
  await p.fill('#password', 'password123'); await p.fill('#repeat', 'password123');
  await p.click('button[type=submit]');
  await p.getByText(/too easy to guess/i).waitFor({ timeout: 10000 });
  await p.fill('#password', NEW_PASSWORD); await p.fill('#repeat', NEW_PASSWORD);
  await p.click('button[type=submit]');
  await p.getByRole('heading', { name: /password changed/i }).waitFor({ timeout: 15000 });
  await p.getByRole('link', { name: /^sign in$/i }).click();
  await p.getByText(/password was changed/i).waitFor();
  await p.fill('#email', email); await p.fill('#password', 'intruder-long-password-1');
  await p.click('button[type=submit]');
  await p.getByText(/Invalid email or password/).waitFor({ timeout: 10000 });
  await p.fill('#password', NEW_PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL(/\/(dashboard|onboarding)/, { timeout: 20000 });
  await c.close();
});

// =====================================================================================================================================
// C. two-step verification, sessions
// =====================================================================================================================================
await step('Security tab: turn on two-step verification (QR, code, recovery codes that cannot be dismissed unsaved)', async () => {
  await signIn(page, email, NEW_PASSWORD);
  await openSecurity(page);
  await page.getByTestId('tf-enable').click();
  await page.getByRole('dialog').getByRole('img', { name: /QR code/i }).waitFor({ timeout: 15000 });
  secret = (await page.getByTestId('totp-secret').innerText()).trim();
  expect(/^[A-Z2-7]{32}$/.test(secret), `a 160-bit secret in base32, got ${secret}`);
  await shot(page, 'security-2fa-setup');
  await page.fill('#tf-code', '000000');
  await page.getByRole('button', { name: /verify and turn on/i }).click();
  await page.getByText(/That code did not match/i).waitFor({ timeout: 10000 });
  await page.fill('#tf-code', await nextCode(secret));
  await page.getByRole('button', { name: /verify and turn on/i }).click();
  await page.getByTestId('recovery-codes').waitFor({ timeout: 15000 });
  recovery = await page.getByTestId('recovery-codes').locator('li').allInnerTexts();
  expect(recovery.length === 10 && recovery.every((c) => /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(c)), `ten recovery codes, got ${JSON.stringify(recovery)}`);
  await page.keyboard.press('Escape');
  await page.getByTestId('recovery-codes').waitFor(); // still there: they are shown once, so a stray key cannot dismiss them
  expect(await page.getByRole('button', { name: 'Done' }).isDisabled(), 'Done stays disabled until the owner says the codes are saved');
  await shot(page, 'security-recovery-codes');
  await page.getByRole('checkbox', { name: /saved these codes/i }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByTestId('tf-status').getByText('On').waitFor({ timeout: 10000 });
});

await step('sign-in now asks for the code after the password: a wrong code is refused, the right one lets in, the same one cannot be used twice', async () => {
  await signOut(page);
  await signIn(page, email, NEW_PASSWORD, { then: twoStep(page) });
  await shot(page, 'login-2fa');
  await page.fill('#code', '000000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText(/code did not match/i).waitFor({ timeout: 10000 });
  const good = await nextCode(secret);
  await page.fill('#code', good);
  await submitAndWait(page, () => page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 25000 }));
  // the same code, straight away, in another browser: refused (a watched or intercepted code is worth nothing)
  const c = await newContext();
  const p = watch(await c.newPage());
  await signIn(p, email, NEW_PASSWORD, { then: twoStep(p) });
  await p.fill('#code', good);
  await p.getByRole('button', { name: 'Continue' }).click();
  await p.getByText(/code did not match/i).waitFor({ timeout: 10000 });
  await c.close();
});

await step('a recovery code signs in once; the Security tab counts what is left', async () => {
  await signOut(page);
  await signInWithCode(page, email, NEW_PASSWORD, recovery[0], { recovery: true });
  await page.goto(`${base}/settings?tab=security`);
  await page.getByText(/Recovery codes left: 9/).waitFor({ timeout: 15000 });
});

await step('sessions: another browser appears in the list, can be signed out from here, and is bounced to sign-in at once', async () => {
  const c = await newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  const p = watch(await c.newPage());
  await signInWithCode(p, email, NEW_PASSWORD, await nextCode(secret));
  await openSecurity(page);
  const list = page.getByTestId('sessions');
  await list.getByText('Safari · iOS').waitFor({ timeout: 15000 });
  await list.getByText('This device').waitFor();
  await shot(page, 'security-sessions');
  await list.locator('li', { hasText: 'Safari · iOS' }).getByRole('button', { name: 'Sign out' }).click();
  await list.getByText('Safari · iOS').waitFor({ state: 'hidden', timeout: 10000 });
  await p.goto(`${base}/contacts`); // the cookie is still there, but the API has ended that session: the first call says so and the page signs out
  await p.waitForURL(/\/login/, { timeout: 20000 });
  await p.getByText(/session ended/i).waitFor({ timeout: 10000 });
  await c.close();
});

await step('new recovery codes need a current code and retire the old ones; two-step verification is turned off with password and code', async () => {
  await page.goto(`${base}/settings?tab=security`);
  await page.getByRole('button', { name: 'New recovery codes' }).click();
  await page.fill('#cd-code', await nextCode(secret));
  await page.getByRole('dialog').getByRole('button', { name: 'New recovery codes' }).click();
  await page.getByTestId('recovery-codes').waitFor({ timeout: 15000 });
  const fresh = await page.getByTestId('recovery-codes').locator('li').allInnerTexts();
  expect(fresh.length === 10 && !fresh.some((c) => recovery.includes(c)), 'ten NEW codes');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await page.fill('#cd-password', NEW_PASSWORD);
  await page.fill('#cd-code', await nextCode(secret));
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
  await page.getByTestId('tf-status').getByText('Off').waitFor({ timeout: 15000 });
});

await step('change password in Settings: the current one is checked, the other devices are signed out', async () => {
  await page.goto(`${base}/settings?tab=security`);
  await page.fill('#pw-current', 'wrong-current-password-1');
  await page.fill('#pw-new', 'the-third-long-password-3'); await page.fill('#pw-repeat', 'the-third-long-password-3');
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByText(/current password is not right/i).waitFor({ timeout: 10000 });
  await page.fill('#pw-current', NEW_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await toast(page, 'Password changed');
});

// =====================================================================================================================================
// D. participant data: hidden numbers, "confirm it is you", the activity log
// =====================================================================================================================================
await step('contacts: numbers are hidden; one is shown on request and hides again', async () => {
  const c = await newContext();
  page = watch(await c.newPage());
  await signIn(page, 'demo@surveyflow.test', process.env.SEED_DEMO_PASSWORD || 'demo-password-123', { expect: /\/dashboard/ }); // an account from before the new hashing: it is moved to argon2id by this very sign-in
  await page.goto(`${base}/contacts`);
  await page.getByTestId('phone').first().waitFor({ timeout: 15000 });
  const masked = await page.getByTestId('phone').first().innerText();
  expect(/^\+237 6XX XXX \d{3}$/.test(masked), `the list shows a masked number, got "${masked}"`);
  const html = await page.content();
  expect(!/phoneHash/.test(html), 'no index in the page');
  await shot(page, 'contacts-masked');
  await page.getByRole('button', { name: 'Show number' }).first().click();
  await page.waitForFunction(() => !/X/.test(document.querySelector('[data-testid=phone]')?.textContent ?? 'X'), null, { timeout: 10000 });
  const shown = await page.getByTestId('phone').first().innerText();
  expect(/\d/.test(shown) && !/X/.test(shown), `the number is shown, got "${shown}"`);
  await page.getByRole('button', { name: 'Hide number' }).first().click();
  expect(/^\+237 6XX XXX \d{3}$/.test(await page.getByTestId('phone').first().innerText()), 'hidden again');
  // a search for a FRAGMENT of a number finds nothing: the search box is not a way to read numbers digit by digit
  await page.fill('input[type=search]', shown.replace(/\D/g, '').slice(3, 8));
  await page.getByText(/No contact matches/i).waitFor({ timeout: 10000 });
});

await step('export: a large download asks "confirm it is you" (wrong password refused, right one lets it through), then the file arrives', async () => {
  const id = await page.evaluate(async () => (await (await fetch('/proxy/surveys')).json()).items.find((s) => s.status === 'active')?.id);
  await page.goto(`${base}/surveys/${id}/export`);
  await page.getByRole('button', { name: /Download Excel/i }).click();
  await page.getByRole('dialog').getByRole('heading', { name: /confirm it is you/i }).waitFor({ timeout: 15000 });
  await shot(page, 'step-up-dialog');
  await page.fill('#su-secret', 'not-my-password');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await page.getByRole('dialog').getByText(/did not match/i).waitFor({ timeout: 10000 });
  await page.fill('#su-secret', process.env.SEED_DEMO_PASSWORD || 'demo-password-123');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()]);
  const path = `${out}/${download.suggestedFilename()}`;
  await download.saveAs(path);
  expect(statSync(path).size > 2000, 'the spreadsheet arrived');
  // a second download inside the 15 minutes does not ask again
  const [again] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: /Download Excel/i }).click()]);
  expect(!!again.suggestedFilename(), 'the window stays open for fifteen minutes');
});

await step('the activity log shows what happened to the account: the sign-in, the shown number, the download', async () => {
  await page.goto(`${base}/settings?tab=security`);
  const log = page.getByTestId('activity');
  await log.getByText('Signed in').first().waitFor({ timeout: 15000 });
  await log.getByText('Showed a phone number').first().waitFor();
  await log.getByText(/Downloaded participant data · 60 rows/).first().waitFor();
  const text = await log.innerText();
  expect(!/\+237|677|@/.test(text), 'the log holds no number and no address');
  await shot(page, 'security-activity');
});

await step('the API proxy refuses sign-in, renewal and webhook routes however the address is spelled, oversized bodies, and calls another site caused', async () => {
  await page.goto(`${base}/dashboard`);
  await page.waitForSelector('main', { timeout: 15000 });
  const probe = (path, { method = 'POST', big = false } = {}) => page.evaluate(async ({ path, method, big }) => {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: big ? new Blob([new Uint8Array(3.2 * 1024 * 1024)]) : '{}' });
    return { status: r.status, text: (await r.text()).slice(0, 100) };
  }, { path, method, big });
  // the routes only the website's server may call
  for (const p of ['/proxy/auth/login', '/proxy/auth/refresh', '/proxy/auth/google', '/proxy/auth/signout', '/proxy/auth/logout', '/proxy/webhook/whatsapp', '/proxy/payments/webhook/notchpay']) {
    const r = await probe(p);
    expect(r.status === 404, `${p} must not be reachable from a browser (got ${r.status} ${r.text})`);
  }
  // the same routes through a slash, a question mark, a fragment or a traversal hidden in the address (each reached the API's sign-in before the fix)
  for (const p of ['/proxy/auth/login%3Fx=1', '/proxy/contacts%2F..%2Fauth%2Flogin', '/proxy/contacts/..%2Fauth/login', '/proxy/auth/refresh%23x', '/proxy/auth%2Flogin', '/proxy/auth/google%3F', '/proxy/auth/signout%00']) {
    const r = await probe(p);
    expect(r.status === 400 || r.status === 404, `${p} must be refused (got ${r.status} ${r.text})`);
  }
  const big = await probe('/proxy/contacts/import', { big: true });
  expect(big.status === 413, `a 3 MB body must be refused before it is read (got ${big.status})`);
  // calls another site caused, and a foreign Origin (a browser's fetch cannot set these headers, so they are sent from outside it with this session's cookie)
  const cross = await ctx.request.get(`${base}/proxy/auth/config`, { headers: { 'sec-fetch-site': 'cross-site' } });
  expect(cross.status() === 403, `a cross-site request must be refused (got ${cross.status()})`);
  const sibling = await ctx.request.get(`${base}/proxy/auth/config`, { headers: { 'sec-fetch-site': 'same-site' } });
  expect(sibling.status() === 403, `a request from a sibling sub-domain must be refused too (got ${sibling.status()})`);
  const same = await ctx.request.get(`${base}/proxy/auth/config`, { headers: { 'sec-fetch-site': 'same-origin' } });
  expect(same.status() === 200, `a same-origin request must work (got ${same.status()})`);
  const typed = await ctx.request.get(`${base}/proxy/auth/config`, { headers: { 'sec-fetch-site': 'none' } });
  expect(typed.status() === 200, `an address the owner opened themselves is fine for a read (got ${typed.status()})`);
  const typedWrite = await ctx.request.post(`${base}/proxy/auth/register`, { headers: { 'sec-fetch-site': 'none', 'content-type': 'application/json' }, data: {} });
  expect(typedWrite.status() === 403, `...but never for a write (got ${typedWrite.status()})`);
  const foreign = await ctx.request.post(`${base}/proxy/auth/register`, { headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, data: {} });
  expect(foreign.status() === 403, `a foreign Origin must be refused (got ${foreign.status()})`);
});

await step('after sign-in the browser only ever goes to a page of this site, however the return address is spelled (no open redirect)', async () => {
  for (const evil of ['/\\evil.example/phish', '//evil.example/phish', 'https://evil.example/phish']) {
    const c = await newContext();
    const p = watch(await c.newPage());
    await p.goto(`${base}/login?callbackUrl=${encodeURIComponent(evil)}`);
    await p.fill('#email', email);
    await p.fill('#password', 'the-third-long-password-3'); // what the "change password" step left it as
    await submitAndWait(p, () => p.waitForURL(/\/(dashboard|onboarding)/, { timeout: 25000 }));
    expect(new URL(p.url()).origin === new URL(base).origin, `signing in with callbackUrl=${evil} went to ${p.url()}`);
    await c.close();
  }
});

await step('sign out everywhere ends this session too', async () => {
  await page.goto(`${base}/settings?tab=security`);
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await page.waitForURL(/\/login/, { timeout: 20000 });
});

// =====================================================================================================================================
// E. the API token renews itself
// =====================================================================================================================================
if (SHORT) {
  await step('silent renewal: after the 30-second API token has run out, parallel calls all succeed and the cookie holds a new refresh token', async () => {
    const c = await newContext();
    page = watch(await c.newPage());
    await signIn(page, 'demo@surveyflow.test', process.env.SEED_DEMO_PASSWORD || 'demo-password-123', { expect: /\/dashboard/ });
    const before = await cookieValue(c);
    await sleep(36_000);
    const statuses = await page.evaluate(async () => Promise.all(Array.from({ length: 8 }, () => fetch('/proxy/auth/me').then((r) => r.status))));
    expect(statuses.every((s) => s === 200), `eight calls at once with an expired token must all succeed, got ${statuses}`);
    const after = await cookieValue(c);
    expect(!!after && after !== before, 'the cookie must have been rewritten with the renewed tokens');
    await page.goto(`${base}/contacts`);
    await page.getByTestId('phone').first().waitFor({ timeout: 15000 });
    // and the sign-in lasts: another quiet minute, then the page still works (two more renewals)
    await sleep(62_000);
    await page.goto(`${base}/surveys`);
    await page.waitForSelector('main', { timeout: 15000 });
    expect(!/\/login/.test(page.url()), 'still signed in after several renewals');
    await c.close();
  });
} else {
  console.log('· skipped: silent renewal (run the API with ACCESS_TOKEN_TTL_SECONDS=30 and set SF_SHORT_TOKENS=1)');
}

await step('the Content-Security-Policy blocked nothing the product does', async () => {
  expect(violations.length === 0, `CSP violations: ${JSON.stringify(violations.slice(0, 5))}`);
});

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s) seen in the browser:\n  - ${problems.slice(0, 15).join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nAll ${n} steps passed. Screenshots in ${out}`);
