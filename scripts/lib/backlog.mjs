/**
 * The living backlog (docs/BACKLOG.md) and the part of it a script can hold to account.
 *
 * The file is written by hand, in the same commit as the change it describes. This module reads its tables (each one is announced by a comment line,
 * `<!-- backlog:table built -->`) and fails when the file contradicts itself or the repository:
 *   - an ID appears twice, or a row misses its MoSCoW, size, state, marks or risk labels;
 *   - a "Built" row names no evidence, or names a test, migration or file that does not exist;
 *   - a row marked "Deferred by you" or moved to another MoSCoW class does not cite a decision on record (D-nn);
 *   - the numbers at the top (counts and the MoSCoW x size grid) are not what the tables add up to: they are generated, never typed (`--write`);
 *   - against the version on the base branch: a row disappeared, a Must item left Must without a decision, or the register changed
 *     without a change-log entry of at least the level the change deserves (new rows and size changes are major, anything touching a Must item is critical).
 * It cannot judge whether what the file says is true.
 */
export const MOSCOW = ['Must', 'Should', 'Could', "Won't"];
export const SIZES = ['Smaller', 'Small', 'Big', 'Bigger'];
export const RISK_LABELS = ['SEC', 'DATA', 'PAY', 'ABUSE', 'OPS', 'LEGAL', 'UX', 'COST'];
export const WAITING_ON = ['Code', 'You', 'Counsel', 'Provider', 'Meta', 'Host', 'Google'];
/** The kinds of ID in use. A new kind may be added by simply using it in the register; these stay policed even if their last row went. */
const ID_PREFIXES = ['SEC', 'DAT', 'LEG', 'PAY', 'WA', 'BIZ', 'OPS', 'ADM', 'DSN', 'DEF', 'FUT'];
export const LEVELS = ['minor', 'major', 'critical'];
export const STATES = [
  { key: 'built', label: 'Built', icon: '✅', group: 'built' },
  { key: 'builtopen', label: 'Built, check open', icon: '⚠️', group: 'built' },
  { key: 'notbuilt', label: 'Not built', icon: '⬜', group: 'notbuilt' },
  { key: 'action', label: 'Your action', icon: '🧑', group: 'notbuilt' },
  { key: 'deferred', label: 'Deferred by you', icon: '⏸', group: 'wont' },
  { key: 'next', label: 'Next version', icon: '🔭', group: 'wont' },
];
const GROUPS = ['built', 'notbuilt', 'wont'];
const REGISTER_COLUMNS = {
  built: ['ID', 'Item', 'MoSCoW', 'Size', 'State', 'Evidence', 'Open check', '⚖/📄'],
  notbuilt: ['ID', 'Item', 'MoSCoW', 'Size', 'State', 'Waiting on', '⚖/📄'],
  wont: ['ID', 'Item', 'MoSCoW', 'Size', 'State', '⚖/📄'],
};
const OTHER_COLUMNS = {
  risks: ['ID', 'Fixes', 'New risks', 'Containment'],
  decisions: ['Ref', 'Date', 'Decision', 'Source'],
  changelog: ['Date', 'Level', 'Change'],
};
const ID_RE = /^[A-Z]{2,3}-\d{2}[a-z]?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LABEL_RE = new RegExp(`\\b(?:${RISK_LABELS.join('|')})(?:/(?:${RISK_LABELS.join('|')}))*:`);
const SUMMARY_START = '<!-- backlog:summary:start -->';
const SUMMARY_END = '<!-- backlog:summary:end -->';

const plain = (s) => String(s ?? '').replace(/[*_`]/g, '').replace(/’/g, "'").trim();
/** "✅ Built" and "**Must**" are read as "Built" and "Must": leading symbols and emphasis do not count. */
const word = (s) => plain(s).replace(/^[^\p{L}]+/u, '').trim();
const isEmpty = (s) => ['', '-', '—', '–'].includes(plain(s));

function splitRow(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/** Reads every announced table and the generated summary. Problems that stop a table being read are returned as errors. */
export function parseBacklog(md) {
  const lines = md.split(/\r?\n/);
  const errors = [];
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^<!--\s*backlog:table\s+(\w+)\s*-->\s*$/);
    if (!m) continue;
    const kind = m[1];
    const wanted = REGISTER_COLUMNS[kind] ?? OTHER_COLUMNS[kind];
    if (!wanted) { errors.push({ line: i + 1, message: `unknown table kind "${kind}"` }); continue; }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (!lines[j]?.trim().startsWith('|') || !/^\s*\|?\s*:?-{3,}/.test(lines[j + 1] ?? '')) { errors.push({ line: i + 1, message: `the "${kind}" marker is not followed by a table` }); continue; }
    const headers = splitRow(lines[j]).map(plain);
    const missing = wanted.filter((c) => !headers.includes(c));
    if (missing.length) { errors.push({ line: j + 1, message: `the "${kind}" table lacks the column(s): ${missing.join(', ')}` }); continue; }
    const rows = [];
    for (let k = j + 2; k < lines.length && lines[k].trim().startsWith('|'); k++) {
      const cells = splitRow(lines[k]);
      if (cells.length !== headers.length) { errors.push({ line: k + 1, message: `the row has ${cells.length} cells, the header has ${headers.length} (a "|" inside a cell must be written \\|)` }); continue; }
      rows.push({ line: k + 1, cells: Object.fromEntries(headers.map((h, n) => [h, cells[n]])) });
    }
    tables.push({ kind, line: j + 1, rows });
  }

  const register = [];
  const risks = [];
  const decisions = [];
  const changelog = [];
  for (const t of tables) {
    for (const { line, cells } of t.rows) {
      if (GROUPS.includes(t.kind)) register.push(toRegisterRow(cells, t.kind, line));
      else if (t.kind === 'risks') risks.push({ line, ids: plain(cells.ID).split(/[,\s]+/).filter(Boolean), fixes: cells.Fixes, newRisks: cells['New risks'], containment: cells.Containment });
      else if (t.kind === 'decisions') decisions.push({ line, ref: plain(cells.Ref), date: plain(cells.Date), decision: cells.Decision, source: cells.Source });
      else changelog.push({ line, date: plain(cells.Date), level: plain(cells.Level).toLowerCase(), change: cells.Change });
    }
  }

  const start = lines.findIndex((l) => l.trim() === SUMMARY_START);
  const end = lines.findIndex((l) => l.trim() === SUMMARY_END);
  const summary = start >= 0 && end > start ? { start, end, text: lines.slice(start + 1, end).join('\n') } : null;
  return { lines, errors, tables, register, risks, decisions, changelog, summary };
}

function toRegisterRow(cells, group, line) {
  const label = word(cells.State).toLowerCase();
  const state = STATES.find((s) => s.label.toLowerCase() === label);
  const item = cells.Item ?? '';
  return {
    line, group,
    id: plain(cells.ID),
    item,
    moscow: word(cells.MoSCoW),
    size: word(cells.Size),
    stateText: cells.State,
    state,
    evidence: [...(cells.Evidence ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()),
    evidenceText: cells.Evidence ?? '',
    openCheck: cells['Open check'] ?? '',
    waitingOn: cells['Waiting on'] ?? '',
    marks: cells['⚖/📄'] ?? '',
    decisions: [...item.matchAll(/\bD-\d{2}\b/g)].map((m) => m[0]),
    was: item.match(/\bwas\s+(Must|Should|Could|Won['’]?t)\b/i)?.[1]?.replace(/Wont$/i, "Won't") ?? null,
  };
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

/** What is wrong inside the file (and against the repository, through `exists` and `commitExists`). Each problem: { line, message }. */
export function validate(doc, { exists = () => true, commitExists = () => null } = {}) {
  const errors = [...doc.errors];
  const add = (line, message) => errors.push({ line, message });
  const known = new Map();
  const decisionRefs = new Set(doc.decisions.map((d) => d.ref));

  for (const r of doc.register) {
    const at = (m) => add(r.line, `${r.id || '(no id)'}: ${m}`);
    if (!ID_RE.test(r.id)) { add(r.line, `"${r.id}" is not an ID such as SEC-07 or PAY-08a`); continue; }
    if (known.has(r.id)) at(`ID used twice (also on line ${known.get(r.id)})`); else known.set(r.id, r.line);
    if (isEmpty(r.item)) at('no item text');
    if (!MOSCOW.includes(r.moscow)) at(`MoSCoW must be one of ${MOSCOW.join(', ')}, not "${r.moscow}"`);
    if (!SIZES.includes(r.size)) at(`size must be one of ${SIZES.join(', ')}, not "${r.size}"`);
    if (isEmpty(r.marks) || (plain(r.marks).toLowerCase() !== 'none' && !/[⚖📄]/u.test(r.marks))) at('the ⚖/📄 cell must say "none" or carry ⚖ (lawyer) and/or 📄 (contract or third-party terms)');
    if (!r.state) { at(`state must be one of ${STATES.map((s) => `"${s.label}"`).join(', ')}, not "${plain(r.stateText)}"`); continue; }
    if (r.state.group !== r.group) at(`state "${r.state.label}" does not belong in the ${r.group} table`);
    if ((r.moscow === "Won't") !== (r.group === 'wont')) at(`a Won't row belongs in the wont table, and only those`);

    if (r.group === 'built') {
      if (!r.evidence.length) at('a Built row needs evidence: a test, a migration or a file, in backticks');
      for (const e of r.evidence) {
        const sha = e.match(/^commit:([0-9a-f]{7,40})$/i)?.[1];
        if (sha) { if (commitExists(sha) === false) at(`commit ${sha} is not in this repository (a squash or rebase removes commits: name a test or file instead)`); }
        else if (e.startsWith('/') || e.includes('..')) at(`evidence "${e}" must be a path inside the repository`);
        else if (!exists(e)) at(`evidence "${e}" does not exist`);
      }
      if (r.state.key === 'builtopen' && isEmpty(r.openCheck)) at('"Built, check open" must say in "Open check" what is still to be checked, and where');
    }
    if (r.group === 'notbuilt') {
      const waits = plain(r.waitingOn).split(/[,+/]/).map((s) => s.trim()).filter(Boolean);
      if (!waits.length) at(`"Waiting on" is empty (${WAITING_ON.join(', ')})`);
      for (const w of waits) if (!WAITING_ON.includes(w)) at(`"Waiting on" has "${w}": use ${WAITING_ON.join(', ')}`);
    }
    for (const ref of r.decisions) if (!decisionRefs.has(ref)) at(`cites ${ref}, which is not in the decisions table`);
    if (r.was) {
      if (cap(r.was) === r.moscow) at(`says "was ${r.was}" but it still is ${r.moscow}`);
      if (!r.decisions.length) at(`moved from ${cap(r.was)} to ${r.moscow} without a decision on record (cite D-nn)`);
    }
    if (r.state.key === 'deferred' && !r.decisions.length) at('"Deferred by you" must cite the decision (D-nn) in which you deferred it');
  }

  const ids = new Set(known.keys());
  const covered = new Map();
  for (const k of doc.risks) {
    if (!k.ids.length) add(k.line, 'risk row without an ID');
    for (const id of k.ids) {
      if (!ids.has(id)) add(k.line, `risk row for ${id}, which is not in the register`);
      else if (covered.has(id)) add(k.line, `${id} has two risk rows (also on line ${covered.get(id)})`);
      else covered.set(id, k.line);
    }
    if (!LABEL_RE.test(k.newRisks) && !/none notable/i.test(k.newRisks)) add(k.line, `${k.ids.join(', ')}: "New risks" needs a label (${RISK_LABELS.join(', ')}) followed by a colon, or "none notable"`);
    if (isEmpty(k.containment)) add(k.line, `${k.ids.join(', ')}: containment is empty`);
    if (isEmpty(k.fixes)) add(k.line, `${k.ids.join(', ')}: "Fixes" is empty`);
  }
  for (const id of ids) if (!covered.has(id)) add(known.get(id), `${id} has no row in the risks table`);

  const seenDecisions = new Set();
  for (const d of doc.decisions) {
    if (!/^D-\d{2}$/.test(d.ref)) add(d.line, `decision reference "${d.ref}" must look like D-07`);
    else if (seenDecisions.has(d.ref)) add(d.line, `${d.ref} used twice`); else seenDecisions.add(d.ref);
    if (!DATE_RE.test(d.date)) add(d.line, `${d.ref}: date must be YYYY-MM-DD`);
    if (isEmpty(d.decision) || isEmpty(d.source)) add(d.line, `${d.ref}: decision and source must both be filled in`);
  }

  let previous = '9999-99-99';
  for (const c of doc.changelog) {
    if (!DATE_RE.test(c.date)) add(c.line, 'change-log date must be YYYY-MM-DD');
    else if (c.date > previous) add(c.line, 'the change log is newest first: this entry is newer than the one above it');
    if (DATE_RE.test(c.date)) previous = c.date;
    if (!LEVELS.includes(c.level)) add(c.line, `change-log level must be ${LEVELS.join(', ')}, not "${c.level}"`);
    if (isEmpty(c.change)) add(c.line, 'change-log entry is empty');
  }
  if (!doc.changelog.length) add(null, 'the change log has no entry');

  // Every ID written anywhere in the text (but the change log, which keeps history) must exist; only the kinds of ID in use are looked at, so "UTF-16" is not an ID.
  const prefixes = new Set([...ID_PREFIXES, ...[...ids].map((id) => id.split('-')[0])]);
  const skip = new Set(doc.tables.filter((t) => t.kind === 'changelog').flatMap((t) => t.rows.map((r) => r.line)));
  doc.lines.forEach((text, n) => {
    if (skip.has(n + 1)) return;
    for (const m of text.matchAll(/\b([A-Z]{2,3})-(\d{2}[a-z]?)\b/g)) if (prefixes.has(m[1]) && !ids.has(m[0])) add(n + 1, `${m[0]} is written here but is not a row of the register`);
  });

  if (!doc.summary) add(null, `the generated summary is missing: put ${SUMMARY_START} and ${SUMMARY_END} where it belongs and run "npm run backlog:check -- --write"`);
  else if (normalize(doc.summary.text) !== normalize(generateSummary(doc.register))) add(doc.summary.start + 1, 'the summary is not what the tables add up to: run "npm run backlog:check -- --write" (the numbers are generated, never typed)');
  return errors;
}

const normalize = (s) => s.split('\n').map((l) => l.trimEnd()).join('\n').trim();

const stateMark = (r) => `${r.state?.icon ?? '?'} ${r.id}`;

/** The counts and the MoSCoW x size grid, computed from the register. The text between the summary markers must equal this. */
export function generateSummary(register) {
  const row = (m) => register.filter((r) => r.moscow === m);
  const built = (rs) => rs.filter((r) => r.state?.group === 'built').length;
  const label = (m) => (m === "Won't" ? "Won't this release" : m);
  const line = (name, rs) => `| ${name} | ${built(rs)} | ${rs.length - built(rs)} | ${rs.length} |`;
  const totalBuilt = built(register);
  const open = register.filter((r) => r.state?.key === 'builtopen').length;
  const out = [
    `**${register.length} rows: ${totalBuilt} built, ${register.length - totalBuilt} not built.** Of the built ones, ${open} still have a check open against a real service or device.`,
    '',
    '| | ✅ Built | ⬜ Not built | Total |',
    '|---|---|---|---|',
    ...MOSCOW.map((m) => line(label(m), row(m))),
    `| **All** | **${totalBuilt}** | **${register.length - totalBuilt}** | **${register.length}** |`,
    '',
    'Each ID in the grid carries its state: ✅ built · ⚠️ built, a check is open · ⬜ not built · 🧑 your action, no code · ⏸ deferred by you · 🔭 next version.',
    '',
    `| | ${SIZES.join(' | ')} |`,
    `|---|${SIZES.map(() => '---').join('|')}|`,
    ...MOSCOW.map((m) => `| **${label(m).toUpperCase()}** (${row(m).length}) | ${SIZES.map((s) => row(m).filter((r) => r.size === s).map(stateMark).join(', ') || 'none').join(' | ')} |`),
  ];
  return out.join('\n');
}

/** The file with the summary between its markers regenerated. */
export function replaceSummary(md) {
  const doc = parseBacklog(md);
  if (!doc.summary) throw new Error(`${SUMMARY_START} and ${SUMMARY_END} are missing`);
  const head = doc.lines.slice(0, doc.summary.start + 1);
  const tail = doc.lines.slice(doc.summary.end);
  return [...head, generateSummary(doc.register), ...tail].join('\n');
}

const rankOf = (level) => LEVELS.indexOf(level);
const sameRow = (a, b) => JSON.stringify([a.item, a.moscow, a.size, a.state?.key, a.evidence, a.openCheck, a.waitingOn, a.marks]) === JSON.stringify([b.item, b.moscow, b.size, b.state?.key, b.evidence, b.openCheck, b.waitingOn, b.marks]);

/**
 * The file against its earlier version (on the base branch). Nothing may disappear; a Must item may not leave Must, and no class may change, without a
 * decision on record (checked in `validate`); and any change to the register must come with a change-log entry that is new and at least as serious as the change.
 */
export function compareWithBase(doc, base) {
  const errors = [];
  const add = (line, message) => errors.push({ line, message });
  const now = new Map(doc.register.map((r) => [r.id, r]));
  const was = new Map(base.register.map((r) => [r.id, r]));
  let needed = -1;
  const need = (level) => { needed = Math.max(needed, rankOf(level)); };

  for (const [id, before] of was) {
    const after = now.get(id);
    if (!after) { add(null, `${id} is gone. Rows are never deleted: a dropped item becomes "Won't", with the decision cited`); need('critical'); continue; }
    if (before.moscow !== after.moscow) {
      need(before.moscow === 'Must' || after.moscow === 'Must' ? 'critical' : 'major');
      if (!after.decisions.length || cap(after.was) !== before.moscow) add(after.line, `${id} moved from ${before.moscow} to ${after.moscow}: its item text must say "was ${before.moscow}" and cite the decision (D-nn)`);
    }
    if (before.size !== after.size) need('major');
    const wasBuilt = before.state?.group === 'built', isBuilt = after.state?.group === 'built';
    if (wasBuilt !== isBuilt) need(before.moscow === 'Must' || after.moscow === 'Must' ? 'critical' : 'major');
    if (!sameRow(before, after)) need('minor');
  }
  for (const id of now.keys()) if (!was.has(id)) need('major');
  const baseRisks = new Map(base.risks.flatMap((k) => k.ids.map((id) => [id, JSON.stringify([k.fixes, k.newRisks, k.containment])])));
  for (const k of doc.risks) for (const id of k.ids) {
    const before = baseRisks.get(id);
    if (before === undefined) need('major');
    else if (before !== JSON.stringify([k.fixes, k.newRisks, k.containment])) need(now.get(id)?.moscow === 'Must' ? 'critical' : 'minor');
  }

  const baseLog = new Set(base.changelog.map((c) => `${c.date}|${c.level}|${plain(c.change)}`));
  const added = doc.changelog.filter((c) => !baseLog.has(`${c.date}|${c.level}|${plain(c.change)}`));
  if (needed >= 0) {
    const level = LEVELS[needed];
    const best = Math.max(-1, ...added.map((c) => rankOf(c.level)));
    if (!added.length) add(doc.changelog[0]?.line ?? null, `the register changed (${level} change) but the change log has no new entry`);
    else if (best < needed) add(added[0].line, `the register changed in a ${level} way; the new change-log entry is only ${LEVELS[best]}`);
  }
  return errors;
}

/** Everything the checker does, for a file's text. `base` is the text of the earlier version, when there is one. */
export function checkBacklog(md, { exists, commitExists, base } = {}) {
  const doc = parseBacklog(md);
  const errors = validate(doc, { exists, commitExists });
  if (base != null) {
    const before = parseBacklog(base);
    if (before.errors.length || !before.register.length) return { doc, errors, notes: ['the earlier version could not be read, so it was not compared'] };
    errors.push(...compareWithBase(doc, before));
  }
  return { doc, errors, notes: [] };
}
