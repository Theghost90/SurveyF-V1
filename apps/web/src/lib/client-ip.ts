import { isIP } from 'node:net';
import { countryFromHeaders } from './geo';

/**
 * The visitor's address, as the website's server can know it (SEC-07).
 *
 * The API is called by this server, so its own view of the caller is always this server. The real visitor address is read here, from what the platform in
 * front of the site says, and forwarded to the API in `x-sf-client-ip` together with the shared secret (the API believes that header only with the secret).
 * Exactly one of these must be configured, matching the deployment:
 *   CLIENT_IP_HEADER     the header the CDN or platform sets to the visitor's address and that a visitor cannot forge: cf-connecting-ip (Cloudflare),
 *                        x-real-ip (nginx that sets it), x-vercel-forwarded-for (Vercel), fly-client-ip (Fly.io)
 *   TRUSTED_PROXY_HOPS   how many proxies of yours sit in front of this server; the visitor is that many entries from the RIGHT of x-forwarded-for
 *                        (the left side is whatever the visitor typed). 1 behind one nginx or load balancer.
 * With neither the address is unknown and the sign-in limits cannot tell visitors apart: that is fine on a laptop and a problem in production.
 */
export type HeaderGetter = { get(name: string): string | null };

/** NextAuth hands its request headers as a plain object; route handlers have a Headers. */
export const headerGetter = (h: Headers | Record<string, string | string[] | undefined>): HeaderGetter =>
  typeof (h as Headers).get === 'function'
    ? (h as Headers)
    : { get: (name) => { const v = (h as Record<string, string | string[] | undefined>)[name.toLowerCase()]; return (Array.isArray(v) ? v[0] : v) ?? null; } };

let warned = false;

export function clientIpFrom(h: HeaderGetter): string | undefined {
  const header = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (header) {
    const v = h.get(header)?.trim();
    // A list ("a, b") is a forwarding chain, whose first entry the visitor chose: that is TRUSTED_PROXY_HOPS's job, never a single-header setting.
    return v && !v.includes(',') && isIP(v) ? v : undefined;
  }
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);
  if (hops > 0) {
    const parts = (h.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const v = parts[parts.length - hops];
    return v && isIP(v) ? v : undefined;
  }
  if (process.env.NODE_ENV === 'production' && !warned) {
    warned = true;
    console.warn('[security] Neither CLIENT_IP_HEADER nor TRUSTED_PROXY_HOPS is set: every visitor looks like the same address, so the sign-in limits and the security log cannot tell them apart.');
  }
  return undefined;
}

/** What the API should know about the caller, taken from a request to the website. */
export function forwardedFrom(h: HeaderGetter): Record<string, string> {
  const out: Record<string, string> = {};
  const ip = clientIpFrom(h);
  if (ip) out['x-sf-client-ip'] = ip;
  const ua = h.get('user-agent');
  if (ua) out['user-agent'] = ua.slice(0, 300);
  // Only when the platform really told us; the API treats a missing header as "unknown" and never overwrites stored data with a guess.
  const country = countryFromHeaders(h);
  if (country) out['x-sf-country'] = country;
  return out;
}
