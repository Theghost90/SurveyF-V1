import { describe, expect, it } from 'vitest';
import { MIN_PAYABLE_SHARE, prorationCreditFCFA, replacesCurrentPeriod } from './proration';

const D = 86_400_000;
const start = new Date('2026-11-01T00:00:00Z');
const end = new Date('2026-12-01T00:00:00Z'); // 30 days
const at = (days: number) => new Date(start.getTime() + days * D);
const base = { paidFCFA: 14_500, periodStart: start, periodEnd: end, newPriceFCFA: 39_000 };

describe('credit for the days that are left', () => {
  it('is the unused days of what was paid, in whole days', () => {
    expect(prorationCreditFCFA({ ...base, now: at(0) })).toBe(14_500); // nothing used yet: all of it (the floor of the new price is far below)
    expect(prorationCreditFCFA({ ...base, now: at(15) })).toBe(7_250);
    expect(prorationCreditFCFA({ ...base, now: at(29) })).toBe(Math.floor(14_500 / 30));
  });
  it('a day that has started counts as used (rounded down, never a fraction in the customer\'s favour)', () => {
    expect(prorationCreditFCFA({ ...base, now: new Date(at(15).getTime() + 3600_000) })).toBe(Math.floor(14_500 * (14 / 30)));
    expect(prorationCreditFCFA({ ...base, now: new Date(end.getTime() - 3600_000) })).toBe(0); // less than a whole day left
  });
  it('is nothing when the period is over, was free, or the dates make no sense', () => {
    expect(prorationCreditFCFA({ ...base, now: end })).toBe(0);
    expect(prorationCreditFCFA({ ...base, now: at(40) })).toBe(0);
    expect(prorationCreditFCFA({ ...base, paidFCFA: 0, now: at(5) })).toBe(0);
    expect(prorationCreditFCFA({ ...base, periodEnd: start, now: at(5) })).toBe(0);
    expect(prorationCreditFCFA({ ...base, newPriceFCFA: 0, now: at(5) })).toBe(0);
  });
  it('can never take the new plan below ten percent of its price, however much was paid', () => {
    const annual = { paidFCFA: 159_500, periodStart: start, periodEnd: new Date(start.getTime() + 365 * D), newPriceFCFA: 39_000 };
    const credit = prorationCreditFCFA({ ...annual, now: at(10) });
    expect(credit).toBe(39_000 - Math.ceil(39_000 * MIN_PAYABLE_SHARE));
    expect(39_000 - credit).toBeGreaterThanOrEqual(3_900);
  });
  it('can never exceed what was paid', () => {
    for (let d = 0; d <= 30; d++) expect(prorationCreditFCFA({ ...base, now: at(d) })).toBeLessThanOrEqual(14_500);
  });
  it('never goes up as the days pass (no day is worth more than the one before)', () => {
    let prev = Infinity;
    for (let d = 0; d <= 31; d++) { const c = prorationCreditFCFA({ ...base, now: at(d) }); expect(c).toBeLessThanOrEqual(prev); prev = c; }
  });
  it('always an integer', () => {
    for (let d = 0; d <= 30; d++) expect(Number.isInteger(prorationCreditFCFA({ ...base, paidFCFA: 14_567, now: at(d) }))).toBe(true);
  });
});

describe('when the days would be lost', () => {
  const cur = { plan: 'starter', status: 'active', periodEnd: end, paidFCFA: 14_500 };
  it('a move to another plan replaces the period', () => expect(replacesCurrentPeriod(cur, 'growth', at(5))).toBe(true));
  it('the same plan is a renewal, which extends: nothing is lost, nothing is credited', () => expect(replacesCurrentPeriod(cur, 'starter', at(5))).toBe(false));
  it('a plan that has ended, is past due, or was free has nothing to credit', () => {
    expect(replacesCurrentPeriod(cur, 'growth', at(31))).toBe(false);
    expect(replacesCurrentPeriod({ ...cur, status: 'past_due' }, 'growth', at(5))).toBe(false);
    expect(replacesCurrentPeriod({ ...cur, paidFCFA: 0 }, 'growth', at(5))).toBe(false);
  });
});
