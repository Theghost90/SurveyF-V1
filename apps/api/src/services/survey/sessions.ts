import { env } from '../../config/env';
import { redis } from '../../lib/redis';
import type { SessionState } from './engine';

/**
 * Active sessions live in Redis, keyed by (business number, participant).
 *
 * The spec keys by participant phone only (`session:${phone}`). That breaks as soon as one
 * participant is surveyed by two businesses (two WABAs) — their answers would cross over —
 * so the business's phone_number_id is part of the key.
 *
 * Durable truth (answers, funnel status) is in Postgres; if Redis is wiped, sessions are
 * rebuilt from SurveyRecipient + Response when the participant next replies.
 */
export const sessionKey = (phoneNumberId: string, waId: string) => `sf:sess:${phoneNumberId}:${waId}`;
const DEADLINES = 'sf:deadlines';

export const timeoutMs = () => env.SESSION_TIMEOUT_HOURS * 3_600_000;

export async function getSession(phoneNumberId: string, waId: string): Promise<SessionState | null> {
  const raw = await redis.get(sessionKey(phoneNumberId, waId));
  return raw ? (JSON.parse(raw) as SessionState) : null;
}

export async function saveSession(phoneNumberId: string, waId: string, s: SessionState): Promise<void> {
  const key = sessionKey(phoneNumberId, waId);
  const due = new Date(s.lastInteractionAt).getTime() + timeoutMs();
  await redis.multi().set(key, JSON.stringify(s), 'PX', timeoutMs() + 3_600_000).zadd(DEADLINES, due, key).exec();
}

export async function deleteSession(phoneNumberId: string, waId: string): Promise<void> {
  const key = sessionKey(phoneNumberId, waId);
  await redis.multi().del(key).zrem(DEADLINES, key).exec();
}

/** Keys of sessions whose inactivity deadline has passed. */
export async function dueSessionKeys(now = Date.now(), limit = 200): Promise<string[]> {
  return redis.zrangebyscore(DEADLINES, '-inf', now, 'LIMIT', 0, limit);
}

export async function loadSessionByKey(key: string): Promise<SessionState | null> {
  const raw = await redis.get(key);
  return raw ? (JSON.parse(raw) as SessionState) : null;
}

export async function dropSessionByKey(key: string): Promise<void> {
  await redis.multi().del(key).zrem(DEADLINES, key).exec();
}

/** "sf:sess:<phoneNumberId>:<waId>" -> parts. */
export function parseSessionKey(key: string): { phoneNumberId: string; waId: string } {
  const [, , phoneNumberId, waId] = key.split(':');
  return { phoneNumberId: phoneNumberId!, waId: waId! };
}
