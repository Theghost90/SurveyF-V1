import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { clientIp } from './client-ip';
import { hit } from './counters';
import { canonicalEmail } from './email';
import { verifyAccessToken } from './jwt';

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
      // the address with its aliases folded (john.doe@ = johndoe@ = johndoe+x@ at Gmail): spelling it differently must not buy a fresh allowance
      keyGenerator: (req: FastifyRequest) => `${canonicalEmail(String((req.body as { email?: unknown } | undefined)?.email ?? '').slice(0, 254))}|${clientIp(req)}`,
    },
  },
});

/**
 * Calls the global rate limit must not touch. Only Meta's webhook: its volume follows our customers' participants and Meta signs every call.
 * The payment providers' webhooks are NOT exempt (they carry their own, generous, per-route limit): some providers cannot sign, so the
 * address is public, and every call there can cost us a verification request to the provider.
 */
export const isRateLimitExempt = (url: string): boolean => url.startsWith('/api/webhook/');

/**
 * The key of the general limit (SEC-18). One shared limit per public address punishes everybody behind a carrier-grade NAT for the traffic of the busiest one, and a
 * busy page that polls (the analytics screen asks every ten seconds) fills it. So a call carrying an API token this server signed counts against ITS SESSION: the
 * signature, issuer, audience and expiry are checked (cheap, no database), so nobody can pick a session id to land in a fresh bucket. Anything else (no token, a forged
 * or expired one, a public page) counts against the visitor's address. A revoked session's token still verifies and is still counted: it is rejected later, by the auth hook.
 */
export async function generalRateKey(req: FastifyRequest): Promise<string> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      return `s:${(await verifyAccessToken(header.slice(7))).sessionId}`;
    } catch { /* not a token we signed: the address pays for it */ }
  }
  return `ip:${clientIp(req)}`;
}

/**
 * The ceiling per ADDRESS, whatever sessions it carries (SEC-18). Many sessions from one address would otherwise multiply the per-session allowance without limit.
 * Redis-backed so that several API processes share it. If Redis is unreachable it lets the call through (the sign-in guards that need Redis fail closed on their own).
 */
export async function addressFloodGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.method === 'OPTIONS' || isRateLimitExempt(req.url)) return;
  const max = env.RATE_LIMIT_IP_PER_MINUTE; // read per request, so that a test can lower it
  let n: number;
  try { n = await hit(`flood:${clientIp(req)}`, 60); } catch { return; }
  if (n > max) {
    reply.header('retry-after', '60');
    return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests from this address: wait a minute and try again' });
  }
}
