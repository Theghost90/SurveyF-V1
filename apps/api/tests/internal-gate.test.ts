import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env } from '../src/config/env';
import { isPublicPath } from '../src/lib/internal-gate';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { makeApp, resetAll } from './helpers';

const SECRET = 'a-shared-secret-of-the-website-server-0123456789';
const GATE_MESSAGE = /only reachable through the SurveyFlow website/;
let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); await resetAll(); });
afterEach(() => { env.INTERNAL_API_SECRET = undefined; });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });

const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  app.inject({ method, url, headers: { 'content-type': 'application/json', ...headers }, payload: payload === undefined ? undefined : JSON.stringify(payload) }).then((r) => ({ status: r.statusCode, body: r.body }));

describe('the API is reachable only through the website', () => {
  it('without a configured secret (local development) nothing is gated', async () => {
    expect((await call('GET', '/api/surveys')).status).toBe(401); // reaches the handler: "log in first", not "not through the website"
  });

  it('with the secret configured, a direct call is refused before any handler runs — including ones that would otherwise be public-ish', async () => {
    env.INTERNAL_API_SECRET = SECRET;
    for (const [m, url] of [['GET', '/api/surveys'], ['POST', '/api/auth/register'], ['POST', '/api/auth/login'], ['GET', '/api/subscription'], ['GET', '/api/wallet']] as const) {
      const r = await call(m, url);
      expect(r.status, `${m} ${url}`).toBe(403);
      expect(r.body).toMatch(GATE_MESSAGE);
    }
    expect((await call('GET', '/api/surveys', { 'x-internal-secret': 'wrong' })).status).toBe(403);
    expect((await call('GET', '/api/surveys', { 'x-internal-secret': SECRET.slice(0, -1) })).status).toBe(403);
  });

  it('the website (with the secret) gets through to the normal handlers', async () => {
    env.INTERNAL_API_SECRET = SECRET;
    expect((await call('GET', '/api/surveys', { 'x-internal-secret': SECRET })).status).toBe(401); // gate passed; no session token
    const reg = await call('POST', '/api/auth/register', { 'x-internal-secret': SECRET, 'x-sf-country': 'NG' },
      { businessName: 'Lagos Shop', name: 'Ngozi', email: 'ng-gate@example.com', phone: '0803 123 4567', password: 'correct-horse-battery' });
    expect(reg.status).toBe(201);
    expect(JSON.parse(reg.body).user).toMatchObject({ country: 'NG', preferredCurrency: 'NGN' }); // the website vouched for the country
  });

  it('exactly four things stay public: health, the Meta webhook, the PSP webhooks and receipt links — and they do not need the secret', async () => {
    env.INTERNAL_API_SECRET = SECRET;
    const open = [['GET', '/healthz'], ['GET', '/api/webhook/whatsapp'], ['POST', '/api/webhook/whatsapp'], ['POST', '/api/payments/webhook/notchpay'], ['GET', '/api/payments/webhook/campay'], ['GET', '/api/receipts/abc.def']] as const;
    for (const [m, url] of open) {
      const r = await call(m, url, {}, m === 'POST' ? {} : undefined);
      expect(r.body, `${m} ${url} must reach its own handler`).not.toMatch(GATE_MESSAGE);
    }
  });

  it('public-path matching cannot be tricked into exposing the rest', () => {
    for (const ok of ['/healthz', '/api/webhook/whatsapp', '/api/webhook/whatsapp?hub.mode=subscribe', '/api/payments/webhook/flutterwave', '/api/receipts/clx123.AbCdEf_-']) expect(isPublicPath(ok), ok).toBe(true);
    for (const no of [
      '/api/receipts/../auth/me', '/api/receipts/%2e%2e%2fauth%2fme', '/api/receipts/a/b', '/api/receipts/', '/api/webhook/whatsapp/x', '/api/webhook/other',
      '/api/payments/webhook/', '/api/payments/webhook/a/b', '/api/payments/initiate', '/healthz/x', '//api/surveys', '/api/auth/me',
    ]) expect(isPublicPath(no), no).toBe(false);
  });

  it('a country header without the secret is never believed (the gate would refuse it; the lookup ignores it too)', async () => {
    env.INTERNAL_API_SECRET = SECRET;
    const r = await call('POST', '/api/auth/register', { 'x-sf-country': 'KE' }, { businessName: 'X', name: 'Y', email: 'ke-gate@example.com', phone: '0712 345 678', password: 'correct-horse-battery' });
    expect(r.status).toBe(403);
    expect(await prisma.user.count({ where: { email: 'ke-gate@example.com' } })).toBe(0);
  });
});
