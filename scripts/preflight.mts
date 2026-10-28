/**
 * Preflight: the checks that only a real service, host or computer can settle. The automated tests fake every outside service (that is what makes them fast and
 * repeatable); this script runs the PRODUCTION code paths against the real ones, on the machine or host you point it at, and says PASS / WARN / FAIL / SKIP for each.
 * Secrets are never printed. Nothing is changed or stored; the one thing that is sent on purpose is the e-mail of `--mail-to`.
 *
 *   npx tsx --env-file=.env scripts/preflight.mts [options]
 *
 *   --only <list>       comma-separated subset of: google, breach, captcha, argon2, mail, headers, next (default: all that apply)
 *   --domain <domain>   mail: the domain of EMAIL_FROM; checks its SPF, DKIM and DMARC records in DNS
 *   --mail-to <address> mail: send ONE real e-mail through the configured provider (EMAIL_PROVIDER) to this address
 *   --url <https://...> headers: the address of the deployed website (or of the `npm run share` tunnel); checks https, HSTS, the CSP and the cookies
 *   --fake-services     self-test of THIS script: haveibeenpwned, Cloudflare and Resend are answered by built-in fakes that follow their documentation. It shows that the
 *                       script reads real answers correctly; it proves nothing about the real services.
 *
 * What each check covers, and what it cannot:
 *   google    fetches Google's real key set and shows that the production verifier refuses forged ID tokens against it. It cannot make a GENUINE token: sign in once.
 *   breach    asks haveibeenpwned (k-anonymity range API) through the production check. The check fails open: where the service cannot be reached it silently does nothing.
 *   captcha   Cloudflare's published test secrets through the production check (and your own secret, if set, to see that Cloudflare accepts it). Needs challenges.cloudflare.com.
 *   argon2    hashes and verifies with the native module on THIS computer, times it, and cross-checks with the reference C implementation when Python's argon2-cffi is installed.
 *   mail      DNS records of the sending domain, and one real message. "Accepted" is not "delivered": look at the inbox, the spam folder and the message headers (dkim, spf, dmarc = pass).
 *   headers   what the deployed website sends: https redirect, HSTS, a fresh CSP nonce per page, the other headers, and the cookie names (a proxy that hides https turns
 *             `__Host-next-auth.csrf-token` into `next-auth.csrf-token`: that is the failure this finds). Against `npm run share` it is a check through a real Cloudflare edge.
 *   next      offline: loads the INSTALLED Next.js, makes it behave as on a Windows host (path.win32) and checks that it refuses cache paths that climb out of its folder
 *             and escapes the backslash in a path segment: the fix of the critical remote-code-execution advisory for Windows-hosted servers (15.5.24). Re-run it after every
 *             Next.js upgrade; it SKIPs, never fails, when a later Next.js has moved the code it reads.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import nodePath from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const ALL = ['google', 'breach', 'captcha', 'argon2', 'mail', 'headers', 'next'];
const only = new Set((opt('only') ?? ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean));
for (const o of only) if (!ALL.includes(o)) { console.error(`unknown check "${o}" (${ALL.join(', ')})`); process.exit(2); }

// ---- fakes for --fake-services ----------------------------------------------------------------------------------------------------

/** Answers for the three services this sandbox cannot reach, in the formats their documentation gives. Everything else goes out for real. */
function installFakes(): void {
  const real = globalThis.fetch;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === 'api.pwnedpasswords.com') {
      // The documented range answer: 35-character suffixes with a count; with Add-Padding, extra rows with a count of 0.
      const sha1 = createHash('sha1').update('password').digest('hex').toUpperCase();
      if (u.pathname !== `/range/${sha1.slice(0, 5)}`) return new Response(`${'0'.repeat(35)}:0\r\n`, { status: 200 });
      return new Response(`0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${sha1.slice(5)}:10434004\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0\r\n`, { status: 200 });
    }
    if (u.hostname === 'challenges.cloudflare.com' && u.pathname === '/turnstile/v0/siteverify') {
      const secret = new URLSearchParams(String(init?.body)).get('secret');
      if (secret === '1x0000000000000000000000000000000AA') return json({ success: true, 'error-codes': [], challenge_ts: new Date().toISOString(), hostname: 'example.com' });
      if (secret === '2x0000000000000000000000000000000AA') return json({ success: false, 'error-codes': ['invalid-input-response'] });
      return json({ success: false, 'error-codes': ['invalid-input-secret'] });
    }
    if (u.hostname === 'api.resend.com') return json({ id: 'fake-message-id' });
    return real(input, init);
  }) as typeof fetch;
}
if (args.includes('--fake-services')) installFakes();

// ---- tiny reporting kit ---------------------------------------------------------------------------------------------------------

type Level = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
const ICON: Record<Level, string> = { PASS: '✓', WARN: '!', FAIL: '✗', SKIP: '–' };
const counts: Record<Level, number> = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
function report(level: Level, name: string, detail = ''): void {
  counts[level]++;
  console.log(`${ICON[level]} ${level.padEnd(4)} ${name}${detail ? `\n         ${detail.replace(/\n/g, '\n         ')}` : ''}`);
}
const section = (title: string) => console.log(`\n== ${title}`);
const message = (e: unknown): string => { const err = e as { message?: string; cause?: { code?: string; message?: string } }; return err.cause?.code ?? err.cause?.message ?? err.message ?? String(e); };

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(10_000), ...init });
}

// ---- google ---------------------------------------------------------------------------------------------------------------------

async function checkGoogle(): Promise<void> {
  section('google: Google sign-in against Google\'s real keys');
  const { SignJWT, generateKeyPair } = await import('jose');
  const { env } = await import('../apps/api/src/config/env');
  const { verifyGoogleIdToken } = await import('../apps/api/src/routes/auth-google');
  const clientId = env.GOOGLE_CLIENT_ID ?? 'preflight.apps.googleusercontent.com';
  env.GOOGLE_CLIENT_ID = clientId;

  let keys: { kid: string; alg?: string }[];
  try {
    const res = await get('https://www.googleapis.com/oauth2/v3/certs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    keys = ((await res.json()) as { keys: { kid: string; alg?: string }[] }).keys;
  } catch (e) {
    report('WARN', 'Google key set', `could not be fetched from here (${message(e)}). Production would then refuse every Google sign-in (it fails closed); allow outbound https to www.googleapis.com.`);
    return;
  }
  if (!keys.length || !keys.every((k) => k.kid && (k.alg ?? 'RS256') === 'RS256')) { report('FAIL', 'Google key set', 'unexpected shape: no RS256 keys with a key id'); return; }
  report('PASS', 'Google key set', `${keys.length} RS256 keys fetched from www.googleapis.com`);

  const mine = await generateKeyPair('RS256');
  const claims = { email: 'victim@example.com', email_verified: true, name: 'Victim' };
  const forge = (kid: string) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).setSubject('1234567890').setIssuer('https://accounts.google.com').setAudience(clientId).setIssuedAt().setExpirationTime('10m').sign(mine.privateKey);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 600;
  const hs256 = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: keys[0]!.kid }).setSubject('1').setIssuer('https://accounts.google.com').setAudience(clientId).setExpirationTime('10m').sign(new TextEncoder().encode(JSON.stringify(keys[0])));
  const cases: Array<[string, string]> = [
    ['signed by a key of mine, claiming one of Google\'s real key ids', await forge(keys[0]!.kid)],
    ['signed by a key of mine, with a key id Google does not have', await forge('not-a-google-key-id')],
    ['unsigned (alg none)', `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: 'https://accounts.google.com', aud: clientId, sub: '1', email: 'victim@example.com', email_verified: true, exp })}.`],
    ['HS256 "signed" with Google\'s public key (algorithm confusion)', hs256],
    ['not a token', 'abc.def.ghi'],
  ];
  const accepted: string[] = [];
  const classes = new Set<string>();
  for (const [what, token] of cases) {
    try { await verifyGoogleIdToken(token); accepted.push(what); } catch (e) { classes.add((e as Error).constructor.name); }
  }
  if (accepted.length) report('FAIL', 'forged Google tokens', `ACCEPTED by the production verifier:\n- ${accepted.join('\n- ')}`);
  else report('PASS', 'forged Google tokens', `all ${cases.length} refused by the production verifier against Google's real keys (${[...classes].join(', ')})`);
  report('SKIP', 'a genuine Google token', 'only a real sign-in with a Google account produces one, for YOUR client id: do it once on the deployed site and read the audit log (google_login).');
}

// ---- breach ---------------------------------------------------------------------------------------------------------------------

async function checkBreach(): Promise<void> {
  section('breach: haveibeenpwned (password breach check at sign-up)');
  const { env } = await import('../apps/api/src/config/env');
  const { isBreachedPassword } = await import('../apps/api/src/lib/password');
  if (!env.hibpEnabled) report('WARN', 'HIBP_CHECK', `off in this environment (NODE_ENV=${env.NODE_ENV}): sign-up does not ask the service at all`);
  const sha1 = createHash('sha1').update('password').digest('hex').toUpperCase();
  let text: string;
  try {
    const res = await get(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, { headers: { 'Add-Padding': 'true', 'User-Agent': 'SurveyFlow-preflight' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    report('WARN', 'haveibeenpwned', `unreachable from here (${message(e)}). The production check FAILS OPEN: here, sign-up would accept breached passwords without a word. Allow outbound https to api.pwnedpasswords.com.`);
    return;
  }
  const rows = text.split(/\r?\n/).filter(Boolean).map((l) => l.split(':'));
  const known = rows.find(([s]) => s?.toUpperCase() === sha1.slice(5));
  const padding = rows.filter(([, c]) => Number(c) === 0).length;
  if (!known || !(Number(known[1]) > 0)) { report('FAIL', 'range answer', 'the answer for the prefix of "password" does not list its suffix: the response format is not what the code expects'); return; }
  report('PASS', 'range answer', `${rows.length} rows for prefix ${sha1.slice(0, 5)}, "password" listed ${Number(known[1]).toLocaleString('en')} times, ${padding} padding rows with a count of 0 (the code ignores them)`);
  const bad = await isBreachedPassword('password');
  const fresh = await isBreachedPassword(randomBytes(24).toString('base64url'));
  if (bad && !fresh) report('PASS', 'production check', '"password" is refused, a random 32-character password is not');
  else report('FAIL', 'production check', `"password" breached: ${bad}; random password breached: ${fresh}`);
}

// ---- captcha --------------------------------------------------------------------------------------------------------------------

async function checkCaptcha(): Promise<void> {
  section('captcha: Cloudflare Turnstile');
  const { env } = await import('../apps/api/src/config/env');
  const { verifyCaptcha } = await import('../apps/api/src/lib/captcha');
  const real = env.TURNSTILE_SECRET_KEY;
  // Cloudflare's documented dummy secrets: always passes / always fails.
  const ALWAYS_PASS = '1x0000000000000000000000000000000AA', ALWAYS_FAIL = '2x0000000000000000000000000000000AA';
  let reached = false;
  let lastBody: { success?: boolean; 'error-codes'?: string[] } = {};
  const spy: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    reached = true;
    lastBody = (await res.clone().json().catch(() => ({}))) as typeof lastBody;
    return res;
  };
  env.captchaEnabled = true;

  env.TURNSTILE_SECRET_KEY = ALWAYS_PASS;
  const pass = await verifyCaptcha('XXXX.DUMMY.TOKEN.XXXX', '203.0.113.7', spy);
  if (!reached) { report('WARN', 'Cloudflare siteverify', 'unreachable from here. The production check FAILS OPEN: here, a bot would pass the CAPTCHA. Allow outbound https to challenges.cloudflare.com.'); env.TURNSTILE_SECRET_KEY = real; return; }
  if (pass && lastBody.success === true) report('PASS', 'accepts a passing token', 'siteverify answered success:true to the always-pass test secret');
  else report('FAIL', 'accepts a passing token', `production check returned ${pass}; siteverify said ${JSON.stringify(lastBody)}`);

  reached = false;
  env.TURNSTILE_SECRET_KEY = ALWAYS_FAIL;
  const fail = await verifyCaptcha('XXXX.DUMMY.TOKEN.XXXX', '203.0.113.7', spy);
  if (!fail && lastBody.success === false) report('PASS', 'refuses a failing token', `siteverify answered success:false (${(lastBody['error-codes'] ?? []).join(', ') || 'no code'})`);
  else report('FAIL', 'refuses a failing token', `production check returned ${fail}; siteverify said ${JSON.stringify(lastBody)}`);

  env.TURNSTILE_SECRET_KEY = real;
  if (!real) { report('SKIP', 'your own secret', 'TURNSTILE_SECRET_KEY is not set here.'); return; }
  reached = false;
  await verifyCaptcha('XXXX.DUMMY.TOKEN.XXXX', undefined, spy);
  const codes = lastBody['error-codes'] ?? [];
  if (codes.includes('invalid-input-secret')) report('FAIL', 'your own secret', 'Cloudflare says the secret is invalid (TURNSTILE_SECRET_KEY is mistyped, or belongs to another widget)');
  else if (!reached) report('WARN', 'your own secret', 'siteverify could not be reached');
  else report('PASS', 'your own secret', `accepted by Cloudflare (it refused only the dummy token: ${codes.join(', ') || 'no code'}). Whether the widget loads in a browser on your domain is checked in the browser.`);
}

// ---- argon2 ---------------------------------------------------------------------------------------------------------------------

function python(code: string, input: string): { ok: boolean; out: string } | null {
  for (const cmd of process.platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']]) {
    const r = spawnSync(cmd[0]!, [...cmd.slice(1), '-I', '-c', code], { input, encoding: 'utf8' });
    if (r.error) continue; // not installed under this name
    return { ok: r.status === 0, out: (r.stdout + r.stderr).trim() };
  }
  return null;
}

async function checkArgon2(): Promise<void> {
  section(`argon2: password hashing on this computer (${process.platform}-${process.arch}, Node ${process.versions.node})`);
  const { hashPassword, verifyPassword } = await import('../apps/api/src/lib/password');
  const pw = 'correct horse battery staple — ünïcödé 日本語';
  let hash: string;
  const t0 = performance.now();
  try { hash = await hashPassword(pw); } catch (e) { report('FAIL', 'native module', `the argon2 module did not load or run here: ${message(e)}`); return; }
  const ms = Math.round(performance.now() - t0);
  const params = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (!params) { report('FAIL', 'hash format', 'not an argon2id v19 hash in the standard format'); return; }
  report(ms > 1000 ? 'WARN' : 'PASS', 'hashing', `argon2id, ${Number(params[1]) / 1024} MiB, ${params[2]} passes, ${params[3]} lane: ${ms} ms for one hash${ms > 1000 ? ' (slow: every sign-in pays it; lower ARGON2_MEMORY_KIB or use a faster host)' : ''}`);
  const ok = await verifyPassword(hash, pw);
  const bad = await verifyPassword(hash, `${pw}!`);
  if (ok.ok && !bad.ok) report('PASS', 'verify', 'the right password verifies (non-ASCII included), a wrong one does not');
  else report('FAIL', 'verify', `right: ${ok.ok}, wrong: ${bad.ok}`);

  const there = python('import sys, json\nfrom argon2 import PasswordHasher\nh, p = json.loads(sys.stdin.read())\nprint(PasswordHasher().verify(h, p))', JSON.stringify([hash, pw]));
  if (!there || /No module named 'argon2'|ModuleNotFoundError/.test(there.out)) { report('SKIP', 'reference implementation', 'Python with argon2-cffi is not installed here (python3 -m pip install argon2-cffi); the check compares with the reference C implementation.'); return; }
  if (!there.ok) { report('FAIL', 'reference implementation', `argon2-cffi does not verify our hash: ${there.out.split('\n').pop()}`); return; }
  const back = python('import sys, json\nfrom argon2 import PasswordHasher, Type\np = json.loads(sys.stdin.read())\nprint(PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4, type=Type.ID).hash(p))', JSON.stringify(pw));
  const theirs = back?.out.split('\n').pop() ?? '';
  const mine = await verifyPassword(theirs, pw);
  if (back?.ok && mine.ok) report('PASS', 'reference implementation', 'argon2-cffi verifies our hash, and we verify a hash it made with other parameters (3 passes, 64 MiB, 4 lanes)');
  else report('FAIL', 'reference implementation', `we do not verify the reference hash: ${theirs.slice(0, 80)}`);
}

// ---- mail -----------------------------------------------------------------------------------------------------------------------

/** Node cannot tell "no such record" from "no DNS here" by the error code (both are ENOTFOUND), so DNS is probed once with a name that always exists. */
async function dnsWorks(): Promise<boolean> {
  try { await dns.resolve4('one.one.one.one'); return true; } catch { return false; }
}
async function txt(name: string): Promise<string[]> {
  try { return (await dns.resolveTxt(name)).map((chunks) => chunks.join('')); } catch (e) {
    if (['ENODATA', 'ENOTFOUND'].includes((e as { code?: string }).code ?? '')) return [];
    throw e;
  }
}

async function checkMail(): Promise<void> {
  section('mail: the sending domain and the provider');
  const domain = opt('domain');
  const to = opt('mail-to');
  if (!domain && !to) { report('SKIP', 'mail', 'give --domain (the domain of EMAIL_FROM) to check its DNS records, and --mail-to (an address of yours) to send one real message.'); return; }

  if (domain) {
    const reachable = await dnsWorks();
    if (!reachable) report('WARN', `DNS of ${domain}`, 'DNS cannot be read from here: run this check where DNS works (your own computer).');
    else try {
      const spf = (await txt(domain)).filter((r) => /^v=spf1\b/i.test(r));
      if (spf.length > 1) report('FAIL', `SPF of ${domain}`, `${spf.length} SPF records: a domain may publish exactly one, receivers treat several as an error`);
      else if (!spf.length) report('WARN', `SPF of ${domain}`, 'no "v=spf1" record: receivers cannot tell that your provider may send for this domain');
      else if (/[?+]all\b/.test(spf[0]!) || !/[~-]all\b/.test(spf[0]!)) report('WARN', `SPF of ${domain}`, `${spf[0]}\nends without "~all" or "-all": anybody may send as you`);
      else report('PASS', `SPF of ${domain}`, spf[0]!);
    } catch (e) { report('WARN', `SPF of ${domain}`, `could not be read (${message(e)})`); }
    if (reachable) {
      const dmarc = (await txt(`_dmarc.${domain}`).catch(() => [])).filter((r) => /^v=DMARC1\b/i.test(r));
      const policy = /\bp=(\w+)/i.exec(dmarc[0] ?? '')?.[1]?.toLowerCase();
      if (!dmarc.length) report('WARN', `DMARC of ${domain}`, 'no record at _dmarc: without it, receivers have no instruction for mail that fails SPF and DKIM');
      else if (policy === 'none') report('WARN', `DMARC of ${domain}`, `${dmarc[0]}\np=none only reports; move to quarantine or reject once the mail you send passes`);
      else report('PASS', `DMARC of ${domain}`, dmarc[0]!);
      const selectors = ['resend', 'brevo1', 'brevo2', 'mail', 'default', 'google', 's1', 's2', 'k1', 'selector1', 'selector2', 'smtp', 'dkim'];
      const found: string[] = [];
      for (const s of selectors) if ((await txt(`${s}._domainkey.${domain}`).catch(() => [])).some((r) => /v=DKIM1|k=rsa|p=/i.test(r)) || (await dns.resolveCname(`${s}._domainkey.${domain}`).catch(() => [])).length) found.push(s);
      if (found.length) report('PASS', `DKIM of ${domain}`, `key published for selector(s): ${found.join(', ')}`);
      else report('WARN', `DKIM of ${domain}`, `none of the usual selectors has a key (${selectors.join(', ')}): your provider's dashboard names the exact record to publish, and shows when it is verified`);
    }
  }

  if (!to) { report('SKIP', 'a real message', 'no --mail-to given.'); return; }
  const { env } = await import('../apps/api/src/config/env');
  const { sendMail } = await import('../apps/api/src/services/mail');
  if (args.includes('--fake-services')) { env.emailProvider = 'resend'; env.RESEND_API_KEY = 're_fake'; env.EMAIL_FROM = 'SurveyFlow <no-reply@example.com>'; }
  if (env.emailProvider === 'mock') { report('SKIP', 'a real message', 'EMAIL_PROVIDER is "mock": messages are kept in a local mailbox and nothing is sent. Set resend, brevo or smtp (docs/SECURITY.md) and run again.'); return; }
  const warnings: string[] = [];
  const accepted = await sendMail(to, 'verify_email', 'en', { url: `${env.webBaseUrl}/verify-email?token=preflight-not-a-real-token`, name: 'Preflight' }, { warn: (_o, m) => warnings.push(m ?? '') });
  if (accepted) {
    report('PASS', `provider "${env.emailProvider}"`, `accepted the message for ${to} (sender ${env.EMAIL_FROM}).\nAccepted is not delivered: check the inbox AND the spam folder, then open the message's original headers: dkim=pass, spf=pass, dmarc=pass.`);
    return;
  }
  const diag = await diagnoseMail(to);
  report('FAIL', `provider "${env.emailProvider}"`, `${warnings.join('; ') || 'the provider did not accept the message'}${diag ? `\n${diag}` : ''}`);
}

/** The production sender keeps only the status; here the provider's own reason is shown (it is on your screen, not in a log). */
async function diagnoseMail(to: string): Promise<string> {
  const { env } = await import('../apps/api/src/config/env');
  try {
    if (env.emailProvider === 'resend') {
      const r = await get('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: 'SurveyFlow preflight', text: 'preflight' }) });
      return `Resend answered ${r.status}: ${(await r.text()).slice(0, 300)}`;
    }
    if (env.emailProvider === 'brevo') {
      const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(env.EMAIL_FROM);
      const r = await get('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': env.BREVO_API_KEY!, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ sender: { name: m?.[1]?.trim() || 'SurveyFlow', email: m?.[2]?.trim() ?? env.EMAIL_FROM }, to: [{ email: to }], subject: 'SurveyFlow preflight', textContent: 'preflight' }) });
      return `Brevo answered ${r.status}: ${(await r.text()).slice(0, 300)}`;
    }
  } catch (e) { return `the provider could not be reached (${message(e)})`; }
  return '';
}

// ---- headers --------------------------------------------------------------------------------------------------------------------

async function checkHeaders(): Promise<void> {
  section('headers: what the deployed website sends');
  const base = opt('url')?.replace(/\/+$/, '');
  if (!base) { report('SKIP', 'headers', 'give --url (the deployed website, or the `npm run share` address).'); return; }
  const https = base.startsWith('https://');
  if (!https) report('WARN', 'https', 'the address is plain http: HSTS, secure cookies and the CSP upgrade rule only exist over https. Check the real address.');

  let page: Response;
  try { page = await get(`${base}/login`, { redirect: 'follow' }); } catch (e) { report('FAIL', 'the website', `unreachable (${message(e)})`); return; }
  if (!page.ok) { report('FAIL', 'the website', `GET /login answered ${page.status}`); return; }
  const h = page.headers;
  const must = (name: string, test: (v: string) => boolean, expect: string) => {
    const v = h.get(name);
    if (v && test(v)) report('PASS', name, v.length > 110 ? `${v.slice(0, 110)}…` : v);
    else report('FAIL', name, v ? `${v}\nexpected: ${expect}` : `missing. Expected: ${expect}`);
  };
  must('x-content-type-options', (v) => /nosniff/i.test(v), 'nosniff');
  must('x-frame-options', (v) => /sameorigin|deny/i.test(v), 'SAMEORIGIN or DENY');
  must('referrer-policy', (v) => /strict-origin|no-referrer|same-origin/i.test(v), 'a strict policy');
  must('permissions-policy', (v) => /camera=\(\)/.test(v), 'camera, microphone, geolocation switched off');
  if (https) must('strict-transport-security', (v) => Number(/max-age=(\d+)/.exec(v)?.[1]) >= 15_552_000, 'max-age of at least 180 days (the app sends two years)');
  if (h.get('x-powered-by')) report('FAIL', 'x-powered-by', `${h.get('x-powered-by')}: the framework announces itself`); else report('PASS', 'x-powered-by', 'absent');

  const csp = h.get('content-security-policy');
  const script = /(?:^|;\s*)script-src ([^;]*)/.exec(csp ?? '')?.[1] ?? '';
  const nonce = /'nonce-([^']+)'/.exec(script)?.[1];
  if (!csp) report('FAIL', 'content-security-policy', 'missing (CSP_MODE=off, or report-only, or stripped by a proxy)');
  else if (!nonce || !script.includes("'strict-dynamic'") || /'unsafe-(inline|eval)'/.test(script) || !/object-src 'none'/.test(csp) || !/frame-ancestors/.test(csp)) report('FAIL', 'content-security-policy', `script-src is not the nonce policy the app builds:\n${csp.slice(0, 300)}`);
  else report('PASS', 'content-security-policy', `nonce + strict-dynamic, no unsafe-inline or unsafe-eval for scripts, object-src none`);
  if (https && csp && !/upgrade-insecure-requests/.test(csp)) report('WARN', 'content-security-policy', 'no upgrade-insecure-requests although the address is https: the site believes it is served over http (see the cookie check)');
  const again = (await get(`${base}/login`).catch(() => null))?.headers.get('content-security-policy');
  const nonce2 = /'nonce-([^']+)'/.exec(again ?? '')?.[1];
  if (nonce && nonce2 && nonce !== nonce2) report('PASS', 'nonce', 'a different one on every page');
  else if (nonce) report('FAIL', 'nonce', 'the same nonce twice: a cached page carries a nonce an attacker can read');
  const html = await page.text();
  const stamped = [...html.matchAll(/<script\b[^>]*\bnonce="([^"]+)"/g)].length;
  if (nonce) report(stamped > 0 ? 'PASS' : 'FAIL', 'scripts carry the nonce', `${stamped} script tag(s) stamped with it in the page`);

  try {
    const res = await get(`${base}/api/auth/csrf`);
    const cookies = res.headers.getSetCookie();
    const csrf = cookies.find((c) => /next-auth\.csrf-token=/.test(c));
    if (!csrf) report('WARN', 'cookies', 'no CSRF cookie on /api/auth/csrf');
    else if (https && !/^__Host-next-auth\.csrf-token=/.test(csrf)) report('FAIL', 'cookie names', `the CSRF cookie is "${csrf.split('=')[0]}" over an https address: the site does not know it is served over https (the proxy or CDN must send X-Forwarded-Proto: https, and NEXTAUTH_URL must be the https address). The session cookie would lose its protections.`);
    else if (https && !(/;\s*Secure/i.test(csrf) && /;\s*HttpOnly/i.test(csrf) && /;\s*SameSite=Lax/i.test(csrf))) report('FAIL', 'cookie flags', csrf.replace(/=[^;]*/, '=…'));
    else report('PASS', 'cookies', `${csrf.split('=')[0]}${https ? ' with Secure, HttpOnly, SameSite=Lax' : ' (http: no prefix, no Secure: expected only on a local test)'}`);
  } catch (e) { report('WARN', 'cookies', `could not read /api/auth/csrf (${message(e)})`); }

  if (https) {
    try {
      const plain = await get(base.replace(/^https:/, 'http:') + '/login', { redirect: 'manual' });
      const to = plain.headers.get('location') ?? '';
      if ([301, 302, 307, 308].includes(plain.status) && to.startsWith('https://')) report('PASS', 'http to https', `${plain.status} to ${to}`);
      else report('WARN', 'http to https', `plain http answered ${plain.status}${to ? ` (${to})` : ''}: the CDN or host should redirect to https`);
    } catch { report('SKIP', 'http to https', 'port 80 is not open from here (fine if the host only listens on https)'); }
  }
  const probe = await get(`${base}/_next/image?url=%2Ficon.svg&w=64&q=75`).catch(() => null);
  if (probe) report(probe.status === 404 || probe.status === 400 ? 'PASS' : 'FAIL', '/_next/image', `answered ${probe.status}: the image optimizer that had critical advisories is ${probe.status === 404 || probe.status === 400 ? 'not serving' : 'STILL SERVING'}`);
}

// ---- next -----------------------------------------------------------------------------------------------------------------------

async function checkNext(): Promise<void> {
  section('next: the Windows path-escape fix in the installed Next.js');
  const web = createRequire(new URL('../apps/web/package.json', import.meta.url));
  let root: string, version: string;
  try { root = nodePath.dirname(web.resolve('next/package.json')); version = JSON.parse(readFileSync(nodePath.join(root, 'package.json'), 'utf8')).version; } catch { report('SKIP', 'next', 'Next.js is not installed (npm ci first).'); return; }
  let escapeSegment: (s: string, encoded: boolean) => string;
  let cache: { prototype: { getFilePath(this: unknown, key: string, kind: unknown): string } };
  let kinds: Record<string, unknown>;
  try {
    escapeSegment = web('next/dist/shared/lib/router/utils/escape-path-delimiters').default;
    cache = web('next/dist/server/lib/incremental-cache/file-system-cache').default;
    kinds = web('next/dist/server/response-cache/types').IncrementalCacheKind;
    if (typeof escapeSegment !== 'function' || typeof cache?.prototype?.getFilePath !== 'function' || !kinds?.PAGES) throw new Error('shape');
  } catch { report('SKIP', `next@${version}`, 'the files this check reads are not where Next.js 15.5 keeps them. Check by hand that the installed version is past the advisories: npm run audit:gate.'); return; }

  const escaped = escapeSegment('a\\b', false);
  const saved = { join: nodePath.join, sep: nodePath.sep };
  const ctx = { serverDistDir: 'C:\\site\\.next\\server' };
  const inside = (p: string) => ['C:\\site\\.next\\server\\pages\\', 'C:\\site\\.next\\server\\app\\', 'C:\\site\\.next\\cache\\fetch-cache\\'].some((d) => p.startsWith(d));
  const hostile = ['..\\..\\..\\Windows\\win.ini', '..\\..\\evil', 'ok\\..\\..\\..\\evil'];
  let escapedOut = 0, refused = 0, good = '';
  Object.assign(nodePath, { join: nodePath.win32.join, sep: nodePath.win32.sep }); // as on a Windows host, for the length of the lookups only
  try {
    for (const kind of ['PAGES', 'FETCH', 'APP_PAGE']) {
      for (const key of hostile) {
        try { if (!inside(cache.prototype.getFilePath.call(ctx, key, kinds[kind]))) escapedOut++; } catch { refused++; }
      }
      good = cache.prototype.getFilePath.call(ctx, 'fine/page', kinds[kind]);
    }
  } finally { Object.assign(nodePath, saved); }
  const total = hostile.length * 3;
  if (escaped !== 'a%5Cb') report('FAIL', `next@${version}`, `a backslash in a path segment is not escaped (got ${JSON.stringify(escaped)}): this Next.js predates the Windows advisory fix (15.5.24)`);
  else if (escapedOut || refused !== total) report('FAIL', `next@${version}`, `${escapedOut} of ${total} hostile cache lookups resolved outside the cache folder under Windows path rules: this Next.js predates the fix (15.5.24)`);
  else report('PASS', `next@${version}`, `under Windows path rules all ${total} hostile cache lookups are refused, a plain one still resolves (${good}), and a backslash in a segment is escaped.\nThis is the code of the fix in 15.5.24, run on this computer's Node: it is not a run on a Windows host.`);
}

// ---- run ------------------------------------------------------------------------------------------------------------------------

const runs: Record<string, () => Promise<void>> = { google: checkGoogle, breach: checkBreach, captcha: checkCaptcha, argon2: checkArgon2, mail: checkMail, headers: checkHeaders, next: checkNext };
for (const name of ALL) {
  if (!only.has(name)) continue;
  try { await runs[name]!(); } catch (e) { report('FAIL', `${name}: the check itself broke`, message(e)); }
}
console.log(`\n${counts.PASS} passed, ${counts.WARN} warning(s), ${counts.FAIL} failed, ${counts.SKIP} skipped.`);
if (counts.WARN) console.log('A WARN is something this computer could not see or something to look at: read it, it is not a pass.');
process.exit(counts.FAIL ? 1 : 0);
