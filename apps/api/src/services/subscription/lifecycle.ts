import { PAST_DUE_GRACE_DAYS } from '@surveyflow/shared';
import { prisma } from '../../lib/prisma';
import { addMonths } from '../payments/service';

/**
 * Subscription lifecycle: Explore (no clock) · paid active → past_due (3-day grace) → suspended (read-only until paid).
 * Idempotent: safe to run every few minutes, from any replica.
 *
 * Nobody keeps a free Starter. A paid plan that is cancelled and ends goes back to Explore (1 survey, 5 people, forever), with all of
 * its data. An unpaid plan is suspended after the grace and stays read-only until the owner pays.
 */
const EXPLORE_YEARS = 100;
/** Explore's usage window is the life of the account: far enough that nothing ever rolls it over. */
export const exploreWindowEnd = (from: Date) => addMonths(from, EXPLORE_YEARS * 12);

export async function runBillingLifecycle(now = new Date()) {
  const summary = { pastDue: 0, suspended: 0, cancelled: 0 };

  // 2. Paid subscriptions whose period ended.
  const ended = await prisma.subscription.findMany({ where: { status: 'active', amountFCFA: { gt: 0 }, currentPeriodEnd: { lt: now } } });
  for (const s of ended) {
    if (s.cancelAtPeriodEnd) {
      // Cancelled and over: back to Explore. The data stays; sending to more than 5 people needs a plan again.
      await prisma.$transaction([
        prisma.subscription.update({ where: { id: s.id }, data: { plan: 'trial', status: 'trial', amountFCFA: 0, paymentMethod: null, cancelAtPeriodEnd: false, graceEndsAt: null, currentPeriodStart: now, currentPeriodEnd: exploreWindowEnd(now) } }),
        prisma.user.update({ where: { id: s.userId }, data: { plan: 'trial' } }),
      ]);
      summary.cancelled++;
    } else {
      // Mobile Money has no card-on-file auto-debit, so "renewal" = the owner pays again during the grace window.
      await prisma.subscription.update({ where: { id: s.id }, data: { status: 'past_due', graceEndsAt: new Date(s.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * 86_400_000) } });
      summary.pastDue++;
    }
  }

  // 3. Grace window over.
  const suspended = await prisma.subscription.updateMany({ where: { status: 'past_due', graceEndsAt: { lt: now } }, data: { status: 'suspended' } });
  summary.suspended = suspended.count;

  // Abandoned checkouts are NOT expired here any more: a blind "pending for a day = expired" also expired payments that were paid behind a lost webhook.
  // services/payments/reconcile.ts asks the provider first and only then expires.
  return summary;
}
