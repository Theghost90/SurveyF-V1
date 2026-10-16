import { Prisma, type PaymentTransaction } from '@prisma/client';
import { ANNUAL_MONTHS_CHARGED, PLANS, currencyLabel, type Currency, type PaidPlanKey } from '@surveyflow/shared';
import { prisma } from '../../lib/prisma';
import { notifyOwner } from '../notify';
import { creditWallet } from '../wallet';
import type { VerifyResult } from './types';

export function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last)); // Jan 31 + 1 month = Feb 28/29, not Mar 3
  return r;
}

/** Plan order for "is this a downgrade?" (trial = 0). */
export const PLAN_RANK: Record<string, number> = { trial: 0, starter: 1, growth: 2, business: 3 };

export type SettleOutcome = 'activated' | 'already_settled' | 'failed' | 'pending' | 'needs_review';

export interface SettleLog {
  warn: (o: unknown, m?: string) => void;
  /** Used for payments that need a person (grep the logs for PAYMENT_REVIEW); falls back to warn. */
  error?: (o: unknown, m?: string) => void;
}

/**
 * The states from which a provider-CONFIRMED payment still counts. `failed` and `expired` are our own conclusions ("not paid yet"), not the
 * provider's: a hosted page lets the payer retry after a decline, and a payer may approve a Mobile Money prompt long after we gave up. When the
 * provider says the money arrived, the money arrived. `success` and `review` are final here (`review` is resolved by a person).
 */
export const SETTLEABLE = ['pending', 'failed', 'expired'] as const;

/** A database failure that says nothing about the payment (connection lost, pool exhausted, deadlock): retry later, do not give a verdict. */
export function isTransientDbError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError || err instanceof Prisma.PrismaClientRustPanicError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError) return ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034'].includes(err.code);
  if (err instanceof Prisma.PrismaClientUnknownRequestError) return /connection|timed? ?out|reset|closed|terminating|too many clients/i.test(err.message);
  return false;
}

const isDowngrade = (sub: { plan: string; status: string; amountFCFA: number }, plan: string | null) =>
  !!plan && sub.amountFCFA > 0 && ['active', 'past_due'].includes(sub.status) && (PLAN_RANK[plan] ?? 0) < (PLAN_RANK[sub.plan] ?? 0);

const reviewText = (tx: PaymentTransaction) =>
  `⚠️ SurveyFlow: we received your payment (ref ${tx.reference}) but need to check it by hand before it is applied. Nothing to do on your side and no need to pay again: we will confirm within one business day.`;

/**
 * Money the provider confirmed that we cannot simply apply: parked for a person, with the reason. Exactly one caller wins the transition,
 * so the customer is told once and the log line (grep PAYMENT_REVIEW) is written once.
 */
async function parkForReview(tx: PaymentTransaction, reason: string, log: SettleLog): Promise<SettleOutcome> {
  const r = await prisma.paymentTransaction.updateMany({ where: { id: tx.id, status: { in: [...SETTLEABLE] } }, data: { status: 'review', failReason: reason.slice(0, 500) } });
  if (!r.count) return 'already_settled';
  (log.error ?? log.warn)({ txId: tx.id, reference: tx.reference, psp: tx.pspProvider, userId: tx.userId, expected: `${tx.amount} ${tx.currency}`, reason }, 'PAYMENT_REVIEW money received, not applied: needs a person');
  void notifyOwner(tx.userId, reviewText(tx)).catch(() => undefined);
  return 'needs_review';
}

/** What a paid transaction does to the account. Runs inside the caller's database transaction: all of it happens or none of it. */
async function applyPaid(db: Prisma.TransactionClient, tx: PaymentTransaction, pspTxId?: string) {
  if (tx.purpose === 'gift_topup') {
    // Credit what we ASKED for (tx.amount), not what the PSP says it collected: an overpayment must not mint wallet balance.
    await creditWallet(db, tx.userId, tx.amount, 'topup', tx.id, `Top-up (${tx.method === 'card' ? 'card' : 'Mobile Money'} · ${tx.pspProvider})`, tx.currency as Currency);
  } else {
    await activateSubscription(db, tx, pspTxId);
  }
}

const paidText = (tx: PaymentTransaction) =>
  tx.purpose === 'gift_topup' ? `✅ SurveyFlow: ${tx.amount.toLocaleString('en')} ${currencyLabel(tx.currency)} added to your gift wallet.` : `✅ SurveyFlow: payment received. Your ${tx.plan} plan is active.`;

/** One settlement at a time per subscription: two payments of one customer landing together must not read the same "current plan". */
const lockSubscription = (db: Prisma.TransactionClient, subscriptionId: string) => db.$queryRaw`SELECT "id" FROM "Subscription" WHERE "id" = ${subscriptionId} FOR UPDATE`;

/**
 * Applies a PSP-VERIFIED result to a transaction. Idempotent: every transition is a compare-and-set, so however many times a provider retries
 * its webhook, the browser polls or the reconciliation job asks, the subscription is activated (or the wallet credited) exactly once.
 *
 *  - provider says paid  → success from pending, failed or expired (a late success is real money); amount and currency must cover what we asked,
 *    otherwise the payment goes to `review` (never to `failed`: the money is there);
 *  - provider says failed → failed, only from pending (a later "failed" never undoes a success or reopens an expired payment);
 *  - anything we cannot apply for a reason that is not a database outage (underpaid, wrong currency, a lower plan than the active one, an
 *    activation error) → `review`; a database outage is THROWN so the webhook is retried and the reconciliation job tries again.
 */
export async function settleTransaction(txId: string, v: VerifyResult, log: SettleLog = console as never): Promise<SettleOutcome> {
  const tx = await prisma.paymentTransaction.findUnique({ where: { id: txId } });
  if (!tx) return 'already_settled';
  if (tx.status === 'success' || tx.status === 'review') return 'already_settled';
  if (v.status === 'pending') return 'pending';

  if (v.status === 'failed') {
    if (tx.status !== 'pending') return 'already_settled';
    const r = await prisma.paymentTransaction.updateMany({ where: { id: txId, status: 'pending' }, data: { status: 'failed', failReason: 'declined_by_provider' } });
    return r.count ? 'failed' : 'already_settled';
  }

  // success: never trust a "paid" flag without checking the money matches what we asked for.
  const sameCurrency = v.currency.toUpperCase() === tx.currency.toUpperCase();
  if (v.amount < tx.amount || !sameCurrency) {
    log.warn({ txId, expected: `${tx.amount} ${tx.currency}`, got: `${v.amount} ${v.currency}` }, 'payment amount/currency mismatch — NOT activating');
    return parkForReview(tx, `${sameCurrency ? 'underpaid' : 'currency_mismatch'}: provider reports ${v.amount} ${v.currency}, asked ${tx.amount} ${tx.currency}`, log);
  }
  if (v.amount > tx.amount * 1.15) {
    // Credited at what we asked for (an overpayment never mints balance). A small excess is a buyer-side processing fee; a big one is worth a look.
    log.warn({ txId, expected: `${tx.amount} ${tx.currency}`, got: `${v.amount} ${v.currency}` }, 'payment OVERPAID — credited the asked amount only, check with the provider');
  }

  let result: 'activated' | 'already' | 'downgrade';
  try {
    result = await prisma.$transaction(async (db) => {
      await lockSubscription(db, tx.subscriptionId);
      if (tx.purpose !== 'gift_topup' && isDowngrade(await db.subscription.findUniqueOrThrow({ where: { id: tx.subscriptionId } }), tx.plan)) return 'downgrade';
      const claimed = await db.paymentTransaction.updateMany({
        where: { id: txId, status: { in: [...SETTLEABLE] } },
        data: { status: 'success', paidAt: new Date(), pspReference: v.pspReference ?? tx.pspReference, failReason: null },
      });
      if (claimed.count === 0) return 'already'; // another delivery got here first
      await applyPaid(db, tx, v.pspReference ?? tx.pspReference ?? undefined);
      return 'activated';
    });
  } catch (err) {
    if (isTransientDbError(err)) throw err;
    return parkForReview(tx, `activation_failed: ${(err as Error).message.slice(0, 300)}`, log);
  }
  if (result === 'downgrade') {
    // Applying it would replace the higher plan the customer has now (a payment started before they upgraded, landing late) and burn what is left of it.
    return parkForReview(tx, `lower_plan_than_active: paid ${tx.plan}, a higher plan is active — decide: credit it anyway or refund`, log);
  }
  if (result === 'activated') {
    void notifyOwner(tx.userId, paidText(tx)).catch(() => undefined);
    return 'activated';
  }
  return 'already_settled';
}

export async function activateSubscription(db: Prisma.TransactionClient, tx: PaymentTransaction, pspTxId?: string) {
  const sub = await db.subscription.findUniqueOrThrow({ where: { id: tx.subscriptionId } });
  const now = new Date();
  if (!tx.plan) throw new Error(`subscription payment ${tx.id} has no plan`);
  const plan = tx.plan as PaidPlanKey;
  // Renewing the same plan before it ends extends from the current end; an upgrade/new purchase starts now.
  const renewing = sub.plan === plan && ['active', 'past_due'].includes(sub.status) && sub.currentPeriodEnd > now && sub.amountFCFA > 0;
  const start = renewing ? sub.currentPeriodStart : now;
  const base = renewing ? sub.currentPeriodEnd : now;
  const end = addMonths(base, tx.interval === 'annual' ? 12 : 1);
  await db.subscription.update({
    where: { id: sub.id },
    data: {
      plan: tx.plan, status: 'active', currentPeriodStart: start, currentPeriodEnd: end, interval: tx.interval,
      amountFCFA: PLANS[plan].priceFCFA * (tx.interval === 'annual' ? ANNUAL_MONTHS_CHARGED : 1),
      paymentMethod: tx.method, pspProvider: tx.pspProvider, pspTransactionId: pspTxId ?? null,
      cancelAtPeriodEnd: false, graceEndsAt: null, reminderSentAt: null, pastDueNoticeAt: null,
    },
  });
  await db.user.update({ where: { id: tx.userId }, data: { plan: tx.plan } });
}

/** Payments waiting for a person, oldest first. */
export const listReview = () => prisma.paymentTransaction.findMany({ where: { status: 'review' }, orderBy: { createdAt: 'asc' }, include: { user: { select: { email: true, name: true, phone: true } } } });

/**
 * A person's decision on a payment in `review`. `credit` applies it as paid (the amount asked is credited, whatever the provider collected);
 * `reject` closes it as failed and tells the customer the money will be returned. Only a payment still in `review` can be resolved, once.
 */
export async function resolveReview(txId: string, decision: 'credit' | 'reject', note: string, log: SettleLog = console as never): Promise<'credited' | 'rejected' | 'not_in_review'> {
  const tx = await prisma.paymentTransaction.findUnique({ where: { id: txId } });
  if (!tx || tx.status !== 'review') return 'not_in_review';
  const trail = `${tx.failReason ?? ''} | ${decision === 'credit' ? 'credited' : 'rejected'} by operator: ${note}`.slice(0, 500);
  if (decision === 'reject') {
    const r = await prisma.paymentTransaction.updateMany({ where: { id: txId, status: 'review' }, data: { status: 'failed', failReason: trail } });
    if (!r.count) return 'not_in_review';
    log.warn({ txId, reference: tx.reference }, 'review rejected by operator');
    void notifyOwner(tx.userId, `⚠️ SurveyFlow: we could not apply your payment (ref ${tx.reference}). Our team will return it: contact support if you have not heard from us within 3 days.`).catch(() => undefined);
    return 'rejected';
  }
  const done = await prisma.$transaction(async (db) => {
    await lockSubscription(db, tx.subscriptionId);
    const claimed = await db.paymentTransaction.updateMany({ where: { id: txId, status: 'review' }, data: { status: 'success', paidAt: new Date(), failReason: trail } });
    if (!claimed.count) return false;
    await applyPaid(db, tx, tx.pspReference ?? undefined);
    return true;
  });
  if (!done) return 'not_in_review';
  log.warn({ txId, reference: tx.reference }, 'review credited by operator');
  void notifyOwner(tx.userId, paidText(tx)).catch(() => undefined);
  return 'credited';
}
