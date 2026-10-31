import { redis } from '../../lib/redis';

/**
 * A tiny per-provider circuit breaker, shared by every API replica through Redis.
 *
 * Why: when a provider is down, every checkout would first wait out its 20 s timeout before failing over, and keep hammering it. After
 * THREE failures within two minutes the provider is "open": it is moved to the END of the failover chain (never removed: if it is the only
 * one left, trying it is still better than telling the customer nothing works). After two minutes it is tried again; a single failure in
 * that trial re-opens it at once, a success closes it.
 */
const FAILS = (psp: string) => `sf:psp:fails:${psp}`;
const OPEN = (psp: string) => `sf:psp:open:${psp}`;
const RECENTLY_OPEN = (psp: string) => `sf:psp:recentlyopen:${psp}`;

export const BREAKER_THRESHOLD = 3;
export const BREAKER_OPEN_MS = 120_000;

export async function breakerOpen(psp: string): Promise<boolean> {
  return (await redis.exists(OPEN(psp))) === 1;
}

export async function breakerFail(psp: string): Promise<void> {
  const n = await redis.incr(FAILS(psp));
  if (n === 1) await redis.pexpire(FAILS(psp), BREAKER_OPEN_MS);
  const wasTrial = (await redis.exists(RECENTLY_OPEN(psp))) === 1; // the first failure after a cool-down re-opens immediately
  if (n >= BREAKER_THRESHOLD || wasTrial) {
    await redis.set(OPEN(psp), '1', 'PX', BREAKER_OPEN_MS);
    await redis.set(RECENTLY_OPEN(psp), '1', 'PX', BREAKER_OPEN_MS * 5);
    await redis.del(FAILS(psp));
  }
}

export async function breakerOk(psp: string): Promise<void> {
  await redis.del(FAILS(psp), OPEN(psp), RECENTLY_OPEN(psp));
}
