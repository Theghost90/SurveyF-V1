import { redis } from './redis';

/** INCR with an expiry set on the first hit, in one step (a key without an expiry would count for ever). */
const INCR_EXPIRE = `local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return n`;

/** Adds one to a fixed-window counter and returns the new value. */
export async function hit(key: string, windowSeconds: number): Promise<number> {
  return Number(await redis.eval(INCR_EXPIRE, 1, `sf:c:${key}`, String(windowSeconds)));
}

export async function peek(key: string): Promise<number> {
  return Number((await redis.get(`sf:c:${key}`)) ?? 0);
}

export async function clear(...keys: string[]): Promise<void> {
  if (keys.length) await redis.del(...keys.map((k) => `sf:c:${k}`));
}

/** True while the counter is within `limit` (the hit is counted either way). */
export async function within(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  return (await hit(key, windowSeconds)) <= limit;
}

/** Adds `n` to a window counter (a row total), setting the expiry if the counter is new. */
export async function addRows(key: string, n: number, windowSeconds: number): Promise<number> {
  return Number(await redis.eval(`local v = redis.call('INCRBY', KEYS[1], ARGV[2]); if v == tonumber(ARGV[2]) then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return v`, 1, `sf:c:${key}`, String(windowSeconds), String(Math.max(0, Math.floor(n)))));
}

/**
 * Counts DISTINCT ids seen under a key within a window (a HyperLogLog: a few kilobytes however many ids, about 1 % off) and returns the count after adding `ids`.
 * Looking at the same id again does not raise it. The window starts with the first id and the key expires with it.
 */
export async function distinctAdd(key: string, ids: string[], windowSeconds: number): Promise<number> {
  const script = `if #ARGV > 1 then redis.call('PFADD', KEYS[1], unpack(ARGV, 2)) end; if redis.call('TTL', KEYS[1]) < 0 and redis.call('EXISTS', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return redis.call('PFCOUNT', KEYS[1])`;
  return Number(await redis.eval(script, 1, `sf:c:${key}`, String(windowSeconds), ...ids));
}
