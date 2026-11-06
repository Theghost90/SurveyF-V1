import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advisoriesOf, evaluate } from '../lib/audit-gate.mjs';

/** The shape `npm audit --json` gives (auditReportVersion 2), cut down to what the gate reads. */
const advisory = (id, name, severity = 'high', title = `Flaw in ${name}`) => ({ source: 1, name, dependency: name, title, url: `https://github.com/advisories/${id}`, severity, range: '<9.9.9' });
const report = (...vulns) => ({
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries(vulns.map(([name, via]) => [name, { name, severity: 'high', via, effects: [], range: '<9.9.9', nodes: [`node_modules/${name}`], fixAvailable: true }])),
  metadata: { vulnerabilities: { total: vulns.length } },
});
const NOW = new Date('2026-10-28T12:00:00Z');
const later = '2027-01-31', earlier = '2026-10-01';
const entry = (advisory, extra = {}) => ({ advisory, package: 'foo', reason: 'Only reachable from a build step that never sees input', expires: later, ...extra });

test('a clean audit passes', () => {
  const r = evaluate({ vulnerabilities: {} }, [], { now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.blocked, []);
});

test('a high advisory blocks, and the id is the last part of its url', () => {
  const r = evaluate(report(['foo', [advisory('GHSA-aaaa-bbbb-cccc', 'foo')]]), [], { now: NOW });
  assert.equal(r.ok, false);
  assert.deepEqual(r.blocked.map((a) => a.id), ['GHSA-aaaa-bbbb-cccc']);
});

test('a package that only inherits (a string in via) adds nothing: the advisory is counted once, with every package that carries it', () => {
  const r = report(['foo', [advisory('GHSA-aaaa-bbbb-cccc', 'foo')]], ['bar', ['foo']], ['baz', [advisory('GHSA-aaaa-bbbb-cccc', 'foo')]]);
  const found = advisoriesOf(r);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].packages, ['foo']);
  assert.equal(evaluate(r, [], { now: NOW }).blocked.length, 1);
});

test('a written, unexpired exception lets it through, and says so', () => {
  const r = evaluate(report(['foo', [advisory('GHSA-aaaa-bbbb-cccc', 'foo')]]), [entry('GHSA-aaaa-bbbb-cccc')], { now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.allowed.map((a) => a.id), ['GHSA-aaaa-bbbb-cccc']);
  assert.deepEqual(r.blocked, []);
});

test('an exception past its end date counts for nothing, and the report says it expired', () => {
  const r = evaluate(report(['foo', [advisory('GHSA-aaaa-bbbb-cccc', 'foo')]]), [entry('GHSA-aaaa-bbbb-cccc', { expires: earlier })], { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.expired.length, 1);
});

test('an exception on the very last day still holds; the day after it does not', () => {
  const rep = report(['foo', [advisory('GHSA-aaaa-bbbb-cccc', 'foo')]]);
  const e = [entry('GHSA-aaaa-bbbb-cccc', { expires: '2026-10-28T23:59:59Z' })];
  assert.equal(evaluate(rep, e, { now: new Date('2026-10-28T23:00:00Z') }).ok, true);
  assert.equal(evaluate(rep, e, { now: new Date('2026-10-29T00:00:01Z') }).ok, false);
});

test('an exception without a reason, an advisory id or a readable end date is invalid, and an invalid entry fails the gate even when nothing is vulnerable', () => {
  for (const bad of [entry('GHSA-aaaa-bbbb-cccc', { reason: '  ' }), entry('', {}), entry('GHSA-aaaa-bbbb-cccc', { expires: 'someday' }), entry('GHSA-aaaa-bbbb-cccc', { expires: undefined })]) {
    const r = evaluate({ vulnerabilities: {} }, [bad], { now: NOW });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.invalid.length, 1);
  }
});

test('an invalid exception does not let its advisory through', () => {
  const r = evaluate(report(['foo', [advisory('GHSA-aaaa-bbbb-cccc', 'foo')]]), [entry('GHSA-aaaa-bbbb-cccc', { reason: '' })], { now: NOW });
  assert.equal(r.blocked.length, 1);
});

test('an exception for another advisory lets nothing else through', () => {
  const r = evaluate(report(['foo', [advisory('GHSA-aaaa-bbbb-cccc', 'foo')]]), [entry('GHSA-zzzz-zzzz-zzzz')], { now: NOW });
  assert.equal(r.ok, false);
  assert.deepEqual(r.unused.map((a) => a.advisory), ['GHSA-zzzz-zzzz-zzzz']);
});

test('a live exception for an advisory that no longer appears is listed as unused but does not fail', () => {
  const r = evaluate({ vulnerabilities: {} }, [entry('GHSA-aaaa-bbbb-cccc')], { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.unused.length, 1);
});

test('the level decides what blocks: moderate is listed at "high" and blocks at "moderate"; critical blocks at every level', () => {
  const rep = report(['foo', [advisory('GHSA-mmmm-mmmm-mmmm', 'foo', 'moderate')]], ['bar', [advisory('GHSA-cccc-cccc-cccc', 'bar', 'critical')]]);
  const atHigh = evaluate(rep, [], { now: NOW, level: 'high' });
  assert.deepEqual(atHigh.below.map((a) => a.id), ['GHSA-mmmm-mmmm-mmmm']);
  assert.deepEqual(atHigh.blocked.map((a) => a.id), ['GHSA-cccc-cccc-cccc']);
  const atModerate = evaluate(rep, [], { now: NOW, level: 'moderate' });
  assert.deepEqual(atModerate.blocked.map((a) => a.id).sort(), ['GHSA-cccc-cccc-cccc', 'GHSA-mmmm-mmmm-mmmm']);
  assert.equal(evaluate(report(['foo', [advisory('GHSA-llll-llll-llll', 'foo', 'low')]]), [], { now: NOW, level: 'high' }).ok, true);
});

test('an advisory with no severity is treated as high, never waved through', () => {
  const via = advisory('GHSA-aaaa-bbbb-cccc', 'foo'); delete via.severity;
  assert.equal(evaluate(report(['foo', [via]]), [], { now: NOW }).ok, false);
});

test('the shipped allowlist is valid JSON with only well-formed entries', async () => {
  const { readFileSync } = await import('node:fs');
  const file = JSON.parse(readFileSync(new URL('../../docs/audit-allowlist.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(file.allow));
  assert.equal(evaluate({ vulnerabilities: {} }, file.allow, { now: NOW }).invalid.length, 0);
});
