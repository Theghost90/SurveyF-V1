import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { safeEqual } from './crypto';

/**
 * "The API is reachable only through the website."
 *
 * The website's server (Next) is the front door: it reads the visitor's real country from the platform's header, attaches the
 * session token, and forwards the call together with a shared secret (`x-internal-secret`). When INTERNAL_API_SECRET is set,
 * the API refuses everything that does not carry that secret, EXCEPT the three things other parties must be able to call
 * directly: Meta's webhook, the payment providers' webhooks, and the receipt links participants open in their browser
 * (each protected by its own signature / signed token), plus the health check.
 *
 * This is the application-level half. The network-level half (private network / firewall that admits only the website, plus the
 * three public paths) is a deployment setting: see docs/DECISIONS.md §3.3 and the deploy templates.
 */
const PUBLIC_PATHS: RegExp[] = [
  /^\/healthz$/,
  /^\/api\/webhook\/whatsapp$/,
  /^\/api\/payments\/webhook\/[a-z0-9_-]+$/i,
  /^\/api\/receipts\/[A-Za-z0-9._-]+$/,
];

export const isPublicPath = (url: string): boolean => {
  const path = url.split('?')[0] ?? '';
  return PUBLIC_PATHS.some((re) => re.test(path));
};

/** True when this request carries the website's shared secret. Always true while no secret is configured (local development). */
export function fromWebsite(req: FastifyRequest, secret: string | undefined = env.INTERNAL_API_SECRET): boolean {
  if (!secret) return true;
  const raw = req.headers['x-internal-secret'];
  const given = Array.isArray(raw) ? raw[0] : raw;
  return !!given && safeEqual(given, secret);
}

export function registerInternalGate(app: FastifyInstance) {
  // The secret is read per request (not captured), so enabling it never needs a restart of the hook and tests can toggle it.
  app.addHook('onRequest', async (req, reply) => {
    if (!env.INTERNAL_API_SECRET || req.method === 'OPTIONS') return;
    if (isPublicPath(req.url) || fromWebsite(req)) return;
    return reply.code(403).send({ error: 'forbidden', message: 'This API is only reachable through the SurveyFlow website' });
  });
}
