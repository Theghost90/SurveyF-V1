// The checker of docs/BACKLOG.md: `npm run backlog:check` (also part of `npm test`).
//   node scripts/backlog-check.mjs                regenerates nothing; fails on any problem listed in scripts/lib/backlog.mjs
//   node scripts/backlog-check.mjs --write        first rewrites the generated summary (counts and grid) from the tables
//   node scripts/backlog-check.mjs --base=<ref>   compares with the file on that git ref (default origin/main; skipped when there is none)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkBacklog, replaceSummary } from './lib/backlog.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const file = fileURLToPath(new URL('../docs/BACKLOG.md', import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

if (!existsSync(file)) { console.error('docs/BACKLOG.md does not exist'); process.exit(1); }
let md = readFileSync(file, 'utf8');
if (process.argv.includes('--write')) {
  const next = replaceSummary(md);
  if (next !== md) { writeFileSync(file, next); console.log('docs/BACKLOG.md: summary regenerated'); }
  md = next;
}

const inGit = git('rev-parse', '--git-dir').status === 0;
const ref = arg('base') ?? 'origin/main';
const notes = [];
let base = null;
if (inGit && !process.argv.includes('--no-base')) {
  const shown = git('show', `${ref}:docs/BACKLOG.md`);
  if (shown.status === 0) base = shown.stdout;
  else notes.push(`no earlier version of the file on ${ref}: nothing to compare with`);
} else notes.push('not a git checkout: nothing to compare with');

const { doc, errors, notes: more } = checkBacklog(md, {
  exists: (p) => existsSync(new URL(`../${p}`, import.meta.url)),
  commitExists: inGit ? (sha) => git('cat-file', '-e', `${sha}^{commit}`).status === 0 : () => null,
  base,
});
for (const n of [...notes, ...more]) console.log(`note: ${n}`);
for (const e of errors) console.error(`docs/BACKLOG.md${e.line ? `:${e.line}` : ''}: ${e.message}`);
const built = doc.register.filter((r) => r.state?.group === 'built').length;
if (errors.length) { console.error(`\nBacklog check: FAIL (${errors.length} problem${errors.length === 1 ? '' : 's'})`); process.exit(1); }
console.log(`Backlog check: PASS (${doc.register.length} rows, ${built} built, ${doc.register.length - built} not built; ${doc.risks.length} risk rows, ${doc.decisions.length} decisions, ${doc.changelog.length} change-log entries)`);
