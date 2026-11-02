import { describe, expect, it } from 'vitest';
import { addMonthsUTC, completedSlices, sliceAt } from './billing-slices';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

describe('months of a subscription period', () => {
  it('adds months without spilling over (Jan 31 + 1 month is the end of February)', () => {
    expect(iso(addMonthsUTC(d('2026-01-31'), 1))).toBe('2026-02-28');
    expect(iso(addMonthsUTC(d('2024-01-31'), 1))).toBe('2024-02-29');
    expect(iso(addMonthsUTC(d('2026-11-15'), 3))).toBe('2027-02-15');
  });
  it('a monthly period is one slice, which is the period itself', () => {
    const s = sliceAt(d('2026-11-01'), d('2026-12-01'), d('2026-11-20'));
    expect([iso(s.start), iso(s.end)]).toEqual(['2026-11-01', '2026-12-01']);
  });
  it('an annual period is twelve slices and `now` is in the right one', () => {
    const start = d('2026-01-10'), end = d('2027-01-10');
    expect(completedSlices(start, end, d('2027-02-01'))).toHaveLength(12);
    const s = sliceAt(start, end, d('2026-05-20'));
    expect([iso(s.start), iso(s.end)]).toEqual(['2026-05-10', '2026-06-10']);
    expect(completedSlices(start, end, d('2026-05-20')).map((x) => iso(x.start))).toEqual(['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10']);
  });
  it('an early renewal extends the period without changing a slice that is over', () => {
    const before = completedSlices(d('2026-11-01'), d('2026-12-01'), d('2026-12-05'));
    const after = completedSlices(d('2026-11-01'), d('2027-01-01'), d('2026-12-05'));
    expect(after.map((x) => [iso(x.start), iso(x.end)])).toEqual(before.map((x) => [iso(x.start), iso(x.end)]));
    const now = sliceAt(d('2026-11-01'), d('2027-01-01'), d('2026-12-05'));
    expect(iso(now.start)).toBe('2026-12-01');
  });
  it('slices are contiguous and never beyond the period', () => {
    const start = d('2026-01-31'), end = d('2027-01-31');
    const slices = completedSlices(start, end, d('2030-01-01'));
    expect(slices).toHaveLength(12);
    slices.forEach((s, i) => { if (i) expect(s.start.getTime()).toBe(slices[i - 1]!.end.getTime()); });
    expect(slices.at(-1)!.end.getTime()).toBe(end.getTime());
  });
  it('before the period began, or after it ended, still gives a usable slice', () => {
    expect(iso(sliceAt(d('2026-11-01'), d('2026-12-01'), d('2026-10-01')).start)).toBe('2026-11-01');
    expect(iso(sliceAt(d('2026-11-01'), d('2026-12-01'), d('2027-05-01')).start)).toBe('2026-11-01');
  });
});
