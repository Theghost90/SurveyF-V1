/**
 * The decision of the release audit gate (scripts/audit-gate.mjs), kept apart from the part that runs `npm audit` so that it can be tested.
 *
 * `npm audit --omit=dev --json` lists vulnerabilities per package; each one names the advisories behind it (`via` entries that are objects with a url) or the
 * package it inherits them from (`via` entries that are strings). What matters for a release is the ADVISORIES: every advisory at or above the chosen severity
 * must either not exist or be written down, with a reason and an end date, in docs/audit-allowlist.json. An entry whose end date has passed counts for nothing,
 * so an exception is reviewed again instead of living for ever.
 */
export const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** The advisories of an `npm audit --json` report, once each, with the packages that carry them. */
export function advisoriesOf(report) {
  const found = new Map();
  for (const [pkg, v] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (!via || typeof via !== 'object' || !via.url) continue;
      const id = String(via.url).split('/').pop();
      const entry = found.get(id) ?? { id, title: via.title ?? '', severity: via.severity ?? 'high', range: via.range ?? '', packages: new Set() };
      entry.packages.add(via.name ?? pkg);
      found.set(id, entry);
    }
  }
  return [...found.values()].map((a) => ({ ...a, packages: [...a.packages].sort() }));
}

/**
 * @param report    parsed `npm audit --omit=dev --json`
 * @param allow     the "allow" array of docs/audit-allowlist.json: { advisory, package, reason, expires }
 * @param opts      { level: 'high' (default) | 'moderate' | ..., now: Date }
 * @returns         { blocked: advisories to fix, allowed: advisories covered by a live exception, expired: exceptions past their date that were still needed,
 *                    unused: live exceptions for advisories that no longer appear (tidy them away), invalid: exceptions without a reason or a date, below: advisories under the level }
 */
export function evaluate(report, allow = [], opts = {}) {
  const level = SEVERITY_RANK[opts.level ?? 'high'];
  const now = (opts.now ?? new Date()).getTime();
  const all = advisoriesOf(report);
  const invalid = allow.filter((a) => !a || !a.advisory || !String(a.reason ?? '').trim() || !Number.isFinite(Date.parse(a.expires)));
  const usable = allow.filter((a) => !invalid.includes(a));
  const live = usable.filter((a) => Date.parse(a.expires) >= now);
  const blocked = [], allowed = [], expired = [], below = [];
  for (const adv of all) {
    if ((SEVERITY_RANK[adv.severity] ?? 3) < level) { below.push(adv); continue; }
    if (live.some((a) => a.advisory === adv.id)) { allowed.push(adv); continue; }
    if (usable.some((a) => a.advisory === adv.id)) expired.push(adv);
    blocked.push(adv);
  }
  const seen = new Set(all.map((a) => a.id));
  const unused = live.filter((a) => !seen.has(a.advisory));
  return { blocked, allowed, expired, unused, invalid, below, ok: blocked.length === 0 && invalid.length === 0 };
}
