import { redis } from '../lib/redis';

/**
 * What a job leaves behind each time it ran: when, whether it worked, how long it took, and how often it is meant to run. A job that did not run (it was not the leader, or the
 * process is gone) leaves nothing, and its last heartbeat gets old: that is what the watchdog looks for. Best effort: failing to write one never fails the job.
 */
export interface Beat { at: string; ms: number; ok: boolean; tookMs: number; error?: string }
const key = (name: string) => `sf:job:hb:${name}`;

export async function beat(name: string, everyMs: number, ok: boolean, tookMs: number, error?: string): Promise<void> {
  try {
    const b: Beat = { at: new Date().toISOString(), ms: everyMs, ok, tookMs, ...(error ? { error: error.slice(0, 200) } : {}) };
    await redis.set(key(name), JSON.stringify(b), 'EX', 8 * 86_400);
  } catch {
    /* a heartbeat is a convenience */
  }
}

export async function lastBeat(name: string): Promise<Beat | null> {
  try {
    const raw = await redis.get(key(name));
    return raw ? (JSON.parse(raw) as Beat) : null;
  } catch {
    return null;
  }
}
