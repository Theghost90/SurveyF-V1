import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { pspRouter, type PSPRouter } from './router';
import { LATE_WINDOW_MS, refreshTransaction } from './service';
import type { SettleLog } from './settlement';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** A pending payment is given up on (expired) after this, but only after the provider was asked one last time. */
export const EXPIRE_AFTER_MS = 24 * HOUR;
/** If the provider could not be asked for this long, expire anyway: a late success is still honoured for LATE_WINDOW_MS afterwards. */
const EXPIRE_ANYWAY_AFTER_MS = 48 * HOUR;
const BATCH = 200;
const PARALLEL = 5;

export interface ReconcileSummary { recovered: number; failed: number; expired: number; review: number; errors: number }

/**
 * Closes the gap the webhook and the browser leave: a customer who paid and shut the tab, behind a webhook that never arrived (or arrived while
 * we were down), would otherwise stay "pending" forever and, after a day, "expired" with the money taken. This job asks the PROVIDER, on a
 * schedule that follows how likely a payment is to still be moving:
 *
 *   pending, first 10 min   every minute      (the customer is probably still on the phone)
 *   pending, up to 2 h      every 5 minutes
 *   pending, up to 24 h     every 30 minutes
 *   pending, over 24 h      hourly, and when the provider says nothing has happened, the payment is expired (never blind)
 *   failed / expired        every 6 hours for 7 days (a hosted page lets the payer retry; a payer can approve a prompt late)
 *
 * It only ever asks and settles through the same compare-and-set path as the webhook, so running alongside webhooks, polls and other replicas is safe.
 */
export async function reconcilePayments(now = new Date(), router: PSPRouter = pspRouter, log: SettleLog = console as never): Promise<ReconcileSummary> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const due = (ms: number): Prisma.PaymentTransactionWhereInput => ({ OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: ago(ms) } }] });
  const pending = (older: number | null, newer: number | null, every: number): Prisma.PaymentTransactionWhereInput => ({
    status: 'pending',
    createdAt: { ...(older !== null ? { lte: ago(older) } : {}), ...(newer !== null ? { gt: ago(newer) } : {}) },
    AND: [due(every)],
  });
  const candidates = await prisma.paymentTransaction.findMany({
    where: {
      OR: [
        pending(null, 10 * MIN, MIN - 5_000),
        pending(10 * MIN, 2 * HOUR, 5 * MIN - 5_000),
        pending(2 * HOUR, EXPIRE_AFTER_MS, 30 * MIN - 5_000),
        pending(EXPIRE_AFTER_MS, null, HOUR - 5_000),
        // Only payments that ever reached a provider can have been paid there.
        { status: { in: ['failed', 'expired'] }, createdAt: { gt: ago(LATE_WINDOW_MS) }, AND: [due(6 * HOUR), { OR: [{ pspReference: { not: null } }, { checkoutUrl: { not: null } }] }] },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  const sum: ReconcileSummary = { recovered: 0, failed: 0, expired: 0, review: 0, errors: 0 };
  const expire = async (id: string) => {
    const r = await prisma.paymentTransaction.updateMany({ where: { id, status: 'pending' }, data: { status: 'expired', lastCheckedAt: new Date() } });
    sum.expired += r.count;
  };
  const one = async (tx: (typeof candidates)[number]) => {
    const age = now.getTime() - tx.createdAt.getTime();
    try {
      const r = await refreshTransaction(tx, router, log, { force: true });
      if (r.outcome === 'activated') sum.recovered++;
      else if (r.outcome === 'failed') sum.failed++;
      else if (r.outcome === 'needs_review') sum.review++;
      if (r.verifyError) sum.errors++;
      // Expire only a payment the provider was just asked about (or one it could not be asked about for two days).
      if (r.tx.status === 'pending' && age >= EXPIRE_AFTER_MS && (!r.verifyError || age >= EXPIRE_ANYWAY_AFTER_MS)) await expire(tx.id);
    } catch (err) {
      sum.errors++;
      log.warn({ txId: tx.id, psp: tx.pspProvider, err: (err as Error).message }, 'reconciliation could not check this payment');
      if (tx.status === 'pending' && age >= EXPIRE_ANYWAY_AFTER_MS) await expire(tx.id);
    }
  };
  for (let i = 0; i < candidates.length; i += PARALLEL) await Promise.all(candidates.slice(i, i + PARALLEL).map(one));
  return sum;
}
