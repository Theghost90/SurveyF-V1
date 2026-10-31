import { convertToXAF, eurQuote, isCfa, type Currency } from '@surveyflow/shared';
import { env } from '../config/env';
import { prisma, type Tx } from '../lib/prisma';
import { redis } from '../lib/redis';
import { audit } from './audit';
import { getRateTable } from './fx';
import { sendMail } from './mail';

/**
 * Payout limits (PAY-13). Money leaves SurveyFlow's side when a gift is paid to a phone number. A wallet topped up by card and then paid out to numbers the same
 * person controls is the cash-out route for a stolen card, and the chargeback arrives after the money has gone (docs/PAYMENTS.md section 5.1). So:
 *
 *   - a hold on the payouts of an account that is only a few days old (PAYOUT_HOLD_DAYS);
 *   - a cap on what one account can pay out in any rolling 24 hours (PAYOUT_ACCOUNT_MAX_XAF_PER_DAY);
 *   - a cap on what one PHONE NUMBER can receive in any rolling 24 hours, from every account together, in amount and in count (PAYOUT_PHONE_*): the same few
 *     numbers receiving from many fresh accounts is exactly the pattern, and no single owner's limit would see it. The number is matched by its keyed hash, never by
 *     reading it.
 *
 * WHEN: at the moment the gift is planned, before the participant is told anything. A gift that is held is NOT debited and NOT promised (the participant gets a plain
 * thank-you, as for an empty wallet); it is released by itself, oldest first, once the limit allows (jobs/scheduler: releaseHeldGifts). The owner's own "release"
 * and "retry" buttons go through the same check, so a limit cannot be walked around by pressing them.
 *
 * STRICT UNDER CONCURRENCY: two participants finishing at the same instant must not both pass a cap that only has room for one. The check takes a transaction-scoped
 * advisory lock per account and per phone number (always in that order, so two transactions cannot wait on each other) and counts only after holding them.
 */

export type HoldReason = 'young_account' | 'account_daily_cap' | 'phone_daily_cap' | 'amount_above_cap' | 'fx_unavailable';
export type PayoutDecision = { allow: true } | { allow: false; reason: HoldReason; /** null: it will not clear by itself */ until: Date | null };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The payout in CFA francs, the unit of every cap. CFA currencies and the euro are fixed pegs; any other currency needs a rate that is already known: the network is
 * never touched here (this runs inside a transaction). No rate: null, and the gift waits, because an amount that cannot be measured cannot be capped.
 */
export async function xafEquivalent(amount: number, currency: string): Promise<number | null> {
  if (isCfa(currency as Currency)) return Math.round(amount);
  if (currency === 'EUR') return convertToXAF(amount, eurQuote());
  const table = await getRateTable({ fetch: false });
  const rate = table?.rates[currency as Currency];
  return rate ? Math.round(amount / rate) : null;
}

/** Takes the two locks, account first and phone second, held until the transaction ends. */
export async function lockPayoutScope(tx: Tx, userId: string, phoneHash: string | null): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout:account:${userId}`}))`; // (executeRaw: the function returns void, which a query result cannot hold)
  if (phoneHash) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout:phone:${phoneHash}`}))`;
}

interface Totals { xaf: number; n: number }

/** What was committed in the last 24 hours and has not been definitely refunded: pending, sent, or failed with an unknown outcome (the money may have left). */
async function committed(tx: Tx, scope: { userId: string } | { phoneHash: string }, since: Date): Promise<Totals> {
  const [row] = 'userId' in scope
    ? await tx.$queryRaw<Array<{ xaf: number; n: number }>>`
        SELECT COALESCE(SUM(g."committedXAF"), 0)::int AS xaf, COUNT(*)::int AS n
        FROM "GiftDelivery" g JOIN "Survey" s ON s."id" = g."surveyId"
        WHERE g."committedAt" > ${since} AND g."giftType" IN ('airtime', 'momo') AND s."userId" = ${scope.userId}
          AND (g."status" IN ('pending', 'sent') OR (g."status" = 'failed' AND g."refundedAt" IS NULL))`
    : await tx.$queryRaw<Array<{ xaf: number; n: number }>>`
        SELECT COALESCE(SUM(g."committedXAF"), 0)::int AS xaf, COUNT(*)::int AS n
        FROM "GiftDelivery" g JOIN "Contact" c ON c."id" = g."contactId"
        WHERE g."committedAt" > ${since} AND g."giftType" IN ('airtime', 'momo') AND c."phoneHash" = ${scope.phoneHash}
          AND (g."status" IN ('pending', 'sent') OR (g."status" = 'failed' AND g."refundedAt" IS NULL))`;
  return { xaf: row?.xaf ?? 0, n: row?.n ?? 0 };
}

/**
 * May this payout be committed now? Call it AFTER `lockPayoutScope`, in the transaction that will debit the wallet. The order of the checks is the order of how
 * long each takes to clear: the age of the account first, then the measurable caps.
 */
export async function decidePayout(tx: Tx, p: { userId: string; phoneHash: string | null; amountXAF: number | null; accountCreatedAt: Date; now?: Date }): Promise<PayoutDecision> {
  const now = p.now ?? new Date();
  if (env.payoutHoldDays > 0) {
    const free = new Date(p.accountCreatedAt.getTime() + env.payoutHoldDays * DAY);
    if (now < free) return { allow: false, reason: 'young_account', until: free };
  }
  if (p.amountXAF === null) return { allow: false, reason: 'fx_unavailable', until: new Date(now.getTime() + HOUR) };
  const since = new Date(now.getTime() - DAY);
  if (p.amountXAF > env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY || p.amountXAF > env.PAYOUT_PHONE_MAX_XAF_PER_DAY) return { allow: false, reason: 'amount_above_cap', until: null };
  const account = await committed(tx, { userId: p.userId }, since);
  if (account.xaf + p.amountXAF > env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY) return { allow: false, reason: 'account_daily_cap', until: new Date(now.getTime() + HOUR) };
  if (p.phoneHash) {
    const phone = await committed(tx, { phoneHash: p.phoneHash }, since);
    if (phone.n + 1 > env.PAYOUT_PHONE_MAX_COUNT_PER_DAY || phone.xaf + p.amountXAF > env.PAYOUT_PHONE_MAX_XAF_PER_DAY) return { allow: false, reason: 'phone_daily_cap', until: new Date(now.getTime() + HOUR) };
  }
  return { allow: true };
}

/**
 * Tells the owner, once a day at most, that gifts are waiting because of a safety limit, and leaves a line in the audit trail. Called AFTER the transaction that
 * held the gift has committed (a mail must not leave for a transaction that may still roll back). Best effort: a failed mail never undoes a hold.
 */
export async function noteHeld(userId: string, held: { reason: HoldReason; until: Date | null }): Promise<void> {
  try {
    if ((await redis.set(`sf:payout-held:${userId}`, '1', 'EX', 86_400, 'NX')) !== 'OK') return;
    await audit({ userId }, { action: 'payout_held', meta: { reason: held.reason, until: held.until?.toISOString() ?? null } });
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true, locale: true } });
    if (u) await sendMail(u.email, 'payouts_held', u.locale === 'en' ? 'en' : 'fr', { name: u.name, what: held.reason, when: held.until?.toISOString().slice(0, 10) });
  } catch { /* see above */ }
}
