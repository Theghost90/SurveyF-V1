import type { FastifyRequest } from 'fastify';
import { env } from '../config/env';

/** Per-route rate limit. Relaxed 1000x under NODE_ENV=test so integration tests can register many users. */
export const rl = (max: number, timeWindow = '1 minute') => ({
  config: { rateLimit: { max: env.NODE_ENV === 'test' ? max * 1000 : max, timeWindow } },
});

/**
 * Credential endpoints: key by (email, client IP), evaluated after the body is parsed.
 * Keying by IP alone is wrong behind the Next.js server (every user would share its IP and one limit);
 * keying by email alone lets one IP try many accounts — so both are part of the key.
 * Trade-off: someone can burn a victim's per-minute attempts; they cannot get in, and it resets every minute.
 */
export const rlCredentials = (max = 10, timeWindow = '1 minute') => ({
  config: {
    rateLimit: {
      max: env.NODE_ENV === 'test' ? max * 1000 : max,
      timeWindow,
      hook: 'preHandler' as const,
      keyGenerator: (req: FastifyRequest) => `${String((req.body as { email?: unknown } | undefined)?.email ?? '').toLowerCase().slice(0, 254)}|${req.ip}`,
    },
  },
});

/**
 * Calls the global rate limit must not touch. Only Meta's webhook: its volume follows our customers' participants and Meta signs every call.
 * The payment providers' webhooks are NOT exempt (they carry their own, generous, per-route limit): some providers cannot sign, so the
 * address is public, and every call there can cost us a verification request to the provider.
 */
export const isRateLimitExempt = (url: string): boolean => url.startsWith('/api/webhook/');
