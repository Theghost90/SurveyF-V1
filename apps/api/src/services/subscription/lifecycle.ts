import { PAST_DUE_GRACE_DAYS } from '@surveyflow/shared';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { addMonths } from '../payments/service';

/**
 * Subscription lifecycle: trial (14d) → active → past_due (3-day grace) → suspended → cancelled.
 * Idempotent: safe to run every few minutes, from any replica.
 *
 * Unpaid trial end: the spec says "auto-downgrade to Starter if no payment method added". Starter is a PAID plan
 * (9,500 FCFA) and the lifecycle says unpaid → suspended, so these two statements conflict. Implemented as written
 * (TRIAL_EXPIRY_POLICY=starter): the account drops to Starter LIMITS at no charge — in effect a permanent free tier.
 * TRIAL_EXPIRY_POLICY=suspend makes the account read-only until it pays. See docs/DECISIONS.md.
 */
export async function runBillingLifecycle(now = new Date()) {
  const summary = { trialsExpired: 0, pastDue: 0, suspended: 0, cancelled: 0, rolled: 0, txExpired: 0 };

  // 1. Trials that ended without payment.
  const trials = await prisma.subscription.findMany({ where: { status: 'trial', currentPeriodEnd: { lt: now } } });
  for (const s of trials) {
    if (env.TRIAL_EXPIRY_POLICY === 'suspend') {
      await prisma.subscription.update({ where: { id: s.id }, data: { status: 'suspended' } });
    } else {
      await prisma.$transaction([
        prisma.subscription.update({ where: { id: s.id }, data: { plan: 'starter', status: 'active', amountFCFA: 0, currentPeriodStart: now, currentPeriodEnd: addMonths(now, 1), paymentMethod: null } }),
        prisma.user.update({ where: { id: s.userId }, data: { plan: 'starter' } }),
      ]);
    }
    summary.trialsExpired++;
  }

  // 2. Paid subscriptions whose period ended.
  const ended = await prisma.subscription.findMany({ where: { status: 'active', amountFCFA: { gt: 0 }, currentPeriodEnd: { lt: now } } });
  for (const s of ended) {
    if (s.cancelAtPeriodEnd) {
      const suspend = env.TRIAL_EXPIRY_POLICY === 'suspend';
      await prisma.$transaction([
        prisma.subscription.update({ where: { id: s.id }, data: { status: suspend ? 'suspended' : 'cancelled', plan: suspend ? s.plan : 'starter', amountFCFA: 0, currentPeriodStart: now, currentPeriodEnd: addMonths(now, 1) } }),
        prisma.user.update({ where: { id: s.userId }, data: { plan: suspend ? s.plan : 'starter' } }),
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

  // 4. Free tiers (downgraded / cancelled) keep a rolling monthly usage window.
  const free = await prisma.subscription.findMany({ where: { status: { in: ['active', 'cancelled'] }, amountFCFA: 0, currentPeriodEnd: { lt: now } } });
  for (const s of free) {
    await prisma.subscription.update({ where: { id: s.id }, data: { currentPeriodStart: now, currentPeriodEnd: addMonths(now, 1) } });
    summary.rolled++;
  }

  // 5. Abandoned checkouts.
  const expired = await prisma.paymentTransaction.updateMany({ where: { status: 'pending', createdAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } }, data: { status: 'expired' } });
  summary.txExpired = expired.count;
  return summary;
}
