import type { FastifyRequest } from 'fastify';

/**
 * The website's server resolves the visitor's country (CDN country header) and forwards it as `x-sf-country`, only when it is
 * actually known. A missing header means "unknown", never "Cameroon": callers must not overwrite stored data with a guess.
 */
export function detectedCountry(req: FastifyRequest): string | undefined {
  const raw = req.headers['x-sf-country'];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
  return v && /^[A-Z]{2}$/.test(v) ? v : undefined;
}
