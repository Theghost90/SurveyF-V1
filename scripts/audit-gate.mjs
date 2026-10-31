// The release audit gate: `npm run audit:gate`. Fails when `npm audit --omit=dev` reports an advisory of high or critical severity that is not written down in
// docs/audit-allowlist.json (with a reason and an end date). Moderate and low ones are listed, not blocking. Run it before every release (`npm run release:check`).
//   node scripts/audit-gate.mjs [--level=moderate|high|critical] [--json]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate } from './lib/audit-gate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const level = arg('level') ?? 'high';
const asJson = process.argv.includes('--json');

const run = spawnSync('npm', ['audit', '--omit=dev', '--json'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
let report;
try { report = JSON.parse(run.stdout); } catch {
  console.error('npm audit gave no readable answer (is the npm registry reachable?):\n' + (run.stderr || run.stdout || '').slice(0, 800));
  process.exit(2);
}
if (report.error) { console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error).slice(0, 400)}`); process.exit(2); }

const allowFile = fileURLToPath(new URL('../docs/audit-allowlist.json', import.meta.url));
const allow = existsSync(allowFile) ? (JSON.parse(readFileSync(allowFile, 'utf8')).allow ?? []) : [];
const result = evaluate(report, allow, { level });

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const line = (a) => `  ${a.severity.padEnd(8)} ${a.id}  ${a.packages.join(', ')}: ${a.title}`;
  const meta = report.metadata?.vulnerabilities ?? {};
  console.log(`npm audit --omit=dev: ${meta.total ?? 0} vulnerable package(s) (critical ${meta.critical ?? 0}, high ${meta.high ?? 0}, moderate ${meta.moderate ?? 0}, low ${meta.low ?? 0}); gate level: ${level}`);
  if (result.allowed.length) console.log(`\nAllowed by docs/audit-allowlist.json (${result.allowed.length}):\n${result.allowed.map(line).join('\n')}`);
  if (result.below.length) console.log(`\nBelow the gate level (${result.below.length}):\n${result.below.map(line).join('\n')}`);
  if (result.unused.length) console.log(`\nAllowlist entries for advisories that no longer appear (remove them):\n${result.unused.map((a) => `  ${a.advisory}  ${a.package ?? ''}`).join('\n')}`);
  if (result.invalid.length) console.log(`\nAllowlist entries without an advisory id, a reason or a valid end date (they count for nothing):\n${result.invalid.map((a) => '  ' + JSON.stringify(a)).join('\n')}`);
  if (result.blocked.length) console.log(`\nBLOCKING (${result.blocked.length}): fix them, or write each into docs/audit-allowlist.json with a reason and an end date.\n${result.blocked.map((a) => line(a) + (result.expired.includes(a) ? '   [its exception has expired]' : '')).join('\n')}`);
  console.log(result.ok ? '\nAudit gate: PASS' : '\nAudit gate: FAIL');
}
process.exit(result.ok ? 0 : 1);
