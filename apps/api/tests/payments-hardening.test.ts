import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma';
import { isRateLimitExempt } from '../src/lib/ratelimit';
import { redis } from '../src/lib/redis';
import { runRenewalNotices } from '../src/services/subscription/notices';
import { outboxKey } from '../src/services/whatsapp/mock';
import { PSPRouter } from '../src/services/payments/router';
import { initiatePayment, refreshTransaction, settleTransaction } from '../src/services/payments/service';
import { PspError, type PSPAdapter, type VerifyResult } from '../src/services/payments/types';
import { makeApp, registerOwner, resetAll } from './helpers';

/**
 * Payment hardening, in the order it was fixed: MINOR, then MAJOR, then CRITICAL (docs/PAYMENTS.md has the risk register).
 * Every test here failed before its fix: a green run is not decoration.
 */

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); await redis.flushdb(); });
afterEach(() => vi.unstubAllGlobals());

const momo = { plan: 'growth' as const, interval: 'monthly' as const, method: 'mobile_money' as const, phone: '+237677000001' };

/** A controllable provider: what it answers to verify, how often it was asked, and whether starting a payment works. */
interface Fake extends PSPAdapter { verifyCalls: number; setVerify(v: VerifyResult | Error): void; initCalls: number }
function fake(name: string, opts: { initFails?: 'definite' | 'ambiguous' | 'rejected'; push?: boolean; url?: string } = {}): Fake {
  let verify: VerifyResult | Error = { status: 'pending', amount: 0, currency: '' };
  const a: Fake = {
    name: name as never, push: opts.push, verifyCalls: 0, initCalls: 0,
    isConfigured: () => true,
    initiatePayment: async () => {
      a.initCalls++;
      if (opts.initFails === 'definite') throw new PspError('connection refused', name as never, true, false);
      if (opts.initFails === 'ambiguous') throw new PspError('timeout after sending', name as never, true, true);
      if (opts.initFails === 'rejected') throw new PspError('HTTP 401: invalid api key sk_live_secret', name as never, false, false);
      return { checkoutUrl: opts.url ?? `https://pay.example/${name}`, pspReference: `${name}-ref` };
    },
    verifyPayment: async () => { a.verifyCalls++; if (verify instanceof Error) throw verify; return verify; },
    parseWebhook: async () => ({ signatureValid: true }),
    setVerify: (v) => { verify = v; },
  };
  return a;
}
const routerOf = (...a: PSPAdapter[]) => new PSPRouter([...a, { ...fake('mock'), isConfigured: () => false }]);
const planOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).plan;
const txOf = (id: string) => prisma.paymentTransaction.findUniqueOrThrow({ where: { id } });
const quiet = { warn: () => undefined };

// ════════════════════════════════════════════════════════════════ MINOR ═══

describe('MINOR: what the customer sees and what we log', () => {
  it('m1 the browser gets a safe failure category, never the provider\'s own words', async () => {
    const o = await registerOwner(app);
    const router = routerOf(fake('notchpay', { initFails: 'rejected' }));
    await expect(initiatePayment(o.userId, momo, router)).rejects.toMatchObject({ status: 502 });
    const row = await prisma.paymentTransaction.findFirstOrThrow({ where: { userId: o.userId } });
    expect(row.failReason).toMatch(/^psp_unavailable: .*invalid api key/); // the operator keeps the detail
    const listed = (await o.get('/api/payments')).items[0];
    expect(listed.failCode).toBe('unavailable');
    expect(JSON.stringify(listed)).not.toMatch(/api key|sk_live|failReason|notchpay HTTP/);
  });

  it('m1 a provider decline is "declined", anything else "other"', async () => {
    const o = await registerOwner(app);
    const router = routerOf(fake('notchpay'));
    const tx = await initiatePayment(o.userId, momo, router);
    await settleTransaction(tx.id, { status: 'failed', amount: 0, currency: '' }, quiet);
    expect((await o.get('/api/payments')).items[0].failCode).toBe('declined');
  });

  it('m2 a browser polling every few seconds does not become a provider call each time; a webhook always verifies', async () => {
    const o = await registerOwner(app);
    const p = fake('notchpay');
    const router = routerOf(p);
    const tx = await initiatePayment(o.userId, momo, router);
    await Promise.all([refreshTransaction(tx, router), refreshTransaction(tx, router), refreshTransaction(tx, router)]);
    expect(p.verifyCalls).toBe(1);
    await refreshTransaction(tx, router, undefined, { force: true });
    await refreshTransaction(tx, router, undefined, { force: true });
    expect(p.verifyCalls).toBe(3); // a webhook is never skipped: the provider will not call again
  });

  it('m3 a provider whose verify endpoint is down is logged and flagged, and the payment stays pending', async () => {
    const o = await registerOwner(app);
    const p = fake('notchpay');
    const router = routerOf(p);
    const tx = await initiatePayment(o.userId, momo, router);
    p.setVerify(new Error('ECONNRESET'));
    const warn = vi.fn();
    const r = await refreshTransaction(tx, router, { warn }, { force: true });
    expect(r).toMatchObject({ outcome: 'pending', verifyError: true });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ txId: tx.id, psp: 'notchpay', err: 'ECONNRESET' }), expect.stringMatching(/verification failed/));
    expect((await txOf(tx.id)).status).toBe('pending');
  });

  it('m4 the Mobile Money number is validated and normalised against the owner\'s country', async () => {
    const o = await registerOwner(app);
    const router = routerOf(fake('notchpay'));
    for (const bad of ['abc', '12345', '+237 111 111 111', '0000000000']) {
      await expect(initiatePayment(o.userId, { ...momo, phone: bad }, router), bad).rejects.toMatchObject({ status: 400, code: 'invalid_phone' });
    }
    expect(await prisma.paymentTransaction.count()).toBe(0);
    const tx = await initiatePayment(o.userId, { ...momo, phone: '677 12 34 56' }, router); // local format
    expect(tx.phone).toBe('+237677123456');
  });

  it('m4 a card payment needs no phone number', async () => {
    const o = await registerOwner(app);
    const tx = await initiatePayment(o.userId, { ...momo, method: 'card', phone: undefined }, routerOf(fake('flutterwave')));
    expect(tx.status).toBe('pending');
  });

  it('m5 an overpayment credits only what was asked, and a big one is logged for a human', async () => {
    const o = await registerOwner(app);
    const router = routerOf(fake('notchpay'));
    const tx = await initiatePayment(o.userId, momo, router);
    const warn = vi.fn();
    expect(await settleTransaction(tx.id, { status: 'success', amount: 39000 * 3, currency: 'XAF' }, { warn })).toBe('activated');
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/OVERPAID/));
    expect(await planOf(o.userId)).toBe('growth');

    const tx2 = await initiatePayment(o.userId, { ...momo, plan: 'business' }, router);
    const warn2 = vi.fn();
    await settleTransaction(tx2.id, { status: 'success', amount: Math.round(tx2.amount * 1.05), currency: 'XAF' }, { warn: warn2 }); // a buyer-side processing fee
    expect(warn2).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════ MAJOR ═══

describe('MAJOR: webhooks', () => {
  const makeTx = async (userId: string) => {
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
    return prisma.paymentTransaction.create({ data: { subscriptionId: sub.id, userId, pspProvider: 'flutterwave', amount: 39000, currency: 'XAF', status: 'pending', reference: 'sfmajorref001', plan: 'growth', interval: 'monthly', method: 'card' } });
  };
  const hook = () => app.inject({ method: 'POST', url: '/api/payments/webhook/flutterwave', headers: { 'content-type': 'application/json', 'verif-hash': 'flw-hash-123' }, payload: JSON.stringify({ data: { tx_ref: 'sfmajorref001', status: 'successful', id: 5 } }) });
  const verify = (status: string, amount: number) => vi.fn(async () => new Response(JSON.stringify({ status: 'success', data: { status, amount, currency: 'XAF', id: 5 } }), { status: 200 }));

  it('M1 a signed webhook we could not verify is answered 503 so the provider retries; once verified, any outcome is 200', async () => {
    const o = await registerOwner(app);
    await makeTx(o.userId);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('PSP verification endpoint down'); }));
    expect((await hook()).statusCode).toBe(503);
    vi.stubGlobal('fetch', verify('pending', 0));
    expect((await hook()).statusCode).toBe(200);
    vi.stubGlobal('fetch', verify('successful', 39000));
    expect((await hook()).statusCode).toBe(200);
    expect(await planOf(o.userId)).toBe('growth');
  });

  it('M6 only Meta\'s webhook is exempt from rate limiting; a payment provider\'s is not', () => {
    expect(isRateLimitExempt('/api/webhook/whatsapp')).toBe(true);
    expect(isRateLimitExempt('/api/payments/webhook/cinetpay?cpm_trans_id=x')).toBe(false);
    expect(isRateLimitExempt('/api/payments/initiate')).toBe(false);
  });
});

describe('MAJOR: starting a payment', () => {
  const card = { plan: 'growth' as const, interval: 'monthly' as const, method: 'card' as const };

  it('M3 eight simultaneous clicks start ONE payment at the provider, and every click gets its checkout', async () => {
    const o = await registerOwner(app);
    const p = fake('notchpay');
    const router = routerOf(p);
    const results = await Promise.all(Array.from({ length: 8 }, () => initiatePayment(o.userId, card, router)));
    expect(await prisma.paymentTransaction.count({ where: { userId: o.userId } })).toBe(1);
    expect(p.initCalls).toBe(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.every((r) => r.checkoutUrl === 'https://pay.example/notchpay')).toBe(true);
  });

  it('M4 a Mobile Money retry after the prompt has died gets a NEW prompt; a hosted card page is reused for ten minutes', async () => {
    const o = await registerOwner(app);
    const p = fake('notchpay');
    const router = routerOf(p);
    const a = await initiatePayment(o.userId, momo, router);
    expect((await initiatePayment(o.userId, momo, router)).id).toBe(a.id); // a double-click a moment later: same prompt
    await prisma.paymentTransaction.update({ where: { id: a.id }, data: { createdAt: new Date(Date.now() - 100_000) } });
    const b = await initiatePayment(o.userId, momo, router);
    expect(b.id).not.toBe(a.id);

    const c = await initiatePayment(o.userId, { ...momo, method: 'card' }, router);
    await prisma.paymentTransaction.update({ where: { id: c.id }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    expect((await initiatePayment(o.userId, { ...momo, method: 'card' }, router)).id).toBe(c.id);
    await prisma.paymentTransaction.update({ where: { id: c.id }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    expect((await initiatePayment(o.userId, { ...momo, method: 'card' }, router)).id).not.toBe(c.id);
  });

  it('M4 a row that was never started at a provider (the process died) is not handed back', async () => {
    const o = await registerOwner(app);
    const router = routerOf(fake('notchpay'));
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: o.userId } });
    const ghost = await prisma.paymentTransaction.create({ data: { subscriptionId: sub.id, userId: o.userId, pspProvider: 'notchpay', amount: 39000, currency: 'XAF', status: 'pending', reference: 'sfghost001', purpose: 'subscription', plan: 'growth', interval: 'monthly', method: 'card', createdAt: new Date(Date.now() - 60_000) } });
    const tx = await initiatePayment(o.userId, card, router);
    expect(tx.id).not.toBe(ghost.id);
    expect(tx.checkoutUrl).toBeTruthy();
  });

  it('M4 a customer cannot have more than four payments in flight', async () => {
    const o = await registerOwner(app);
    const router = routerOf(fake('notchpay'));
    for (const [plan, interval] of [['growth', 'monthly'], ['growth', 'annual'], ['business', 'monthly'], ['business', 'annual']] as const) await initiatePayment(o.userId, { ...card, plan, interval }, router);
    await expect(initiatePayment(o.userId, { ...card, plan: 'starter' }, router)).rejects.toMatchObject({ status: 429, code: 'too_many_pending' });
  });

  it('M5 a lower plan cannot be bought through ANY route while a higher one is active (it would replace it and burn what is left)', async () => {
    const o = await registerOwner(app, { plan: 'business' });
    const r = await o.raw('POST', '/api/payments/initiate', { plan: 'starter', interval: 'monthly', method: 'mobile_money', phone: '+237677000001' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('downgrade_not_supported');
    expect(await prisma.paymentTransaction.count()).toBe(0);
    const same = await o.raw('POST', '/api/payments/initiate', { plan: 'business', interval: 'monthly', method: 'mobile_money', phone: '+237677000001' });
    expect(same.status).toBe(201); // renewing the same plan is fine
  });
});

describe('MAJOR: a failing provider does not slow every checkout', () => {
  const card = { plan: 'growth' as const, interval: 'monthly' as const, method: 'card' as const };
  const combos = [['growth', 'monthly'], ['growth', 'annual'], ['business', 'monthly'], ['business', 'annual']] as const;

  it('M7 after three failures a provider moves to the end of the chain; one failed trial re-opens it; a success closes it', async () => {
    const o = await registerOwner(app);
    const probe = routerOf(fake('notchpay'), fake('flutterwave'));
    const firstName = probe.chain({ country: 'CM', currency: 'XAF', method: 'card', amountXAF: 39000 })[0]!.name;
    const secondName = firstName === 'notchpay' ? 'flutterwave' : 'notchpay';
    const A = fake(firstName, { initFails: 'definite' });
    const B = fake(secondName);
    const router = routerOf(A, B);
    for (const [plan, interval] of combos.slice(0, 3)) await initiatePayment(o.userId, { ...card, plan, interval }, router);
    expect(A.initCalls).toBe(3);
    expect(await redis.exists(`sf:psp:open:${firstName}`)).toBe(1);

    await initiatePayment(o.userId, { ...card, plan: 'business', interval: 'annual' }, router);
    expect(A.initCalls).toBe(3); // skipped: the customer did not wait for it
    expect(B.initCalls).toBe(4);

    await prisma.paymentTransaction.updateMany({ where: { userId: o.userId }, data: { status: 'failed' } });
    await redis.del(`sf:psp:open:${firstName}`); // the cool-down is over: one trial
    await initiatePayment(o.userId, card, router);
    expect(A.initCalls).toBe(4);
    expect(await redis.exists(`sf:psp:open:${firstName}`)).toBe(1); // a single failed trial re-opens it at once

    const healed = fake(firstName);
    const router2 = routerOf(healed, B);
    await prisma.paymentTransaction.updateMany({ where: { userId: o.userId }, data: { status: 'failed' } });
    await redis.del(`sf:psp:open:${firstName}`);
    const tx = await initiatePayment(o.userId, { ...card, interval: 'annual' }, router2);
    expect(tx.pspProvider).toBe(firstName);
    expect(await redis.exists(`sf:psp:open:${firstName}`, `sf:psp:fails:${firstName}`, `sf:psp:recentlyopen:${firstName}`)).toBe(0);
  });

  it('M7 a rejection by the provider (bad request) does not count against it', async () => {
    const o = await registerOwner(app);
    const A = fake('notchpay', { initFails: 'rejected' });
    for (let i = 0; i < 4; i++) await expect(initiatePayment(o.userId, { ...card, interval: i % 2 ? 'annual' : 'monthly', plan: i < 2 ? 'growth' : 'business' }, routerOf(A))).rejects.toBeTruthy();
    expect(await redis.exists('sf:psp:open:notchpay')).toBe(0);
  });

  it('M7 a database error AFTER the provider accepted must not start the payment at a second provider', async () => {
    const o = await registerOwner(app);
    // A NUL byte is refused by Postgres: the provider answered, then our own write failed.
    const A = fake('notchpay', { url: 'https://pay.example/a\u0000' });
    const B = fake('flutterwave', { url: 'https://pay.example/b\u0000' });
    await expect(initiatePayment(o.userId, card, routerOf(A, B))).rejects.toBeTruthy();
    expect(A.initCalls + B.initCalls).toBe(1); // exactly one provider was ever asked
  });
});

describe('MAJOR: telling the customer before their plan lapses', () => {
  const outbox = async (phone: string) => (await redis.lrange(outboxKey('platform-mock', phone.replace(/\D/g, '')), 0, -1)).map((r) => JSON.parse(r).message?.body as string);
  async function owner(phone: string, locale: 'en' | 'fr', patch: Record<string, unknown>) {
    const o = await registerOwner(app, { plan: 'growth' });
    await prisma.user.update({ where: { id: o.userId }, data: { phone, locale } });
    await prisma.subscription.update({ where: { userId: o.userId }, data: patch });
    return o;
  }
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

  it('M8 one notice three days before the end, not before, not twice, not for someone who cancelled; a payment re-arms it', async () => {
    const soon = await owner('+237677100001', 'en', { currentPeriodEnd: inDays(2) });
    await owner('+237677100002', 'en', { currentPeriodEnd: inDays(10) });
    await owner('+237677100003', 'en', { currentPeriodEnd: inDays(2), cancelAtPeriodEnd: true });
    expect(await runRenewalNotices()).toEqual({ renewal: 1, overdue: 0 });
    expect((await outbox('+237677100001'))[0]).toMatch(/Growth plan ends on .* Renewal is not automatic.*\/billing/);
    expect(await outbox('+237677100002')).toHaveLength(0);
    expect(await outbox('+237677100003')).toHaveLength(0);
    expect(await runRenewalNotices()).toEqual({ renewal: 0, overdue: 0 });

    const router = routerOf(fake('notchpay'));
    const tx = await initiatePayment(soon.userId, momo, router);
    await settleTransaction(tx.id, { status: 'success', amount: tx.amount, currency: 'XAF' }, quiet);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { userId: soon.userId } })).reminderSentAt).toBeNull();
  });

  it('M8 two workers running at the same moment still send ONE notice (the claim is atomic)', async () => {
    await owner('+237677100005', 'en', { currentPeriodEnd: inDays(1) });
    const [a, b] = await Promise.all([runRenewalNotices(), runRenewalNotices()]);
    expect(a.renewal + b.renewal).toBe(1);
    expect(await outbox('+237677100005')).toHaveLength(1);
  });

  it('M8 an overdue subscription is told once, in the owner\'s language', async () => {
    await owner('+237677100004', 'fr', { status: 'past_due', graceEndsAt: inDays(2) });
    expect(await runRenewalNotices()).toEqual({ renewal: 0, overdue: 1 });
    expect((await outbox('+237677100004'))[0]).toMatch(/en retard.*Renouvelez avant le/);
    expect(await runRenewalNotices()).toEqual({ renewal: 0, overdue: 0 });
  });
});

describe('MAJOR: a production API that cannot take a payment does not start', () => {
  const base = {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://x:x@127.0.0.1:5432/x', JWT_SECRET: 'j'.repeat(40), TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    WHATSAPP_MODE: 'live', WHATSAPP_ACCESS_TOKEN: 'x', META_APP_SECRET: 'x', GIFT_PROVIDER: 'campay', INTERNAL_API_SECRET: 'i'.repeat(40), PUBLIC_API_URL: 'https://api.example.com',
  };
  const boot = (extra: Record<string, string>) => {
    const r = spawnSync('npx', ['tsx', 'apps/api/src/config/env.ts'], { cwd: new URL('../../..', import.meta.url).pathname, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...base, ...extra }, encoding: 'utf8' });
    return { code: r.status, err: r.stderr + r.stdout };
  };
  it('M9 refuses with no provider, starts with one (and warns when its webhook secret is missing)', () => {
    const none = boot({});
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/No payment provider is configured/);
    const one = boot({ NOTCHPAY_API_KEY: 'k' });
    expect(one.err).not.toMatch(/No payment provider/);
    expect(one.err).toMatch(/NotchPay is configured but NOTCHPAY_WEBHOOK_HASH is not/);
  }, 60_000);
});
