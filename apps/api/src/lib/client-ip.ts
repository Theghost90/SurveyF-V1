import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { fromWebsite } from './internal-gate';

/**
 * Who is really calling.
 *
 * The API sits behind the website's server, so the socket's address is always that server's. The visitor's address is worked out by the WEBSITE (from
 * the platform's header or a configured number of trusted proxies, see apps/web/src/lib/client-ip.ts) and forwarded as `x-sf-client-ip` together with the
 * shared secret. The API believes that header ONLY on a request that carries the secret; anything else, including a stray X-Forwarded-For, is ignored, so
 * nobody can pick their own address to dodge a rate limit or hide in the audit trail. (Fastify's `trustProxy` is off for the same reason.)
 */
const cache = new WeakMap<FastifyRequest, string>();

export function clientIp(req: FastifyRequest): string {
  const known = cache.get(req);
  if (known) return known;
  let ip: string | undefined;
  if (fromWebsite(req)) {
    const raw = req.headers['x-sf-client-ip'];
    const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (v && isIP(v)) ip = v;
  }
  ip ??= (req.socket?.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  cache.set(req, ip);
  return ip;
}

/** "41.202.207.x" / "2001:db8:85a3::": enough to recognise a place, never to identify a person. */
export function ipPrefix(ip: string | undefined | null): string | null {
  if (!ip) return null;
  if (isIP(ip) === 4) return ip.split('.').slice(0, 3).join('.') + '.x';
  if (isIP(ip) === 6) return ip.split(':').slice(0, 3).join(':') + '::';
  return null;
}
