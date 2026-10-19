// Let someone test SurveyFlow over the internet, from this computer, with ONE command:   npm run share
//
//   - builds the app and starts it the way a server would (production build of the website, built API);
//   - forces demo mode: WhatsApp, payments and gifts are SIMULATED, whatever keys your .env holds (nothing real can be sent or charged);
//   - opens a public https address (a free Cloudflare "quick tunnel", no account) that points ONLY at the website;
//     the API stays private on this computer, reachable only through the website.
//
// Options:  --seed             (re)create the demo account (random password, printed) with sample data
//           --skip-build       reuse the last build (only if the code has not changed since)
//           --no-docker        Postgres and Redis are already running (otherwise `docker compose up -d` is run)
//           --public-url=URL   use your own public address (ngrok, a server...) instead of starting a Cloudflare tunnel
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

// ---- 1. prerequisites ----
if (Number(process.versions.node.split('.')[0]) < 20) die(`Node 20 or newer is required (you have ${process.versions.node}).`);
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
  if (spawnSync('cloudflared', ['--version'], { shell: win, stdio: 'ignore' }).status !== 0) {
    die('cloudflared (the free tunnel tool) is not installed.\n  Windows:  winget install --id Cloudflare.cloudflared   (then close and reopen this terminal)\n  macOS:    brew install cloudflared\n  Or use your own address:  npm run share -- --public-url=https://your-address');
  }
  say('Opening the public address...');
  publicUrl = await new Promise((resolve, reject) => {
    const t = start('tunnel', 'cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${WEB_PORT}`], { quiet: true });
    const timer = setTimeout(() => reject(new Error('timeout')), 60_000);
    const look = (d) => { const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(timer); resolve(m[0]); } };
    t.stdout.on('data', look); t.stderr.on('data', look);
  }).catch(() => die('The tunnel did not give an address within a minute. Check your internet connection and try again.'));
}

// ---- 7. API (private) and website ----
const demoEnv = {
  // Everything simulated, regardless of the keys in .env: a shared test instance must never send a real message or take real money.
  WHATSAPP_MODE: 'mock', PSP_MOCK: 'true', GIFT_PROVIDER: 'mock',
  INTERNAL_API_SECRET: fileEnv.INTERNAL_API_SECRET, JWT_SECRET: fileEnv.JWT_SECRET, NEXTAUTH_SECRET: fileEnv.NEXTAUTH_SECRET,
  DEV_GEO_COUNTRY: '', SF_DEMO: '1',
};
const apiEnv = { ...process.env, ...demoEnv, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(API_PORT), WEB_ORIGIN: publicUrl, PUBLIC_API_URL: publicUrl };
start('api', process.execPath, ['--env-file-if-exists=../../.env', 'dist/server.js'], { cwd: path.join(root, 'apps/api'), env: apiEnv });
const nextBin = createRequire(path.join(root, 'apps/web/package.json')).resolve('next/dist/bin/next');
const webEnv = { ...process.env, ...demoEnv, NODE_ENV: 'production', NEXTAUTH_URL: publicUrl, API_URL: `http://127.0.0.1:${API_PORT}` };
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
