/**
 * Proration on a plan change (PAY-12). A customer who moves up to a bigger plan before the one they paid for has ended used to lose the days they had left: the new plan
 * simply started and the old one was thrown away. Now the unused DAYS of what they paid are taken off the price of the new plan.
 *
 * Rules, in the order they matter (each one is a containment of "calculation errors", docs/BACKLOG.md):
 *  - whole days only, rounded DOWN: a day that has started is a day used, and the customer is never credited a fraction that rounding could turn into a gain;
 *  - never more than what was paid for the period, and never beyond the length of the period;
 *  - the new plan always costs at least `MIN_PAYABLE_SHARE` of its price (10 percent): a credit that could take a payment to zero would be a way into a plan for nothing
 *    (an annual customer who moves to a cheaper monthly one is the case), and a payment provider cannot take a zero or a few francs anyway;
 *  - nothing for the free plan, for a plan that has ended, or when the same plan is simply renewed (that extends the period; the days are not lost).
 * All amounts are whole CFA francs.
 */
export const MIN_PAYABLE_SHARE = 0.1;
const DAY = 86_400_000;

export interface ProrationInput {
  paidFCFA: number; // what was paid for the current period
  periodStart: Date;
  periodEnd: Date;
  now: Date;
  newPriceFCFA: number;
  minPayableShare?: number;
}

export function prorationCreditFCFA(i: ProrationInput): number {
  if (i.paidFCFA <= 0 || i.newPriceFCFA <= 0) return 0;
  const totalDays = Math.round((i.periodEnd.getTime() - i.periodStart.getTime()) / DAY);
  const wholeDaysLeft = Math.floor((i.periodEnd.getTime() - i.now.getTime()) / DAY);
  if (totalDays <= 0 || wholeDaysLeft <= 0) return 0;
  const unused = Math.floor(i.paidFCFA * Math.min(1, wholeDaysLeft / totalDays));
  const floor = Math.ceil(i.newPriceFCFA * (i.minPayableShare ?? MIN_PAYABLE_SHARE));
  return Math.max(0, Math.min(unused, i.paidFCFA, i.newPriceFCFA - floor));
}

/** Does moving to this plan replace the current period (so that its unused days would be lost) rather than extend it? Same plan = a renewal: it extends. */
export const replacesCurrentPeriod = (current: { plan: string; status: string; periodEnd: Date; paidFCFA: number }, newPlan: string, now: Date): boolean =>
  current.plan !== newPlan && current.status === 'active' && current.periodEnd.getTime() > now.getTime() && current.paidFCFA > 0;
