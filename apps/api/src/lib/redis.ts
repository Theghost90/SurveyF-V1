import { Redis } from 'ioredis';
import { env } from '../config/env';

export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
redis.on('error', (err) => console.error('[redis]', err.message));

/** Runs `fn` while holding a short Redis lock (serialises concurrent webhooks of one session). */
export async function withLock<T>(key: string, fn: () => Promise<T>, opts: { ttlMs?: number; waitMs?: number } = {}): Promise<T> {
  const ttl = opts.ttlMs ?? 15_000;
  const deadline = Date.now() + (opts.waitMs ?? 5_000);
  const token = Math.random().toString(36).slice(2);
  const lockKey = `sf:lock:${key}`;
  for (;;) {
    if ((await redis.set(lockKey, token, 'PX', ttl, 'NX')) === 'OK') break;
    if (Date.now() > deadline) throw new Error(`lock timeout: ${key}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    return await fn();
  } finally {
    // Release only if we still own it (compare-and-delete).
    await redis.eval(`if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`, 1, lockKey, token);
  }
}

/** Leader election for background jobs when several API replicas run. */
export async function tryLeader(name: string, ttlMs: number): Promise<boolean> {
  return (await redis.set(`sf:leader:${name}`, '1', 'PX', ttlMs, 'NX')) === 'OK';
}
