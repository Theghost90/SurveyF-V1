import { customAlphabet } from 'nanoid';
import type { PaymentTransaction, Plan, Prisma } from '@prisma/client';
import { ANNUAL_MONTHS_CHARGED, PLANS, WALLET_TOPUP_MAX_FCFA, WALLET_TOPUP_MIN_FCFA, currencyForCountry, planPrice, toWaId, type Currency, type PaidPlanKey, type PaymentMethod } from '@surveyflow/shared';
import { env } from '../../config/env';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { notifyOwner } from '../notify';
import { creditWallet } from '../wallet';
import { pspRouter, type PSPRouter } from './router';
import { PspError, type PSPAdapter, type VerifyResult } from './types';

// Alphanumeric only: CinetPay rejects `_ # / $ &` in transaction ids.
const refId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 22);

export interface InitiateInput {
  plan: PaidPlanKey;
  interval: 'monthly' | 'annual';
  method: PaymentMethod;
  phone?: string;
}

export function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last)); // Jan 31 + 1 month = Feb 28/29, not Mar 3
  return r;
}

export const txDto = (t: PaymentTransaction) => ({
  id: t.id, reference: t.reference, purpose: t.purpose, plan: t.plan, interval: t.interval, method: t.method, psp: t.pspProvider,
  amount: t.amount, currency: t.currency, status: t.status, checkoutUrl: t.status === 'pending' ? t.checkoutUrl : null,
  paymentToken: t.status === 'pending' && !t.checkoutUrl ? t.pspReference : null, createdAt: t.createdAt, paidAt: t.paidAt, failReason: t.failReason,
});

/** Pricing is ALWAYS computed here from the plan table — the client never sends an amount. */
function priceFor(plan: PaidPlanKey, currency: Currency, interval: 'monthly' | 'annual') {
  try {
    return { amount: planPrice(plan, currency, interval), currency };
  } catch {
    return { amount: planPrice(plan, 'USD', interval), currency: 'USD' as Currency };
  }
}

export async function initiatePayment(userId: string, input: InitiateInput, router: PSPRouter = pspRouter): Promise<PaymentTransaction> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { subscription: true } });
  if (!user.subscription) throw notFound('Subscription');

  // Double-click / refresh protection: reuse a fresh identical pending payment instead of creating a second charge.
  const dup = await prisma.paymentTransaction.findFirst({
    where: { userId, plan: input.plan, interval: input.interval, method: input.method, status: 'pending', createdAt: { gt: new Date(Date.now() - 10 * 60_000) } },
    orderBy: { createdAt: 'desc' },
  });
  if (dup) return dup;

  const currency = (user.preferredCurrency || currencyForCountry(user.country)) as Currency;
  const { amount, currency: payCurrency } = priceFor(input.plan, currency, input.interval);
  const chain = router.chain({ country: user.country, currency: payCurrency, method: input.method, preferred: user.preferredPSP });
  if (!chain.length) throw new AppError(503, 'no_psp_available', 'No payment provider is available for this country / payment method right now');

  const phone = (input.phone ?? user.phone ?? '').trim();
  if (input.method === 'mobile_money' && !/^\+?\d{8,15}$/.test(phone.replace(/[\s-]/g, ''))) {
    throw badRequest('phone_required', 'Enter the Mobile Money phone number to charge');
  }

  const tx = await prisma.paymentTransaction.create({
    data: {
      subscriptionId: user.subscription.id, userId, pspProvider: chain[0]!.name, amount, currency: payCurrency, status: 'pending',
      reference: `sf${refId()}`, purpose: 'subscription', plan: input.plan as Plan, interval: input.interval, method: input.method, phone: phone || null,
    },
  });
  return dispatchCheckout(tx, chain, user, `SurveyFlow ${PLANS[input.plan].key} (${input.interval})`, phone);
}

/**
 * Walks the PSP failover chain for an already-created pending transaction. Shared by subscriptions and gift top-ups so
 * both get the same failover, the same reference rules and the same "mark failed if nobody answers" behaviour.
 */
async function dispatchCheckout(
  tx: PaymentTransaction, chain: PSPAdapter[], user: { name: string; email: string }, description: string, phone: string,
): Promise<PaymentTransaction> {
  const returnUrl = `${env.webOrigins[0]}/billing/return?ref=${tx.reference}`;
  const notifyUrl = (psp: string) => `${env.PUBLIC_API_URL}/api/payments/webhook/${psp}`;
  let lastErr: Error | null = null;
  for (const adapter of chain) {
    try {
      const r = await adapter.initiatePayment({
        amount: tx.amount, currency: tx.currency as Currency, method: tx.method as PaymentMethod, reference: tx.reference, customerName: user.name, customerEmail: user.email,
        customerPhone: toWaId(phone || '0'), description, returnUrl, notifyUrl: notifyUrl(adapter.name),
      });
      return prisma.paymentTransaction.update({ where: { id: tx.id }, data: { pspProvider: adapter.name, pspReference: r.pspReference ?? r.paymentToken ?? null, checkoutUrl: r.checkoutUrl ?? null } });
    } catch (err) {
      lastErr = err as Error;
      if (err instanceof PspError && !err.retryable) break;
      // otherwise fail over to the next provider in the chain
    }
  }
  await prisma.paymentTransaction.update({ where: { id: tx.id }, data: { status: 'failed', failReason: (lastErr?.message ?? 'psp_unavailable').slice(0, 300) } });
  throw new AppError(502, 'psp_unavailable', 'We could not reach any payment provider. Please try again in a moment.');
}

export interface TopupInput {
  amountFCFA: number;
  method: PaymentMethod;
  phone?: string;
}

/**
 * Gift-wallet top-up. The wallet is in FCFA and gifts only exist in the FCFA zone, so the charge is always in XAF/XOF
 * (1:1) — no FX rate is ever invented. The amount is validated here; the client never decides pricing.
 */
export async function initiateGiftTopup(userId: string, input: TopupInput, router: PSPRouter = pspRouter): Promise<PaymentTransaction> {
  const amount = input.amountFCFA;
  if (!Number.isInteger(amount) || amount < WALLET_TOPUP_MIN_FCFA || amount > WALLET_TOPUP_MAX_FCFA) {
    throw badRequest('invalid_amount', `Top-up must be between ${WALLET_TOPUP_MIN_FCFA.toLocaleString('en')} and ${WALLET_TOPUP_MAX_FCFA.toLocaleString('en')} FCFA`);
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { subscription: true } });
  if (!user.subscription) throw notFound('Subscription');

  const dup = await prisma.paymentTransaction.findFirst({
    where: { userId, purpose: 'gift_topup', amount, method: input.method, status: 'pending', createdAt: { gt: new Date(Date.now() - 10 * 60_000) } },
    orderBy: { createdAt: 'desc' },
  });
  if (dup) return dup;

  const currency: Currency = user.preferredCurrency === 'XOF' ? 'XOF' : 'XAF';
  const chain = router.chain({ country: user.country, currency, method: input.method, preferred: user.preferredPSP });
  if (!chain.length) throw new AppError(503, 'no_psp_available', 'No payment provider is available for this country / payment method right now');

  const phone = (input.phone ?? user.phone ?? '').trim();
  if (input.method === 'mobile_money' && !/^\+?\d{8,15}$/.test(phone.replace(/[\s-]/g, ''))) {
    throw badRequest('phone_required', 'Enter the Mobile Money phone number to charge');
  }
  const tx = await prisma.paymentTransaction.create({
    data: {
      subscriptionId: user.subscription.id, userId, pspProvider: chain[0]!.name, amount, currency, status: 'pending',
      reference: `sf${refId()}`, purpose: 'gift_topup', plan: null, interval: 'monthly', method: input.method, phone: phone || null,
    },
  });
  return dispatchCheckout(tx, chain, user, 'SurveyFlow gift wallet top-up', phone);
}

export type SettleOutcome = 'activated' | 'already_settled' | 'failed' | 'pending' | 'amount_mismatch';

/**
 * Applies a PSP-VERIFIED result to a transaction. Idempotent: the compare-and-set on `status: 'pending'` means that
 * however many times a PSP retries its webhook (or the browser polls), the subscription is activated exactly once.
 */
export async function settleTransaction(txId: string, v: VerifyResult, log: { warn: (o: unknown, m?: string) => void } = console as never): Promise<SettleOutcome> {
  const tx = await prisma.paymentTransaction.findUnique({ where: { id: txId } });
  if (!tx) return 'already_settled';
  if (tx.status !== 'pending') return 'already_settled';
  if (v.status === 'pending') return 'pending';

  if (v.status === 'failed') {
    const r = await prisma.paymentTransaction.updateMany({ where: { id: txId, status: 'pending' }, data: { status: 'failed', failReason: 'declined_by_provider' } });
    return r.count ? 'failed' : 'already_settled';
  }

  // success: never trust a "paid" flag without checking the money matches what we asked for.
  if (v.amount < tx.amount || v.currency.toUpperCase() !== tx.currency.toUpperCase()) {
    log.warn({ txId, expected: `${tx.amount} ${tx.currency}`, got: `${v.amount} ${v.currency}` }, 'payment amount/currency mismatch — NOT activating');
    await prisma.paymentTransaction.updateMany({ where: { id: txId, status: 'pending' }, data: { status: 'failed', failReason: `amount_mismatch: got ${v.amount} ${v.currency}` } });
    return 'amount_mismatch';
  }

  const activated = await prisma.$transaction(async (db) => {
    const claimed = await db.paymentTransaction.updateMany({
      where: { id: txId, status: 'pending' }, data: { status: 'success', paidAt: new Date(), pspReference: v.pspReference ?? tx.pspReference },
    });
    if (claimed.count === 0) return false; // another delivery got here first
    if (tx.purpose === 'gift_topup') {
      // Credit what we ASKED for (tx.amount), not what the PSP says it collected: an overpayment must not mint wallet balance.
      await creditWallet(db, tx.userId, tx.amount, 'topup', tx.id, `Top-up (${tx.method === 'card' ? 'card' : 'Mobile Money'} · ${tx.pspProvider})`);
    } else {
      await activateSubscription(db, tx, v.pspReference ?? tx.pspReference ?? undefined);
    }
    return true;
  });
  if (activated) {
    const msg = tx.purpose === 'gift_topup' ? `✅ SurveyFlow: ${tx.amount.toLocaleString('en')} FCFA added to your gift wallet.` : `✅ SurveyFlow: payment received. Your ${tx.plan} plan is active.`;
    void notifyOwner(tx.userId, msg).catch(() => undefined);
    return 'activated';
  }
  return 'already_settled';
}

async function activateSubscription(db: Prisma.TransactionClient, tx: PaymentTransaction, pspTxId?: string) {
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
      cancelAtPeriodEnd: false, graceEndsAt: null, reminderSentAt: null,
    },
  });
  await db.user.update({ where: { id: tx.userId }, data: { plan: tx.plan } });
}

/** Asks the PSP what really happened and settles accordingly. Used by webhooks AND by the status poll. */
export async function refreshTransaction(tx: PaymentTransaction, router: PSPRouter = pspRouter, log?: { warn: (o: unknown, m?: string) => void }): Promise<{ tx: PaymentTransaction; outcome: SettleOutcome }> {
  if (tx.status !== 'pending') return { tx, outcome: 'already_settled' };
  const adapter = router.getAdapter(tx.pspProvider);
  if (!adapter) throw conflict('unknown_psp', `Unknown provider ${tx.pspProvider}`);
  let outcome: SettleOutcome = 'pending';
  try {
    outcome = await settleTransaction(tx.id, await adapter.verifyPayment({ reference: tx.reference, pspReference: tx.pspReference }), log);
  } catch {
    outcome = 'pending'; // PSP verify endpoint down: stay pending, a later poll/webhook will settle it
  }
  // Pending for a day = abandoned checkout.
  if (outcome === 'pending' && tx.createdAt < new Date(Date.now() - 24 * 3_600_000)) {
    await prisma.paymentTransaction.updateMany({ where: { id: tx.id, status: 'pending' }, data: { status: 'expired' } });
  }
  return { tx: await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tx.id } }), outcome };
}
