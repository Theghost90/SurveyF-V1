import { customAlphabet } from 'nanoid';
import type { PaymentTransaction, Plan, Prisma } from '@prisma/client';
import { ANNUAL_MONTHS_CHARGED, PLANS, PSP_CHARGE_CURRENCIES, convertToXAF, currencyLabel, isCfa, normalizePhone, phoneExampleFor, planPriceIn, toWaId, walletLimits, type Currency, type FxQuote, type PaidPlanKey, type PaymentMethod } from '@surveyflow/shared';
import { env } from '../../config/env';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { notifyOwner } from '../notify';
import { billingQuote, methodsFor, walletCurrency, walletQuote } from '../billing-currency';
import { fixedFeeConverter } from '../fx';
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

/**
 * What the BROWSER may learn about a failure. `failReason` keeps the provider's own words for the operator (database and logs only):
 * it can name an expired API key or carry a fragment of the provider's error page, which is nobody's business but ours.
 */
export type FailCode = 'declined' | 'unavailable' | 'other';
export const failCodeOf = (reason: string | null): FailCode =>
  !reason ? 'other' : reason === 'declined_by_provider' ? 'declined' : reason.startsWith('psp_unavailable') ? 'unavailable' : 'other';

export const txDto = (t: PaymentTransaction) => ({
  id: t.id, reference: t.reference, purpose: t.purpose, plan: t.plan, interval: t.interval, method: t.method, psp: t.pspProvider,
  amount: t.amount, currency: t.currency, status: t.status, checkoutUrl: t.status === 'pending' ? t.checkoutUrl : null,
  paymentToken: t.status === 'pending' && !t.checkoutUrl ? t.pspReference : null, createdAt: t.createdAt, paidAt: t.paidAt,
  failCode: t.status === 'failed' ? failCodeOf(t.failReason) : null,
});

/** Mobile Money only exists in CFA francs: a payment in any other currency is by international card. */
function assertMethodForCurrency(method: PaymentMethod, currency: string) {
  if (!methodsFor(currency).includes(method) && method !== 'bank_transfer') {
    throw badRequest('method_unavailable', `${method === 'mobile_money' ? 'Mobile Money' : 'This payment method'} is only available when paying in CFA francs. Pay by card.`);
  }
}

const fxRateOf = (q: FxQuote) => (isCfa(q.currency) ? null : q.rate);

/**
 * The number a Mobile Money prompt is pushed to, in E.164. It is parsed against the owner's country, so a typo or a number from nowhere is
 * refused here with an example, instead of sending a prompt to a stranger (or nowhere) and leaving the owner staring at "approve on your phone".
 * A card payment does not need one: the number on the account is used when it is valid, otherwise none.
 */
function payerPhone(input: { phone?: string }, user: { phone: string; country: string }, method: PaymentMethod): string {
  const raw = (input.phone ?? '').trim() || (user.phone ?? '').trim();
  const normalized = raw ? normalizePhone(raw, user.country) : null;
  if (method === 'mobile_money' && !normalized) {
    throw badRequest('invalid_phone', `Enter a valid Mobile Money phone number with its country code, for example ${phoneExampleFor(user.country)}`);
  }
  return normalized ?? '';
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

  // The price is the FCFA price converted at the live rate into the owner's currency (CFA francs when no fresh rate exists), and the
  // charge is made in that same currency: the provider shows the buyer exactly the amount we show, and settles to us in XAF.
  const { quote } = await billingQuote(user);
  const payCurrency = quote.currency;
  assertMethodForCurrency(input.method, payCurrency);
  const amount = planPriceIn(input.plan, input.interval, quote);
  // What the provider will settle in XAF for the amount charged (not the canonical FCFA price: the two differ by the price rounding,
  // and this column is what a provider's settlement report is reconciled against — the canonical price is Subscription.amountFCFA).
  const amountXAF = convertToXAF(amount, quote);
  const chain = router.chain({ country: user.country, currency: payCurrency, method: input.method, amountXAF }, undefined, await fixedFeeConverter());
  if (!chain.length) throw new AppError(503, 'no_psp_available', 'No payment provider is available for this country / payment method right now');

  const phone = payerPhone(input, user, input.method);

  const tx = await prisma.paymentTransaction.create({
    data: {
      subscriptionId: user.subscription.id, userId, pspProvider: chain[0]!.name, amount, currency: payCurrency, amountXAF, fxRate: fxRateOf(quote), status: 'pending',
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
  await prisma.paymentTransaction.update({ where: { id: tx.id }, data: { status: 'failed', failReason: `psp_unavailable: ${(lastErr?.message ?? 'no provider answered').slice(0, 270)}` } });
  throw new AppError(502, 'psp_unavailable', 'We could not reach any payment provider. Please try again in a moment.');
}

export interface TopupInput {
  /** Whole units of the wallet's currency. */
  amount: number;
  method: PaymentMethod;
  phone?: string;
}

/**
 * Gift-wallet top-up, in the owner's currency. The amount is checked against the live limits of that currency (the FCFA limits converted
 * at the current rate); the charge is made in that currency and settles to us in XAF. The wallet currency is fixed by the first
 * top-up, so every later one must be in the same currency. The client never decides pricing: it sends an amount, the server validates it.
 */
export async function initiateGiftTopup(userId: string, input: TopupInput, router: PSPRouter = pspRouter): Promise<PaymentTransaction> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { subscription: true } });
  if (!user.subscription) throw notFound('Subscription');

  const currency = walletCurrency(user);
  if (!(PSP_CHARGE_CURRENCIES as readonly string[]).includes(currency)) {
    throw new AppError(503, 'currency_unsupported', `Top-ups in ${currency} are not available: the payment providers cannot charge in it.`);
  }
  const quote = await walletQuote(user); // 503 fx_unavailable rather than guess
  const limits = walletLimits(quote);
  const amount = input.amount;
  if (!Number.isInteger(amount) || amount < limits.topupMin || amount > limits.topupMax) {
    throw badRequest('invalid_amount', `Top-up must be between ${limits.topupMin.toLocaleString('en')} and ${limits.topupMax.toLocaleString('en')} ${currencyLabel(currency)}`, { min: limits.topupMin, max: limits.topupMax, currency });
  }
  assertMethodForCurrency(input.method, currency);

  // One currency at a time: a second top-up in another currency while one is pending would corrupt the ledger's units.
  const other = await prisma.paymentTransaction.findFirst({ where: { userId, purpose: 'gift_topup', status: 'pending', currency: { not: currency }, createdAt: { gt: new Date(Date.now() - 24 * 3_600_000) } } });
  if (other) throw conflict('topup_in_other_currency', `A top-up in ${other.currency} is still pending. Finish or wait for it before topping up in ${currency}.`);

  const dup = await prisma.paymentTransaction.findFirst({
    where: { userId, purpose: 'gift_topup', amount, currency, method: input.method, status: 'pending', createdAt: { gt: new Date(Date.now() - 10 * 60_000) } },
    orderBy: { createdAt: 'desc' },
  });
  if (dup) return dup;

  const amountXAF = convertToXAF(amount, quote);
  const chain = router.chain({ country: user.country, currency, method: input.method, amountXAF }, undefined, await fixedFeeConverter());
  if (!chain.length) throw new AppError(503, 'no_psp_available', 'No payment provider is available for this country / payment method right now');

  const phone = payerPhone(input, user, input.method);
  const tx = await prisma.paymentTransaction.create({
    data: {
      subscriptionId: user.subscription.id, userId, pspProvider: chain[0]!.name, amount, currency, amountXAF, fxRate: fxRateOf(quote), status: 'pending',
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

  if (v.amount > tx.amount * 1.15) {
    // Credited at what we asked for (an overpayment never mints balance). A small excess is a buyer-side processing fee; a big one is worth a look.
    log.warn({ txId, expected: `${tx.amount} ${tx.currency}`, got: `${v.amount} ${v.currency}` }, 'payment OVERPAID — credited the asked amount only, check with the provider');
  }

  const activated = await prisma.$transaction(async (db) => {
    const claimed = await db.paymentTransaction.updateMany({
      where: { id: txId, status: 'pending' }, data: { status: 'success', paidAt: new Date(), pspReference: v.pspReference ?? tx.pspReference },
    });
    if (claimed.count === 0) return false; // another delivery got here first
    if (tx.purpose === 'gift_topup') {
      // Credit what we ASKED for (tx.amount), not what the PSP says it collected: an overpayment must not mint wallet balance.
      await creditWallet(db, tx.userId, tx.amount, 'topup', tx.id, `Top-up (${tx.method === 'card' ? 'card' : 'Mobile Money'} · ${tx.pspProvider})`, tx.currency as Currency);
    } else {
      await activateSubscription(db, tx, v.pspReference ?? tx.pspReference ?? undefined);
    }
    return true;
  });
  if (activated) {
    const msg = tx.purpose === 'gift_topup' ? `✅ SurveyFlow: ${tx.amount.toLocaleString('en')} ${currencyLabel(tx.currency)} added to your gift wallet.` : `✅ SurveyFlow: payment received. Your ${tx.plan} plan is active.`;
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

/**
 * Asks the PSP what really happened and settles accordingly. Used by webhooks, by the status poll and (later) by the reconciliation job.
 *
 * `force` is for callers that must not skip a verification (a PSP webhook: the PSP will not call again once it got an answer). Polls leave it off:
 * a browser asking every 3 s must not become 20 calls a minute to the provider, so a verification already done or running within the last
 * moment is reused. `verifyError` says the provider could not be asked (its verify endpoint is down), as opposed to "asked, still pending".
 */
export async function refreshTransaction(
  tx: PaymentTransaction, router: PSPRouter = pspRouter, log?: { warn: (o: unknown, m?: string) => void }, opts: { force?: boolean } = {},
): Promise<{ tx: PaymentTransaction; outcome: SettleOutcome; verifyError: boolean }> {
  if (tx.status !== 'pending') return { tx, outcome: 'already_settled', verifyError: false };
  const adapter = router.getAdapter(tx.pspProvider);
  if (!adapter) throw conflict('unknown_psp', `Unknown provider ${tx.pspProvider}`);
  if (!opts.force && (await redis.set(`sf:pay:verify:${tx.id}`, '1', 'PX', 1_500, 'NX')) !== 'OK') {
    return { tx: await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tx.id } }), outcome: 'pending', verifyError: false };
  }
  let outcome: SettleOutcome = 'pending';
  let verifyError = false;
  try {
    outcome = await settleTransaction(tx.id, await adapter.verifyPayment({ reference: tx.reference, pspReference: tx.pspReference }), log);
  } catch (err) {
    outcome = 'pending'; // PSP verify endpoint down: stay pending, a later poll/webhook will settle it
    verifyError = true;
    log?.warn({ txId: tx.id, psp: tx.pspProvider, err: (err as Error).message }, 'PSP verification failed; payment stays pending');
  }
  // Pending for a day = abandoned checkout.
  if (outcome === 'pending' && tx.createdAt < new Date(Date.now() - 24 * 3_600_000)) {
    await prisma.paymentTransaction.updateMany({ where: { id: tx.id, status: 'pending' }, data: { status: 'expired' } });
  }
  return { tx: await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tx.id } }), outcome, verifyError };
}
