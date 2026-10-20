import { customAlphabet } from 'nanoid';
import type { PaymentTransaction, Plan, Prisma } from '@prisma/client';
import { PLANS, PSP_CHARGE_CURRENCIES, convertToXAF, currencyLabel, isCfa, normalizePhone, phoneExampleFor, planPriceIn, toWaId, walletLimits, type Currency, type FxQuote, type PaidPlanKey, type PaymentMethod } from '@surveyflow/shared';
import { env } from '../../config/env';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { redis, withLock } from '../../lib/redis';
import { billingQuote, methodsFor, walletCurrency, walletQuote } from '../billing-currency';
import { fixedFeeConverter } from '../fx';
import { breakerFail, breakerOk, breakerOpen } from './breaker';
import { track } from '../funnel';
import { pspRouter, type PSPRouter } from './router';
import { PLAN_RANK, settleTransaction, type SettleLog, type SettleOutcome } from './settlement';
import { PspError, type PSPAdapter } from './types';

// The settlement rules live in settlement.ts; these names stay importable from here.
export { PLAN_RANK, addMonths, settleTransaction, type SettleOutcome } from './settlement';

// Alphanumeric only: CinetPay rejects `_ # / $ &` in transaction ids.
const refId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 22);

export interface InitiateInput {
  plan: PaidPlanKey;
  interval: 'monthly' | 'annual';
  method: PaymentMethod;
  phone?: string;
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

/**
 * How long an identical pending payment is handed back instead of starting a second one. A hosted card page stays valid for a while; a Mobile
 * Money prompt dies within about a minute at the operator, so a customer who retries after that needs a NEW prompt, not the dead one.
 */
const REUSE_MS: Record<string, number> = { card: 10 * 60_000, bank_transfer: 10 * 60_000, mobile_money: 90_000 };
/** A row that was never dispatched (the process died between "create" and "call the provider") is not reusable after this. */
const DISPATCH_GRACE_MS = 40_000;
/** Payments one customer may have in flight at once: a runaway client must not be able to start twenty charges. */
const MAX_PENDING = 4;
/**
 * After a push provider (Campay) failed in a way that may still have sent the prompt, a second prompt must not be started for this long: the
 * first one lives about as long at the operator, and the customer must not be charged twice.
 */
const UNCONFIRMED_BLOCK_MS = 3 * 60_000;
const UNCONFIRMED = 'unconfirmed';
/** How long after we gave up on a payment (failed / expired) the provider is still asked about it: a payer may complete it much later. */
export const LATE_WINDOW_MS = 7 * 24 * 3_600_000;
export const isDispatched = (t: Pick<PaymentTransaction, 'pspReference' | 'checkoutUrl'>) => !!(t.pspReference || t.checkoutUrl);

const unconfirmedError = () => new AppError(502, 'psp_unconfirmed', 'We could not confirm that your payment request went through. Do not pay again yet: check your phone for an approval request, and look at your payment status in a few minutes.');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * "Is there already an identical payment in flight? If not, create one" as ONE step per customer (a short Redis lock), because as two steps
 * eight simultaneous clicks created two charges. Starting the payment at the provider happens after, outside the lock.
 */
async function reserveTransaction(
  userId: string, method: string, same: Prisma.PaymentTransactionWhereInput, data: Prisma.PaymentTransactionUncheckedCreateInput,
): Promise<{ tx: PaymentTransaction; fresh: boolean }> {
  try {
    return await withLock(`payinit:${userId}`, async () => {
      const now = Date.now();
      const dup = await prisma.paymentTransaction.findFirst({
        where: {
          ...same, userId, status: 'pending', createdAt: { gt: new Date(now - (REUSE_MS[method] ?? 600_000)) },
          // (NOT LIKE on a NULL failReason is NULL in SQL, which would drop every normal row: say "no reason, or not an unconfirmed one".)
          AND: [
            { OR: [{ failReason: null }, { NOT: { failReason: { startsWith: UNCONFIRMED } } }] },
            { OR: [{ checkoutUrl: { not: null } }, { pspReference: { not: null } }, { createdAt: { gt: new Date(now - DISPATCH_GRACE_MS) } }] },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
      if (dup) return { tx: dup, fresh: false };
      // A push prompt may be on its way to the customer's phone from an attempt we could not confirm: starting another could charge twice.
      const unconfirmed = await prisma.paymentTransaction.findFirst({ where: { userId, status: 'pending', failReason: { startsWith: UNCONFIRMED }, createdAt: { gt: new Date(now - UNCONFIRMED_BLOCK_MS) } } });
      if (unconfirmed) throw unconfirmedError();
      const open = await prisma.paymentTransaction.count({ where: { userId, status: 'pending', createdAt: { gt: new Date(now - 30 * 60_000) } } });
      if (open >= MAX_PENDING) throw new AppError(429, 'too_many_pending', 'You already have several payments in progress. Wait for them to be confirmed before starting another, so you are never charged twice.');
      return { tx: await prisma.paymentTransaction.create({ data }), fresh: true };
    }, { ttlMs: 10_000, waitMs: 8_000 });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('lock timeout')) throw new AppError(409, 'payment_busy', 'Another payment is being started. Please wait a few seconds and try again.');
    throw err;
  }
}

/** The caller got an identical in-flight payment that another request is still starting at the provider: wait for its checkout, do not start a second. */
async function awaitDispatch(tx: PaymentTransaction): Promise<PaymentTransaction> {
  const deadline = Date.now() + 25_000;
  let cur = tx;
  for (;;) {
    if (cur.status === 'failed') throw new AppError(502, 'psp_unavailable', 'We could not reach any payment provider. Please try again in a moment.');
    if (cur.failReason?.startsWith(UNCONFIRMED)) throw unconfirmedError();
    if (cur.status !== 'pending' || cur.checkoutUrl || cur.pspReference || Date.now() > deadline) return cur;
    await sleep(300);
    cur = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tx.id } });
  }
}

export async function initiatePayment(userId: string, input: InitiateInput, router: PSPRouter = pspRouter): Promise<PaymentTransaction> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { subscription: true } });
  const sub = user.subscription;
  if (!sub) throw notFound('Subscription');

  // The downgrade guard lives HERE, not in one route: every way of starting a payment passes through it. (Paying for a lower plan would
  // replace the higher one at once and throw away what is left of it.)
  if (sub.amountFCFA > 0 && ['active', 'past_due'].includes(sub.status) && PLAN_RANK[input.plan]! < PLAN_RANK[sub.plan]!) {
    throw conflict('downgrade_not_supported', 'To move to a lower plan, cancel at period end and subscribe again afterwards.');
  }

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

  const { tx, fresh } = await reserveTransaction(
    userId, input.method, { purpose: 'subscription', plan: input.plan as Plan, interval: input.interval, method: input.method },
    {
      subscriptionId: sub.id, userId, pspProvider: chain[0]!.name, amount, currency: payCurrency, amountXAF, fxRate: fxRateOf(quote), status: 'pending',
      reference: `sf${refId()}`, purpose: 'subscription', plan: input.plan as Plan, interval: input.interval, method: input.method, phone: phone || null,
    },
  );
  if (!fresh) return awaitDispatch(tx);
  await track(userId, 'checkout_start', { plan: input.plan, interval: input.interval, method: input.method });
  return dispatchCheckout(tx, chain, user, `SurveyFlow ${PLANS[input.plan].key} (${input.interval})`, phone);
}

/**
 * Walks the PSP failover chain for an already-created pending transaction. Shared by subscriptions and gift top-ups so
 * both get the same failover, the same reference rules and the same "mark failed if nobody answers" behaviour.
 * A provider that has been failing is moved to the END of the chain (see breaker.ts), so a down provider costs one customer's wait, not everyone's.
 */
async function dispatchCheckout(
  tx: PaymentTransaction, chain: PSPAdapter[], user: { name: string; email: string }, description: string, phone: string,
): Promise<PaymentTransaction> {
  const returnUrl = `${env.webOrigins[0]}/billing/return?ref=${tx.reference}`;
  const notifyUrl = (psp: string) => `${env.PUBLIC_API_URL}/api/payments/webhook/${psp}`;
  const tripped = await Promise.all(chain.map((a) => breakerOpen(a.name)));
  const ordered = [...chain.filter((_, i) => !tripped[i]), ...chain.filter((_, i) => tripped[i])];
  let lastErr: Error | null = null;
  let unconfirmed: PSPAdapter | null = null;
  const attempts: Array<Record<string, unknown>> = [];
  for (const adapter of ordered) {
    let r: Awaited<ReturnType<PSPAdapter['initiatePayment']>>;
    try {
      r = await adapter.initiatePayment({
        amount: tx.amount, currency: tx.currency as Currency, method: tx.method as PaymentMethod, reference: tx.reference, customerName: user.name, customerEmail: user.email,
        customerPhone: toWaId(phone || '0'), description, returnUrl, notifyUrl: notifyUrl(adapter.name),
      });
    } catch (err) {
      lastErr = err as Error;
      // "Did the provider create the payment?" An error that is not a plain refusal (a timeout after the request left, a reset, a 502, or a bug
      // after the answer arrived) is treated as: maybe.
      const ambiguous = !(err instanceof PspError) || err.ambiguous;
      attempts.push({ psp: adapter.name, at: new Date().toISOString(), ok: false, ...(ambiguous ? { ambiguous: true } : {}), error: lastErr.message.slice(0, 200) });
      if (err instanceof PspError && err.retryable) await breakerFail(adapter.name);
      // A hosted checkout of a provider we gave up on is never shown to the customer, so moving to the next provider is harmless. A PUSH provider
      // may already have sent the prompt to the phone: asking another one would mean two prompts, two charges. Stop and let reconciliation decide.
      if (adapter.push && ambiguous) { unconfirmed = adapter; break; }
      if (err instanceof PspError && !err.retryable) break;
      continue; // otherwise fail over to the next provider in the chain
    }
    await breakerOk(adapter.name);
    attempts.push({ psp: adapter.name, at: new Date().toISOString(), ok: true });
    // Outside the try on purpose: a database hiccup AFTER the provider accepted the payment must not look like "the provider failed" and start a second one.
    return prisma.paymentTransaction.update({ where: { id: tx.id }, data: { pspProvider: adapter.name, pspReference: r.pspReference ?? r.paymentToken ?? null, checkoutUrl: r.checkoutUrl ?? null, attempts: attempts as Prisma.InputJsonValue } });
  }
  if (unconfirmed) {
    // The payment stays PENDING and is tied to the provider that may have it: the status poll, the webhook and the reconciliation job settle it
    // if the prompt did go out, and the customer is told not to pay again (see reserveTransaction).
    await prisma.paymentTransaction.update({ where: { id: tx.id }, data: { pspProvider: unconfirmed.name, failReason: `${UNCONFIRMED}: ${(lastErr?.message ?? '').slice(0, 270)}`, attempts: attempts as Prisma.InputJsonValue } });
    throw unconfirmedError();
  }
  await prisma.paymentTransaction.update({ where: { id: tx.id }, data: { status: 'failed', failReason: `psp_unavailable: ${(lastErr?.message ?? 'no provider answered').slice(0, 270)}`, attempts: attempts as Prisma.InputJsonValue } });
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

  const amountXAF = convertToXAF(amount, quote);
  const chain = router.chain({ country: user.country, currency, method: input.method, amountXAF }, undefined, await fixedFeeConverter());
  if (!chain.length) throw new AppError(503, 'no_psp_available', 'No payment provider is available for this country / payment method right now');

  const phone = payerPhone(input, user, input.method);
  const { tx, fresh } = await reserveTransaction(
    userId, input.method, { purpose: 'gift_topup', amount, currency, method: input.method },
    {
      subscriptionId: user.subscription.id, userId, pspProvider: chain[0]!.name, amount, currency, amountXAF, fxRate: fxRateOf(quote), status: 'pending',
      reference: `sf${refId()}`, purpose: 'gift_topup', plan: null, interval: 'monthly', method: input.method, phone: phone || null,
    },
  );
  if (!fresh) return awaitDispatch(tx);
  return dispatchCheckout(tx, chain, user, 'SurveyFlow gift wallet top-up', phone);
}

/**
 * Asks the PSP what really happened and settles accordingly. Used by webhooks, by the status poll and by the reconciliation job.
 *
 * What is asked: a pending payment always; a failed or expired one while a late success is still possible (7 days, and only if it ever reached a
 * provider), and for a webhook ALWAYS (a provider telling us "paid" about a payment we gave up on is exactly the case that must not be dropped).
 * A success and a payment in review are never asked again. This function never expires a payment: only the reconciliation job does, after a
 * last look at the provider.
 *
 * `force` is for callers that must not skip a verification (a PSP webhook: the PSP will not call again once it got an answer; the reconciliation
 * job). Polls leave it off: a browser asking every 3 s must not become 20 calls a minute to the provider, so a verification already done or
 * running within the last moment is reused. `verifyError` says the provider could not be asked (its verify endpoint is down, or our database
 * hiccuped), as opposed to "asked, still pending".
 */
export async function refreshTransaction(
  tx: PaymentTransaction, router: PSPRouter = pspRouter, log?: SettleLog, opts: { force?: boolean } = {},
): Promise<{ tx: PaymentTransaction; outcome: SettleOutcome; verifyError: boolean }> {
  const late = tx.status === 'failed' || tx.status === 'expired';
  const askable = tx.status === 'pending' || (late && (!!opts.force || (isDispatched(tx) && tx.createdAt.getTime() > Date.now() - LATE_WINDOW_MS)));
  if (!askable) return { tx, outcome: 'already_settled', verifyError: false };
  const adapter = router.getAdapter(tx.pspProvider);
  if (!adapter) throw conflict('unknown_psp', `Unknown provider ${tx.pspProvider}`);
  if (!opts.force && (await redis.set(`sf:pay:verify:${tx.id}`, '1', 'PX', late ? 30_000 : 1_500, 'NX')) !== 'OK') {
    return { tx: await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tx.id } }), outcome: 'pending', verifyError: false };
  }
  let outcome: SettleOutcome = 'pending';
  let verifyError = false;
  try {
    outcome = await settleTransaction(tx.id, await adapter.verifyPayment({ reference: tx.reference, pspReference: tx.pspReference }), log);
  } catch (err) {
    outcome = 'pending'; // PSP verify endpoint down (or our database): stay as is, a later poll/webhook/reconciliation run will settle it
    verifyError = true;
    log?.warn({ txId: tx.id, psp: tx.pspProvider, err: (err as Error).message }, 'PSP verification failed; payment stays as it is');
  }
  await prisma.paymentTransaction.updateMany({ where: { id: tx.id }, data: { lastCheckedAt: new Date() } }).catch(() => undefined);
  return { tx: await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tx.id } }), outcome, verifyError };
}
