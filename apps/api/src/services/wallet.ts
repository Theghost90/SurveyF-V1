import { PAID_GIFT_TYPES, giftUnitCostFCFA } from '@surveyflow/shared';
import { env } from '../config/env';
import { prisma, type Tx } from '../lib/prisma';
import { redis } from '../lib/redis';
import { notifyOwner } from './notify';

/**
 * Prepaid gift wallet (the survey OWNER funds participant gifts — see docs/DECISIONS.md §3.1).
 *
 * Invariants:
 *  - The balance only changes through debitWallet / creditWallet, and a debit is ONE guarded UPDATE
 *    (`WHERE balance >= amount`), so concurrent completions can never push it below zero.
 *  - Every change writes a WalletEntry in the SAME transaction, so balance == sum(ledger) always.
 *  - Callers make debit/credit conditional on a compare-and-set state change (payment pending→success,
 *    gift pending→failed, gift unfunded→pending), which is what makes them idempotent.
 */

const positive = (n: number) => {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`wallet amount must be a positive integer, got ${n}`);
};

/** Takes `amount` iff the balance covers it. Returns the new balance, or null when funds are insufficient. */
export async function debitWallet(tx: Tx, userId: string, amount: number, refId: string, note?: string): Promise<number | null> {
  positive(amount);
  const rows = await tx.$queryRaw<Array<{ balance: number }>>`
    UPDATE "User" SET "giftBalanceFCFA" = "giftBalanceFCFA" - ${amount}::int
    WHERE "id" = ${userId} AND "giftBalanceFCFA" >= ${amount}::int
    RETURNING "giftBalanceFCFA" AS balance`;
  if (!rows.length) return null;
  await tx.walletEntry.create({ data: { userId, deltaFCFA: -amount, balanceAfter: rows[0]!.balance, kind: 'gift_debit', refId, note } });
  return rows[0]!.balance;
}

export async function creditWallet(tx: Tx, userId: string, amount: number, kind: 'topup' | 'gift_refund', refId: string, note?: string): Promise<number> {
  positive(amount);
  const rows = await tx.$queryRaw<Array<{ balance: number }>>`
    UPDATE "User" SET "giftBalanceFCFA" = "giftBalanceFCFA" + ${amount}::int WHERE "id" = ${userId} RETURNING "giftBalanceFCFA" AS balance`;
  if (!rows.length) throw new Error('wallet owner not found');
  await tx.walletEntry.create({ data: { userId, deltaFCFA: amount, balanceAfter: rows[0]!.balance, kind, refId, note } });
  return rows[0]!.balance;
}

/**
 * Money currently held by ONE gift according to the ledger (debits minus refunds). The ledger — not a status flag —
 * decides what a refund returns, so a legacy/seeded gift that was never debited can never "refund" money that never left.
 */
export async function heldByGift(tx: Tx, giftId: string): Promise<number> {
  const r = await tx.walletEntry.aggregate({ where: { refId: giftId, kind: { in: ['gift_debit', 'gift_refund'] } }, _sum: { deltaFCFA: true } });
  return Math.max(0, -(r._sum.deltaFCFA ?? 0));
}

const PAID = [...PAID_GIFT_TYPES];
const sumCost = (a: { _sum: { amountFCFA: number | null; feeFCFA: number | null } }) => (a._sum.amountFCFA ?? 0) + (a._sum.feeFCFA ?? 0);

export async function getWalletSummary(userId: string) {
  const sums = { amountFCFA: true, feeFCFA: true } as const;
  const [user, entries, pending, unfunded, held] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { giftBalanceFCFA: true } }),
    prisma.walletEntry.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 40 }),
    // in the provider pipeline: already debited, not yet delivered
    prisma.giftDelivery.aggregate({ where: { survey: { userId }, giftType: { in: PAID }, status: 'pending' }, _count: { _all: true }, _sum: sums }),
    // finished the survey but the wallet could not cover them: NOT debited, waiting for a top-up + release
    prisma.giftDelivery.aggregate({ where: { survey: { userId }, giftType: { in: PAID }, status: 'unfunded' }, _count: { _all: true }, _sum: sums }),
    // outcome unknown (timeout after sending): debited and deliberately NOT auto-refunded or retried
    prisma.giftDelivery.aggregate({ where: { survey: { userId }, giftType: { in: PAID }, status: 'failed', refundedAt: null }, _count: { _all: true }, _sum: sums }),
  ]);
  return {
    balanceFCFA: user.giftBalanceFCFA,
    feePercent: env.GIFT_FEE_PERCENT,
    inFlight: { count: pending._count._all, fcfa: sumCost(pending) },
    unfunded: { count: unfunded._count._all, fcfa: sumCost(unfunded) },
    needsCheck: { count: held._count._all, fcfa: sumCost(held) },
    entries: entries.map((e) => ({ id: e.id, at: e.createdAt, deltaFCFA: e.deltaFCFA, balanceAfter: e.balanceAfter, kind: e.kind, note: e.note })),
  };
}

/** Can the wallet cover this survey's gifts? Used for non-blocking warnings at publish / send time. */
export async function giftReadiness(userId: string, survey: { giftType: string; giftAmountFCFA: number | null; giftMaxCount: number | null; id: string }, invited?: number) {
  if (!(PAID as string[]).includes(survey.giftType) || !survey.giftAmountFCFA) return null;
  const [user, used] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { giftBalanceFCFA: true } }),
    prisma.giftDelivery.count({ where: { surveyId: survey.id } }),
  ]);
  const unitCostFCFA = giftUnitCostFCFA(survey.giftAmountFCFA, env.GIFT_FEE_PERCENT);
  const room = survey.giftMaxCount ? Math.max(0, survey.giftMaxCount - used) : null;
  const exposure = Math.min(invited ?? Infinity, room ?? Infinity);
  const worstCaseFCFA = Number.isFinite(exposure) ? exposure * unitCostFCFA : null;
  const covers = Math.floor(user.giftBalanceFCFA / unitCostFCFA);
  return {
    unitCostFCFA, balanceFCFA: user.giftBalanceFCFA, giftsCovered: covers, worstCaseFCFA,
    // "ok" = at least the first gift is covered, and (when we know the audience) every possible gift is.
    sufficient: worstCaseFCFA === null ? covers > 0 : user.giftBalanceFCFA >= worstCaseFCFA,
    empty: covers === 0,
  };
}

/**
 * Owners learn that their wallet ran dry from THIS notice, not by stumbling on it in analytics. At most one per owner per
 * day (Redis NX key), and only when participants were actually left unrewarded in the last 24h.
 */
export async function notifyEmptyWallets(): Promise<{ notified: number }> {
  const rows = await prisma.$queryRaw<Array<{ userId: string; n: bigint; locale: string }>>`
    SELECT s."userId" AS "userId", COUNT(*)::bigint AS n, u."locale" AS locale
    FROM "GiftDelivery" g JOIN "Survey" s ON s."id" = g."surveyId" JOIN "User" u ON u."id" = s."userId"
    WHERE g."status" = 'unfunded' AND g."createdAt" > now() - interval '24 hours'
    GROUP BY s."userId", u."locale"`;
  let notified = 0;
  for (const r of rows) {
    if (!(await redis.set(`sf:walletempty:${r.userId}`, '1', 'EX', 86_400, 'NX'))) continue;
    const n = Number(r.n);
    const link = `${env.webOrigins[0]}/billing`;
    await notifyOwner(
      r.userId,
      r.locale === 'fr'
        ? `⚠️ SurveyFlow : votre portefeuille cadeaux est vide. ${n} participant(s) ont terminé sans recevoir de cadeau. Rechargez puis libérez-les : ${link}`
        : `⚠️ SurveyFlow: your gift wallet is empty. ${n} participant(s) finished without getting their gift. Top up, then release them: ${link}`,
    );
    notified++;
  }
  return { notified };
}
