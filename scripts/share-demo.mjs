// Let someone test SurveyFlow over the internet, from this computer, with ONE command:   npm run share
//
//   - builds the app and starts it the way a server would (production build of the website, built API);
//   - forces demo mode: WhatsApp, payments, gifts and e-mail are SIMULATED, whatever keys your .env holds (nothing real can be sent or charged);
//   - opens a public https address (a free Cloudflare "quick tunnel", no account) that points ONLY at the website;
//     the API stays private on this computer, reachable only through the website.
//
// Options:  --seed             (re)create the demo account (random password, printed) with sample data
//           --skip-build       reuse the last build (only if the code has not changed since)
//           --no-docker        Postgres and Redis are already running (otherwise `docker compose up -d` is run)
//           --public-url=URL   use your own public address (ngrok, a server...) instead of starting a Cloudflare tunnel
//           --i-accept-the-risk  Windows only, while the website framework has its known critical flaw (see below): share anyway
// Stop with Ctrl+C: the public address stops working immediately.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const WEB_PORT = Number(opt('web-port') ?? 4222), API_PORT = Number(opt('api-port') ?? 4223);
const win = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m = '') => console.log(m);
const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };
// .env is passed explicitly: Prisma's own search for it depends on the folder it is started from.
// NODE_ENV is NOT taken from .env here: a build started with NODE_ENV=development fails ("<Html> should not be imported outside of pages/_document").
const run = (cmd, a, env = {}) => { const { NODE_ENV: _ignored, ...fromFile } = fileEnv; const base = { ...fromFile, ...process.env }; if (base.NODE_ENV === 'development') delete base.NODE_ENV; return spawnSync(cmd, a, { cwd: root, stdio: 'inherit', shell: win, env: { ...base, ...env } }); };


/** cloudflared on the PATH, else where the Windows installer / winget / Homebrew put it (a terminal opened before the install does not have it on its PATH yet). */
function findCloudflared() {
  if (spawnSync('cloudflared', ['--version'], { shell: win, stdio: 'ignore' }).status === 0) return 'cloudflared';
  const pf = process.env.ProgramFiles, pf86 = process.env['ProgramFiles(x86)'], la = process.env.LOCALAPPDATA;
  const candidates = [
    pf86 && path.join(pf86, 'cloudflared', 'cloudflared.exe'),
    pf && path.join(pf, 'cloudflared', 'cloudflared.exe'),
    la && path.join(la, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
    la && path.join(la, 'Programs', 'cloudflared', 'cloudflared.exe'),
    '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared',
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

// ---- 1. prerequisites ----
// puppeteer 25 (PDF export) needs Node 22.12 or newer, and Prisma 7 needs 20.19, 22.12 or 24 and up; Node 20 reached end of life in April 2026.
{ const [maj, min] = process.versions.node.split('.').map(Number); if (maj < 22 || (maj === 22 && min < 12)) die(`Node 22.12 or newer is required (you have ${process.versions.node}). On Windows: winget install OpenJS.NodeJS.LTS, then close and reopen the terminal.`); }
// A critical flaw in the website framework (CVE-2026-75604, GHSA-p293-qw3h-jr36): on a WINDOWS computer, anybody who can reach the site can run code on it, with no login and no
// workaround but an upgrade (fixed in Next.js 15.5.24 and 16.3.3; 14.x never got a fix). A shared test site is exactly that situation, so this refuses to start there.
const nextVersion = (() => { try { return JSON.parse(readFileSync(path.join(root, 'node_modules/next/package.json'), 'utf8')).version; } catch { return null; } })();
const nextHasWindowsRce = (v) => {
  if (!v) return false;
  const [maj, min, pat] = v.split('-')[0].split('.').map(Number);
  if (maj < 13 || (maj === 13 && min < 4)) return false;
  if (maj <= 14) return true;
  if (maj === 15) return min < 5 || (min === 5 && pat < 24);
  if (maj === 16) return min < 3 || (min === 3 && pat < 3);
  return false;
};
if (win && nextHasWindowsRce(nextVersion) && !flag('i-accept-the-risk')) {
  die(`Sharing is blocked on Windows: this project uses Next.js ${nextVersion}, which has a critical remote-code-execution flaw on Windows servers (CVE-2026-75604, fixed only in 15.5.24 / 16.3.3).
  Anybody who found the address could run programs on this computer. Options: upgrade Next.js first (docs/SECURITY.md section 18), or run this command from WSL2 or a Linux machine,
  or, if you accept the risk for a few minutes with people you trust, add --i-accept-the-risk.`);
}
if (win && nextHasWindowsRce(nextVersion)) say(`⚠ Next.js ${nextVersion} has a known critical flaw on Windows servers (CVE-2026-75604). You chose to continue: stop the share as soon as the test is over.\n`);
const envFile = path.join(root, '.env');
if (!existsSync(envFile)) die('No .env file. Copy .env.example to .env first (cp .env.example .env).');
const readEnv = () => Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
let fileEnv = readEnv();
// The secrets a public site must not run without. Generated once and appended to .env (which is never committed).
const secret = () => randomBytes(36).toString('base64url');
const added = [];
for (const k of ['JWT_SECRET', 'NEXTAUTH_SECRET', 'INTERNAL_API_SECRET']) {
  if ((fileEnv[k] ?? '').length < 32) { const v = secret(); appendFileSync(envFile, `\n${k}=${v}\n`); added.push(k); }
}
if (added.length) { say(`Added ${added.join(', ')} to .env (new random values).`); fileEnv = readEnv(); }

// ---- 2. database and cache ----
for (const [name, port] of [['the API', API_PORT], ['the website', WEB_PORT]]) {
  if (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false)) die(`Something is already running on port ${port} (${name}). Stop "npm run dev" (Ctrl+C in its window) and run this again.`);
}
if (!flag('no-docker')) {
  say('Starting Postgres and Redis (docker compose up -d)...');
  if (run('docker', ['compose', 'up', '-d']).status !== 0) die('Docker did not start Postgres/Redis. Open Docker Desktop and try again (or start them yourself and add --no-docker).');
  for (let i = 0; i < 40; i++) {
    if (spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'pg_isready', '-U', 'surveyflow'], { cwd: root, shell: win, stdio: 'ignore' }).status === 0) break;
    if (i === 39) die('Postgres did not become ready in time.');
    await sleep(1500);
  }
}
say('Updating the database schema...');
if (run('npm', ['run', 'db:push']).status !== 0) die('The database schema could not be updated (see the message above).');

// ---- 3. build ----
if (!flag('skip-build')) {
  say('Building the app (a few minutes the first time)...');
  if (run('npm', ['run', 'build']).status !== 0) die('The build failed (see the message above).');
} else if (!existsSync(path.join(root, 'apps/web/.next')) || !existsSync(path.join(root, 'apps/api/dist/server.js'))) die('--skip-build needs an earlier build: run once without it.');

// ---- 4. demo account (optional) ----
let demoLogin = null;
if (flag('seed')) {
  const pw = randomBytes(9).toString('base64url');
  say('Creating the demo account...');
  if (run('npm', ['run', 'db:seed'], { SEED_DEMO_PASSWORD: pw }).status !== 0) die('Seeding failed (see the message above).');
  demoLogin = { email: 'demo@surveyflow.test', password: pw };
}

// ---- 5. children, stopped together ----
const logFile = path.join(root, 'share-demo.log');
const children = [];
let stopping = false;
const stopAll = (code = 0) => { if (stopping) return; stopping = true; say('\nStopping...'); for (const c of children) { try { c.kill(); } catch { /* already gone */ } } setTimeout(() => process.exit(code), 800); };
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
const start = (label, cmd, a, opts) => {
  const c = spawn(cmd, a, { cwd: opts.cwd ?? root, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Everything goes to share-demo.log; the console only shows problems (add --verbose to see it all).
  const tag = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => {
    appendFileSync(logFile, `[${label}] ${l}\n`);
    if (!opts.quiet && (flag('verbose') || /\b(ERROR|FATAL|WARN)\b|Error:|EADDRINUSE/.test(l))) console.log(`[${label}] ${l}`);
  });
  c.stdout.on('data', tag); c.stderr.on('data', tag);
  c.on('exit', (code) => { if (!stopping) { console.error(`\n✗ ${label} stopped unexpectedly (code ${code}).`); stopAll(1); } });
  children.push(c);
  return c;
};

// ---- 6. the public address ----
let publicUrl = opt('public-url')?.replace(/\/$/, '');
if (!publicUrl) {
  const cloudflared = findCloudflared();
  if (!cloudflared) {
    die('cloudflared (the free tunnel tool) was not found, neither on the terminal\'s PATH nor in its usual install folders.\n  Windows:  winget install --id Cloudflare.cloudflared   (then close ALL terminal windows and open a new one)\n  macOS:    brew install cloudflared\n  Or use your own address:  npm run share -- --public-url=https://your-address');
  }
  say(`Using ${cloudflared}`);
  say('Opening the public address...');
  publicUrl = await new Promise((resolve, reject) => {
    const t = start('tunnel', cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${WEB_PORT}`], { quiet: true });
    const timer = setTimeout(() => reject(new Error('timeout')), 60_000);
    const look = (d) => { const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(timer); resolve(m[0]); } };
    t.stdout.on('data', look); t.stderr.on('data', look);
  }).catch(() => die('The tunnel did not give an address within a minute. Check your internet connection and try again.'));
}

// ---- 7. API (private) and website ----
const demoEnv = {
  // Everything simulated, regardless of the keys in .env: a shared test instance must never send a real message or take real money.
  // E-mail too: the confirmation and reset messages are shown on the page (the mock mailbox) and nothing is ever sent to a real address.
  WHATSAPP_MODE: 'mock', PSP_MOCK: 'true', GIFT_PROVIDER: 'mock', EMAIL_PROVIDER: 'mock',
  INTERNAL_API_SECRET: fileEnv.INTERNAL_API_SECRET, JWT_SECRET: fileEnv.JWT_SECRET, NEXTAUTH_SECRET: fileEnv.NEXTAUTH_SECRET,
  DEV_GEO_COUNTRY: '', SF_DEMO: '1',
};
const apiEnv = { ...process.env, ...demoEnv, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(API_PORT), WEB_ORIGIN: publicUrl, PUBLIC_API_URL: publicUrl };
start('api', process.execPath, ['--env-file-if-exists=../../.env', 'dist/server.js'], { cwd: path.join(root, 'apps/api'), env: apiEnv });
const nextBin = createRequire(path.join(root, 'apps/web/package.json')).resolve('next/dist/bin/next');
// CLIENT_IP_HEADER: Cloudflare's tunnel puts the visitor's real address in this header; the sign-in limits and the security log are about the visitor, not about the tunnel.
const webEnv = { ...process.env, ...demoEnv, NODE_ENV: 'production', NEXTAUTH_URL: publicUrl, API_URL: `http://127.0.0.1:${API_PORT}`, CLIENT_IP_HEADER: 'cf-connecting-ip' };
start('web', process.execPath, [nextBin, 'start', '-p', String(WEB_PORT)], { cwd: path.join(root, 'apps/web'), env: webEnv });

const up = async (url, secs) => { for (let i = 0; i < secs; i++) { if (await fetch(url, { signal: AbortSignal.timeout(2500) }).then((r) => r.status < 500, () => false)) return true; await sleep(1000); } return false; };
if (!(await up(`http://127.0.0.1:${API_PORT}/healthz`, 60))) die('The API did not start (see the [api] lines above).');
if (!(await up(`http://127.0.0.1:${WEB_PORT}/`, 90))) die('The website did not start (see the [web] lines above).');
const reachable = await up(`${publicUrl}/`, 45);

say('\n=========================================================================');
say('  SurveyFlow is shared for testing');
say('=========================================================================');
say(`  Address for the tester:   ${publicUrl}`);
if (!reachable) say('  (the address did not answer yet from here: wait a minute, then open it yourself)');
if (demoLogin) say(`  Demo account:             ${demoLogin.email}  /  ${demoLogin.password}`);
say('  Everything is simulated: no real WhatsApp message, payment or gift.');
say('  Keep this window open and this computer awake. Ctrl+C stops the sharing.');
say(`  Technical log: ${logFile}`);
say('=========================================================================\n');
