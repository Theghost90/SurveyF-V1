import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkBacklog, generateSummary, parseBacklog, replaceSummary } from '../lib/backlog.mjs';

const HEAD = {
  built: '| ID | Item | MoSCoW | Size | State | Evidence | Open check | ⚖/📄 |\n|---|---|---|---|---|---|---|---|',
  notbuilt: '| ID | Item | MoSCoW | Size | State | Waiting on | ⚖/📄 |\n|---|---|---|---|---|---|---|',
  wont: '| ID | Item | MoSCoW | Size | State | ⚖/📄 |\n|---|---|---|---|---|---|',
  risks: '| ID | Fixes | New risks | Containment |\n|---|---|---|---|',
  decisions: '| Ref | Date | Decision | Source |\n|---|---|---|---|',
  changelog: '| Date | Level | Change |\n|---|---|---|',
};
const DEFAULTS = {
  built: [
    '| SEC-02 | Password reset | Must | Small | ✅ Built | `apps/api/tests/a.test.ts` | — | none |',
    '| SEC-01 | E-mail, needs nothing | Must | Big | ⚠️ Built, check open | `apps/api/tests/a.test.ts`, `apps/api/prisma/migrations/m1` | no real provider has been used | 📄 provider |',
  ],
  notbuilt: [
    '| PAY-13 | Payout limits | Must | Small | ⬜ Not built | Code | none |',
    '| LEG-01 | Privacy policy, after SEC-01 | Must | Bigger | 🧑 Your action | Counsel, You | ⚖ |',
  ],
  wont: [
    '| DEF-01 | Public holidays (D-01) | Won\'t | Small | ⏸ Deferred by you | none |',
    '| FUT-01 | Builder bot | Won\'t | Bigger | 🔭 Next version | none |',
  ],
  risks: [
    '| SEC-02, SEC-01 | Takeover | SEC: reset becomes the route. OPS: undelivered mail | Hashed tokens |',
    '| PAY-13 | Cash-out | PAY: a cap blocks an honest owner | Caps per account |',
    '| LEG-01 | No counsel text | LEGAL: promises beyond the product | Facts sheet |',
    '| DEF-01, FUT-01 | Gaps | none notable | Later |',
  ],
  decisions: ['| D-01 | 2026-10-20 | Deferred public holidays | "I confirm DEFERRED BY YOU items" |'],
  changelog: ['| 2026-10-28 | major | First version | '],
};

/** A small, consistent backlog; `over` replaces any group of rows. The summary is generated, like in the real file. */
const make = (over = {}) => {
  const g = { ...DEFAULTS, ...over };
  const table = (kind) => `<!-- backlog:table ${kind} -->\n${HEAD[kind]}\n${g[kind].join('\n')}\n`;
  const md = `# Backlog\n\n<!-- backlog:summary:start -->\n<!-- backlog:summary:end -->\n\n${['built', 'notbuilt', 'wont', 'risks', 'decisions', 'changelog'].map(table).join('\n')}`;
  return replaceSummary(md);
};
const FILES = new Set(['apps/api/tests/a.test.ts', 'apps/api/prisma/migrations/m1']);
const run = (md, extra = {}) => checkBacklog(md, { exists: (p) => FILES.has(p), ...extra }).errors.map((e) => e.message);
const withRow = (group, id, replacement) => DEFAULTS[group].map((r) => (r.startsWith(`| ${id} `) ? replacement : r));
const failsWith = (messages, pattern) => assert.ok(messages.some((m) => pattern.test(m)), `expected a message matching ${pattern}, got:\n${messages.join('\n') || '(none)'}`);

test('a consistent file passes', () => {
  assert.deepEqual(run(make()), []);
});

test('an ID used twice is refused, wherever the second use is', () => {
  failsWith(run(make({ notbuilt: [...DEFAULTS.notbuilt, '| SEC-02 | Again | Must | Small | ⬜ Not built | Code | none |'] })), /SEC-02: ID used twice/);
});

test('MoSCoW, size, state and the ⚖/📄 cell must come from the lists', () => {
  failsWith(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits | Maybe | Small | ⬜ Not built | Code | none |') })), /MoSCoW must be one of/);
  failsWith(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits | Must | Medium | ⬜ Not built | Code | none |') })), /size must be one of/);
  failsWith(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits | Must | Small | Soon | Code | none |') })), /state must be one of/);
  failsWith(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits | Must | Small | ⬜ Not built | Code | — |') })), /⚖\/📄 cell must say "none"/);
  failsWith(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits | Must | Small | ⬜ Not built | Code | maybe a lawyer |') })), /⚖\/📄 cell must say "none"/);
  failsWith(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 |  | Must | Small | ⬜ Not built | Code | none |') })), /no item text/);
});

test('emphasis and a leading symbol do not change what a cell says', () => {
  assert.deepEqual(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| **PAY-13** | Payout limits | **Must** | Small | ⬜ **Not built** | Code | none |') })), []);
});

test('a Built row needs evidence, and the evidence must exist', () => {
  failsWith(run(make({ built: withRow('built', 'SEC-02', '| SEC-02 | Password reset | Must | Small | ✅ Built | — | — | none |') })), /needs evidence/);
  failsWith(run(make({ built: withRow('built', 'SEC-02', '| SEC-02 | Password reset | Must | Small | ✅ Built | `apps/api/tests/gone.test.ts` | — | none |') })), /evidence "apps\/api\/tests\/gone\.test\.ts" does not exist/);
  failsWith(run(make({ built: withRow('built', 'SEC-02', '| SEC-02 | Password reset | Must | Small | ✅ Built | no backticks here | — | none |') })), /needs evidence/);
  failsWith(run(make({ built: withRow('built', 'SEC-02', '| SEC-02 | Password reset | Must | Small | ✅ Built | `../outside.txt` | — | none |') })), /path inside the repository/);
});

test('one missing file is enough, even when another piece of evidence exists', () => {
  failsWith(run(make({ built: withRow('built', 'SEC-02', '| SEC-02 | Password reset | Must | Small | ✅ Built | `apps/api/tests/a.test.ts`, `apps/api/tests/b.test.ts` | — | none |') })), /b\.test\.ts" does not exist/);
});

test('a commit named as evidence is looked up; one that is gone is reported with the advice to name a file', () => {
  const md = make({ built: withRow('built', 'SEC-02', '| SEC-02 | Password reset | Must | Small | ✅ Built | `commit:abc1234` | — | none |') });
  failsWith(run(md, { commitExists: () => false }), /commit abc1234 is not in this repository/);
  assert.deepEqual(run(md, { commitExists: () => true }), []);
  assert.deepEqual(run(md, { commitExists: () => null }), []); // not a git checkout: not judged
});

test('"Built, check open" must say what is open; a Not built row must say who it waits on, from the list', () => {
  failsWith(run(make({ built: withRow('built', 'SEC-01', '| SEC-01 | E-mail | Must | Big | ⚠️ Built, check open | `apps/api/tests/a.test.ts` | — | 📄 provider |') })), /must say in "Open check"/);
  failsWith(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits | Must | Small | ⬜ Not built | | none |') })), /"Waiting on" is empty/);
  failsWith(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits | Must | Small | ⬜ Not built | The bank | none |') })), /"Waiting on" has "The bank"/);
});

test('a row sits in the table of its state, and Won\'t rows only in the wont table', () => {
  failsWith(run(make({ notbuilt: [...DEFAULTS.notbuilt, '| SEC-03 | Sessions | Must | Small | ✅ Built | Code | none |'] })), /state "Built" does not belong in the notbuilt table/);
  failsWith(run(make({ built: [...DEFAULTS.built, '| SEC-03 | Sessions | Won\'t | Small | ✅ Built | `apps/api/tests/a.test.ts` | — | none |'] })), /Won't row belongs in the wont table/);
  failsWith(run(make({ wont: [...DEFAULTS.wont, '| SEC-03 | Sessions | Must | Small | 🔭 Next version | none |'] })), /Won't row belongs in the wont table/);
});

test('"Deferred by you" cites a decision that exists; a "was" needs one too', () => {
  failsWith(run(make({ wont: withRow('wont', 'DEF-01', '| DEF-01 | Public holidays | Won\'t | Small | ⏸ Deferred by you | none |') })), /must cite the decision/);
  failsWith(run(make({ wont: withRow('wont', 'DEF-01', '| DEF-01 | Public holidays (D-09) | Won\'t | Small | ⏸ Deferred by you | none |') })), /cites D-09, which is not in the decisions table/);
  failsWith(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits (was Should) | Must | Small | ⬜ Not built | Code | none |') })), /moved from Should to Must without a decision on record/);
  failsWith(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits (D-01, was Must) | Must | Small | ⬜ Not built | Code | none |') })), /says "was Must" but it still is Must/);
  assert.deepEqual(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits (D-01, was Should) | Must | Small | ⬜ Not built | Code | none |') })), []);
});

test('every row has exactly one risk row, with a label (or "none notable") and a containment', () => {
  failsWith(run(make({ risks: DEFAULTS.risks.filter((r) => !r.includes('LEG-01')) })), /LEG-01 has no row in the risks table/);
  failsWith(run(make({ risks: [...DEFAULTS.risks, '| SEC-77 | x | SEC: y | z |'] })), /risk row for SEC-77, which is not in the register/);
  failsWith(run(make({ risks: [...DEFAULTS.risks, '| PAY-13 | x | PAY: y | z |'] })), /PAY-13 has two risk rows/);
  failsWith(run(make({ risks: DEFAULTS.risks.map((r) => (r.startsWith('| LEG-01') ? '| LEG-01 | No counsel text | promises beyond the product | Facts sheet |' : r)) })), /"New risks" needs a label/);
  failsWith(run(make({ risks: DEFAULTS.risks.map((r) => (r.startsWith('| LEG-01') ? '| LEG-01 | No counsel text | LEGAL: promises | |' : r)) })), /containment is empty/);
  assert.deepEqual(run(make({ risks: DEFAULTS.risks.map((r) => (r.startsWith('| LEG-01') ? '| LEG-01 | No counsel text | LEGAL/UX: promises | Facts sheet |' : r)) })), []);
});

test('an ID written in the text must exist, except in the change log; a different kind of token is not an ID', () => {
  failsWith(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits, needs ADM-01 | Must | Small | ⬜ Not built | Code | none |') })), /ADM-01 is written here but is not a row/);
  failsWith(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits, needs SEC-99 | Must | Small | ⬜ Not built | Code | none |') })), /SEC-99 is written here/);
  assert.deepEqual(run(make({ changelog: ['| 2026-10-28 | major | Split SEC-99 from SEC-98 and dropped UTF-16 | '] })), []);
  assert.deepEqual(run(make({ notbuilt: withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits, UTF-16 and CVE-2026-75604 and SHA-256 | Must | Small | ⬜ Not built | Code | none |') })), []);
});

test('the summary is generated: the counts are what the tables add up to, and a stale one is refused', () => {
  const doc = parseBacklog(make());
  const text = generateSummary(doc.register);
  assert.match(text, /\*\*6 rows: 2 built, 4 not built\.\*\* Of the built ones, 1 still have a check open/);
  assert.match(text, /\| Must \| 2 \| 2 \| 4 \|/);
  assert.match(text, /\| Won't this release \| 0 \| 2 \| 2 \|/);
  assert.match(text, /\| \*\*All\*\* \| \*\*2\*\* \| \*\*4\*\* \| \*\*6\*\* \|/);
  assert.match(text, /\| \*\*MUST\*\* \(4\) \| none \| ✅ SEC-02, ⬜ PAY-13 \| ⚠️ SEC-01 \| 🧑 LEG-01 \|/);
  const typed = make().replace('2 built, 4 not built', '3 built, 3 not built');
  failsWith(run(typed), /summary is not what the tables add up to/);
  assert.deepEqual(run(replaceSummary(typed)), []);
  failsWith(run('# no markers\n'), /generated summary is missing/);
});

test('a row with the wrong number of cells is named by its line', () => {
  const md = make({ notbuilt: [...DEFAULTS.notbuilt, '| SEC-03 | Sessions | Must | Small | ⬜ Not built | Code | none | extra |'] });
  const errors = checkBacklog(md, { exists: () => true }).errors;
  assert.ok(errors.some((e) => e.line > 0 && /the row has 8 cells, the header has 7/.test(e.message)), JSON.stringify(errors));
});

test('a table that lacks a column, or a marker with no table, is reported', () => {
  failsWith(run(make().replace('| ID | Item | MoSCoW | Size | State | Waiting on | ⚖/📄 |', '| ID | Item | MoSCoW | Size | State | ⚖/📄 |').replace('|---|---|---|---|---|---|---|\n| PAY-13', '|---|---|---|---|---|---|\n| PAY-13')), /lacks the column\(s\): Waiting on/);
  failsWith(run(make().replace('<!-- backlog:table wont -->\n', '<!-- backlog:table wont -->\nno table here\n')), /marker is not followed by a table/);
  failsWith(run(make().replace('backlog:table wont', 'backlog:table nonsense')), /unknown table kind "nonsense"/);
});

test('the change log is newest first, tagged minor, major or critical, and never empty', () => {
  failsWith(run(make({ changelog: ['| 2026-10-20 | major | Older | ', '| 2026-10-28 | major | Newer | '] })), /newest first/);
  failsWith(run(make({ changelog: ['| 2026-10-28 | huge | Something | '] })), /level must be minor, major, critical/);
  failsWith(run(make({ changelog: ['| yesterday | minor | Something | '] })), /date must be YYYY-MM-DD/);
  failsWith(run(make({ changelog: [] })), /change log has no entry/);
});

test('a decision needs a reference, a date, the decision and its source', () => {
  failsWith(run(make({ decisions: ['| D-1 | 2026-10-20 | x | y |'] })), /must look like D-07/);
  failsWith(run(make({ decisions: [...DEFAULTS.decisions, '| D-01 | 2026-10-21 | again | y |'] })), /D-01 used twice/);
  failsWith(run(make({ decisions: ['| D-01 | 20 Oct | x | y |'] })), /date must be YYYY-MM-DD/);
  failsWith(run(make({ decisions: ['| D-01 | 2026-10-20 | x | |'] })), /decision and source must both be filled in/);
});

// --- against the earlier version (the base branch) ---

const base = make();
const vs = (now) => run(now, { base });

test('against the base: nothing changed, nothing needed', () => {
  assert.deepEqual(vs(make()), []);
});

test('against the base: a row that disappeared is refused, and it counts as critical', () => {
  const now = make({ wont: DEFAULTS.wont.filter((r) => !r.includes('FUT-01')), risks: DEFAULTS.risks.map((r) => r.replace('DEF-01, FUT-01', 'DEF-01')), changelog: ['| 2026-10-29 | critical | Dropped FUT-01 | ', ...DEFAULTS.changelog] });
  failsWith(vs(now), /FUT-01 is gone\. Rows are never deleted/);
});

test('against the base: a Must item leaving Must needs "was Must", a decision, and a critical entry', () => {
  const moved = '| PAY-13 | Payout limits (was Must) | Should | Small | ⬜ Not built | Code | none |';
  failsWith(vs(make({ notbuilt: withRow('notbuilt', 'PAY-13', moved) })), /moved from Must to Should without a decision on record/);
  const decided = '| PAY-13 | Payout limits (D-01, was Must) | Should | Small | ⬜ Not built | Code | none |';
  failsWith(vs(make({ notbuilt: withRow('notbuilt', 'PAY-13', decided), changelog: ['| 2026-10-29 | major | Moved PAY-13 | ', ...DEFAULTS.changelog] })), /critical way; the new change-log entry is only major/);
  assert.deepEqual(vs(make({ notbuilt: withRow('notbuilt', 'PAY-13', decided), changelog: ['| 2026-10-29 | critical | Moved PAY-13 | ', ...DEFAULTS.changelog] })), []);
  const silent = '| PAY-13 | Payout limits (D-01) | Should | Small | ⬜ Not built | Code | none |';
  failsWith(vs(make({ notbuilt: withRow('notbuilt', 'PAY-13', silent), changelog: ['| 2026-10-29 | critical | Moved | ', ...DEFAULTS.changelog] })), /its item text must say "was Must"/);
});

test('against the base: a change to the register needs a new change-log entry, and one as serious as the change', () => {
  const sized = withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits | Must | Big | ⬜ Not built | Code | none |');
  failsWith(vs(make({ notbuilt: sized })), /the register changed \(major change\) but the change log has no new entry/);
  failsWith(vs(make({ notbuilt: sized, changelog: ['| 2026-10-29 | minor | Resized | ', ...DEFAULTS.changelog] })), /major way; the new change-log entry is only minor/);
  assert.deepEqual(vs(make({ notbuilt: sized, changelog: ['| 2026-10-29 | major | Resized | ', ...DEFAULTS.changelog] })), []);
  assert.deepEqual(vs(make({ notbuilt: sized, changelog: ['| 2026-10-29 | critical | Resized | ', ...DEFAULTS.changelog] })), []);
});

test('against the base: a new row is a major change, a text edit is minor, a Must item turning from built to not built is critical', () => {
  const added = [...DEFAULTS.notbuilt, '| WA-03 | Message category | Must | Big | ⬜ Not built | Code | none |'];
  const risks = [...DEFAULTS.risks, '| WA-03 | Wrong cost | COST: marketing is dearer | Default to marketing |'];
  failsWith(vs(make({ notbuilt: added, risks, changelog: ['| 2026-10-29 | minor | Added WA-03 | ', ...DEFAULTS.changelog] })), /major way; the new change-log entry is only minor/);
  assert.deepEqual(vs(make({ notbuilt: added, risks, changelog: ['| 2026-10-29 | major | Added WA-03 | ', ...DEFAULTS.changelog] })), []);

  const edited = withRow('notbuilt', 'PAY-13', '| PAY-13 | Payout limits per account and per phone | Must | Small | ⬜ Not built | Code | none |');
  failsWith(vs(make({ notbuilt: edited })), /minor change\) but the change log has no new entry/);
  assert.deepEqual(vs(make({ notbuilt: edited, changelog: ['| 2026-10-29 | minor | Reworded | ', ...DEFAULTS.changelog] })), []);

  const regress = withRow('built', 'SEC-02', '| SEC-02 | Password reset | Must | Small | ⬜ Not built | Code | none |');
  const nowBuilt = DEFAULTS.built.filter((r) => !r.startsWith('| SEC-02 '));
  const regressed = make({ built: nowBuilt, notbuilt: [...DEFAULTS.notbuilt, '| SEC-02 | Password reset | Must | Small | ⬜ Not built | Code | none |'], changelog: ['| 2026-10-29 | major | Reset removed | ', ...DEFAULTS.changelog] });
  assert.ok(regress.length);
  failsWith(vs(regressed), /critical way; the new change-log entry is only major/);
});

test('against the base: a change in the risks of a Must item is critical, in another it is minor', () => {
  const must = DEFAULTS.risks.map((r) => (r.startsWith('| LEG-01') ? '| LEG-01 | No counsel text | LEGAL: promises beyond the product. COST: fees | Facts sheet |' : r));
  failsWith(vs(make({ risks: must, changelog: ['| 2026-10-29 | major | Risk added | ', ...DEFAULTS.changelog] })), /critical way/);
  const other = DEFAULTS.risks.map((r) => (r.startsWith('| DEF-01') ? '| DEF-01, FUT-01 | Gaps | none notable | Later, with data |' : r));
  assert.deepEqual(vs(make({ risks: other, changelog: ['| 2026-10-29 | minor | Containment | ', ...DEFAULTS.changelog] })), []);
});

test('against a base that cannot be read, the file is checked on its own and a note says so', () => {
  const result = checkBacklog(make(), { exists: (p) => FILES.has(p), base: '# not a backlog' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.notes.length, 1);
});
