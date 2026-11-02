import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';

export type CapSignalKind = 'send_blocked' | 'join_refused' | 'activated';

/**
 * Facts about the free plan's cap on different people reached (BIZ-03). Best effort, counts only, and it must never fail the action it describes. A blocked owner presses
 * the same button many times and a link can be tried by many people: so one signal of each kind per owner per hour is kept, not every attempt (an `activated` signal is always kept:
 * it happens once).
 */
export async function recordCapSignal(userId: string, kind: CapSignalKind, o: { plan: string; cap: number | null; reached: number; wanted?: number }): Promise<void> {
  try {
    if (kind !== 'activated' && (await redis.set(`sf:capsig:${userId}:${kind}`, '1', 'EX', 3600, 'NX')) !== 'OK') return;
    await prisma.capSignal.create({ data: { userId, kind, plan: o.plan, cap: o.cap, reached: o.reached, wanted: o.wanted ?? null } });
  } catch {
    /* measuring must never break the product */
  }
}
