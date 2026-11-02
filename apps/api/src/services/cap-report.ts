import { prisma } from '../lib/prisma';

/**
 * BIZ-03: what the first weeks say about the free plan's cap on different people reached, as AGGREGATES only (the platform-wide analytics of ADM-03 are not built, and this
 * does not wait for them: it reads the counts that `CapSignal` keeps and names nobody). A group of fewer than `MIN_GROUP` owners is reported as "fewer than N", never as a
 * number, so that a small beginning cannot point at one account.
 *
 * What it can show: how many owners ran into the cap, how many of those paid soon after, how many people owners had reached when they paid. What it cannot show: WHY somebody
 * paid or left. Nothing in it is a verdict on the number 5; it is the evidence a person needs to make that call.
 */
export const MIN_GROUP = 5;
const DAY = 86_400_000;

export interface CapReport {
  since: Date;
  exploreOwners: number | string;
  blockedOwners: number | string;
  blockedByJoinLink: number | string;
  paidAfterBlocked7d: number | string;
  paidAfterBlockedShare: number | null;
  paidWithoutBlock: number | string;
  stuckAfterBlocked14d: number | string;
  reachedAtActivation: { median: number | null; p25: number | null; p75: number | null } | 'fewer than 5 owners';
  notes: string[];
}

const small = (n: number): number | string => (n < MIN_GROUP ? `fewer than ${MIN_GROUP}` : n);
const pctile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

export async function capReport(now = new Date(), sinceDays = 90): Promise<CapReport> {
  const since = new Date(now.getTime() - sinceDays * DAY);
  const signals = await prisma.capSignal.findMany({ where: { at: { gte: since } }, select: { userId: true, kind: true, reached: true, at: true }, orderBy: { at: 'asc' } });
  const exploreOwners = await prisma.user.count({ where: { createdAt: { gte: since } } });
  const byUser = new Map<string, typeof signals>();
  for (const s of signals) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);

  let blocked = 0, joinBlocked = 0, paidAfter = 0, paidNoBlock = 0, stuck = 0;
  const reachedAtActivation: number[] = [];
  for (const rows of byUser.values()) {
    const firstBlock = rows.find((r) => r.kind === 'send_blocked' || r.kind === 'join_refused');
    const activated = rows.find((r) => r.kind === 'activated');
    if (rows.some((r) => r.kind === 'send_blocked')) blocked++;
    if (rows.some((r) => r.kind === 'join_refused')) joinBlocked++;
    if (activated) reachedAtActivation.push(activated.reached);
    if (firstBlock && activated && activated.at.getTime() >= firstBlock.at.getTime() && activated.at.getTime() - firstBlock.at.getTime() <= 7 * DAY) paidAfter++;
    else if (!firstBlock && activated) paidNoBlock++;
    if (firstBlock && !activated && now.getTime() - firstBlock.at.getTime() > 14 * DAY) stuck++;
  }
  const everBlocked = [...byUser.values()].filter((r) => r.some((x) => x.kind === 'send_blocked' || x.kind === 'join_refused')).length;
  const sorted = reachedAtActivation.sort((a, b) => a - b);
  return {
    since,
    exploreOwners: small(exploreOwners),
    blockedOwners: small(blocked),
    blockedByJoinLink: small(joinBlocked),
    paidAfterBlocked7d: small(paidAfter),
    paidAfterBlockedShare: everBlocked >= MIN_GROUP ? Math.round((paidAfter / everBlocked) * 100) : null,
    paidWithoutBlock: small(paidNoBlock),
    stuckAfterBlocked14d: small(stuck),
    reachedAtActivation: sorted.length < MIN_GROUP ? 'fewer than 5 owners' : { median: pctile(sorted, 50), p25: pctile(sorted, 25), p75: pctile(sorted, 75) },
    notes: [
      'Owners who paid without ever being blocked paid for something other than the cap (a gift, the bot, a second survey): the cap was not their reason.',
      'Owners stuck after a block may have left, may be waiting for money, or may have found a way round it (a second account): this report cannot tell which.',
      'A small number says "not enough owners yet", not "the cap is right".',
    ],
  };
}
