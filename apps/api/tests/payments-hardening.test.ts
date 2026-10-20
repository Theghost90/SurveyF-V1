import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma';
import { isRateLimitExempt } from '../src/lib/ratelimit';
import { redis } from '../src/lib/redis';
import { runRenewalNotices } from '../src/services/subscription/notices';
import * as wallet from '../src/services/wallet';
import { outboxKey } from '../src/services/whatsapp/mock';
import { PSPRouter } from '../src/services/payments/router';
import { reconcilePayments } from '../src/services/payments/reconcile';
import { initiatePayment, refreshTransaction, settleTransaction } from '../src/services/payments/service';
import { isTransientDbError, resolveReview } from '../src/services/payments/settlement';
import { runBillingLifecycle } from '../src/services/subscription/lifecycle';
import { PspError, pspFetch, type PSPAdapter, type VerifyResult } from '../src/services/payments/types';
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

// `npx` is `npx.cmd` on Windows (needs a shell) and file URLs must be converted, not `.pathname`d ("/C:/..." is not a directory).
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const runNpx = (args: string[], opts: SpawnSyncOptions) => spawnSync('npx', args, { shell: process.platform === 'win32', cwd: REPO_ROOT, encoding: 'utf8', ...opts });
const OS_ENV = Object.fromEntries(['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'].filter((k) => process.env[k]).map((k) => [k, process.env[k] as string]));

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
    const r = runNpx(['tsx', 'apps/api/src/config/env.ts'], { env: { ...OS_ENV, ...base, ...extra } });
    return { code: r.status, err: `${r.stderr ?? ''}${r.stdout ?? ''}${r.error ?? ''}` };
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

// ═══════════════════════════════════════════════════════════════ CRITICAL ═══

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(Date.now() - ms);
const until = async (fn: () => Promise<boolean>, ms = 3_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const mkTx = async (userId: string, patch: Partial<Prisma.PaymentTransactionUncheckedCreateInput> = {}) => {
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
  return prisma.paymentTransaction.create({
    data: {
      subscriptionId: sub.id, userId, pspProvider: 'notchpay', amount: 39000, currency: 'XAF', status: 'pending', reference: `sfc${Math.random().toString(36).slice(2, 14)}`,
      purpose: 'subscription', plan: 'growth', interval: 'monthly', method: 'card', pspReference: 'pr-1', checkoutUrl: 'https://pay.example/x', ...patch,
    },
  });
};
const paid = (amount = 39000, currency = 'XAF'): VerifyResult => ({ status: 'success', amount, currency });
const reviewLog = () => { const errors: Array<[unknown, string | undefined]> = []; return { errors, log: { warn: () => undefined, error: (o: unknown, m?: string) => { errors.push([o, m]); } } }; };

describe('CRITICAL C1: a payment the customer made is never lost behind a lost webhook', () => {
  it('the customer paid and closed the tab, the webhook never came: the reconciliation job finds it at the provider and activates', async () => {
    const o = await registerOwner(app);
    const tx = await mkTx(o.userId, { createdAt: ago(20 * MIN) });
    const p = fake('notchpay'); p.setVerify(paid());
    expect(await reconcilePayments(new Date(), routerOf(p), quiet)).toMatchObject({ recovered: 1 });
    expect((await txOf(tx.id)).status).toBe('success');
    expect(await planOf(o.userId)).toBe('growth');
  });

  it('a payment that is still pending after a day is asked about one LAST time before it is expired — never expired blind', async () => {
    const o = await registerOwner(app);
    const old = await mkTx(o.userId, { createdAt: ago(25 * HOUR) });
    const p = fake('notchpay'); // provider says: still pending
    expect(await reconcilePayments(new Date(), routerOf(p), quiet)).toMatchObject({ expired: 1, recovered: 0 });
    expect(p.verifyCalls).toBe(1);
    expect((await txOf(old.id)).status).toBe('expired');

    // …and when the provider says it was paid after all, that wins over the clock:
    const o2 = await registerOwner(app);
    const paidLate = await mkTx(o2.userId, { createdAt: ago(25 * HOUR) });
    const p2 = fake('notchpay'); p2.setVerify(paid());
    expect(await reconcilePayments(new Date(), routerOf(p2), quiet)).toMatchObject({ recovered: 1, expired: 0 });
    expect((await txOf(paidLate.id)).status).toBe('success');
    expect(await planOf(o2.userId)).toBe('growth');
  });

  it('the old blind expiry in the billing lifecycle is gone', async () => {
    const o = await registerOwner(app);
    const tx = await mkTx(o.userId, { createdAt: ago(30 * HOUR) });
    await runBillingLifecycle();
    expect((await txOf(tx.id)).status).toBe('pending');
  });

  it('a provider that cannot be asked keeps a day-old payment pending (it is not guessed), and after two days it is expired (late success still honoured)', async () => {
    const o = await registerOwner(app);
    const a = await mkTx(o.userId, { createdAt: ago(25 * HOUR) });
    const down = fake('notchpay'); down.setVerify(new Error('verification endpoint down'));
    expect(await reconcilePayments(new Date(), routerOf(down), quiet)).toMatchObject({ expired: 0, errors: 1 });
    expect((await txOf(a.id)).status).toBe('pending');
    await prisma.paymentTransaction.update({ where: { id: a.id }, data: { createdAt: ago(49 * HOUR), lastCheckedAt: null } });
    expect(await reconcilePayments(new Date(), routerOf(down), quiet)).toMatchObject({ expired: 1 });
    expect((await txOf(a.id)).status).toBe('expired');
  });

  it('a payment whose provider no longer exists in this deployment does not stay pending forever', async () => {
    const o = await registerOwner(app);
    const a = await mkTx(o.userId, { pspProvider: 'cinetpay', createdAt: ago(49 * HOUR) });
    expect(await reconcilePayments(new Date(), routerOf(fake('notchpay')), quiet)).toMatchObject({ expired: 1 });
    expect((await txOf(a.id)).status).toBe('expired');
  });

  it('the cadence follows the age: every minute at first, then every 5 min, every 30 min, and a payment is never asked twice inside its interval', async () => {
    const o = await registerOwner(app);
    const young = await mkTx(o.userId, { createdAt: ago(3 * MIN), lastCheckedAt: ago(10_000) });
    const young2 = await mkTx(o.userId, { createdAt: ago(3 * MIN), lastCheckedAt: ago(70_000) });
    const mid = await mkTx(o.userId, { createdAt: ago(30 * MIN), lastCheckedAt: ago(2 * MIN) });
    const mid2 = await mkTx(o.userId, { createdAt: ago(30 * MIN), lastCheckedAt: ago(6 * MIN) });
    const old = await mkTx(o.userId, { createdAt: ago(5 * HOUR), lastCheckedAt: ago(10 * MIN) });
    const old2 = await mkTx(o.userId, { createdAt: ago(5 * HOUR), lastCheckedAt: ago(40 * MIN) });
    const asked: string[] = [];
    const p = fake('notchpay'); p.verifyPayment = async ({ reference }) => { asked.push(reference); return { status: 'pending', amount: 0, currency: '' }; };
    await reconcilePayments(new Date(), routerOf(p), quiet);
    expect(new Set(asked)).toEqual(new Set([young2.reference, mid2.reference, old2.reference]));
    expect(asked).not.toContain(young.reference); expect(asked).not.toContain(mid.reference); expect(asked).not.toContain(old.reference);
    await reconcilePayments(new Date(), routerOf(p), quiet); // the same minute again: everything was just asked
    expect(asked).toHaveLength(3);
  });

  it('a failed or expired payment that reached a provider is still asked about for a week; one that never reached it, or is older than a week, is not', async () => {
    const o = await registerOwner(app);
    const failed = await mkTx(o.userId, { status: 'failed', failReason: 'declined_by_provider', createdAt: ago(3 * 24 * HOUR) });
    const expired = await mkTx(o.userId, { status: 'expired', createdAt: ago(6 * 24 * HOUR) });
    const neverSent = await mkTx(o.userId, { status: 'failed', failReason: 'psp_unavailable: x', createdAt: ago(2 * HOUR), pspReference: null, checkoutUrl: null });
    const tooOld = await mkTx(o.userId, { status: 'expired', createdAt: ago(8 * 24 * HOUR) });
    const asked: string[] = [];
    const p = fake('notchpay'); p.verifyPayment = async ({ reference }) => { asked.push(reference); return { status: 'pending', amount: 0, currency: '' }; };
    await reconcilePayments(new Date(), routerOf(p), quiet);
    expect(new Set(asked)).toEqual(new Set([failed.reference, expired.reference]));
    expect(asked).not.toContain(neverSent.reference); expect(asked).not.toContain(tooOld.reference);
  });
});

describe('CRITICAL C2: "failed" and "expired" are our conclusions, not the provider\'s — a verified success always wins', () => {
  it('a payment marked failed (the payer retried on the hosted page and succeeded) is credited', async () => {
    const o = await registerOwner(app);
    const tx = await mkTx(o.userId, { status: 'failed', failReason: 'declined_by_provider' });
    expect(await settleTransaction(tx.id, paid(), quiet)).toBe('activated');
    expect(await planOf(o.userId)).toBe('growth');
    expect(await txOf(tx.id)).toMatchObject({ status: 'success', failReason: null });
  });

  it('an expired payment (the payer approved the prompt on day three) is credited', async () => {
    const o = await registerOwner(app);
    const tx = await mkTx(o.userId, { status: 'expired', createdAt: ago(3 * 24 * HOUR) });
    expect(await settleTransaction(tx.id, paid(), quiet)).toBe('activated');
    expect(await planOf(o.userId)).toBe('growth');
  });

  it('a "failed" verdict never undoes a success and never reopens an expired payment', async () => {
    const o = await registerOwner(app);
    const ok = await mkTx(o.userId, { status: 'success' });
    const exp = await mkTx(o.userId, { status: 'expired' });
    expect(await settleTransaction(ok.id, { status: 'failed', amount: 0, currency: '' }, quiet)).toBe('already_settled');
    expect(await settleTransaction(exp.id, { status: 'failed', amount: 0, currency: '' }, quiet)).toBe('already_settled');
    expect((await txOf(ok.id)).status).toBe('success');
    expect((await txOf(exp.id)).status).toBe('expired');
  });

  it('the signed webhook of a payment we had given up on settles it, even after the week is over (a provider saying "paid" is never dropped)', async () => {
    const o = await registerOwner(app);
    const tx = await mkTx(o.userId, { pspProvider: 'flutterwave', status: 'expired', reference: 'sflate0001', createdAt: ago(9 * 24 * HOUR) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'success', data: { status: 'successful', amount: 39000, currency: 'XAF', id: 5 } }), { status: 200 })));
    const r = await app.inject({ method: 'POST', url: '/api/payments/webhook/flutterwave', headers: { 'content-type': 'application/json', 'verif-hash': 'flw-hash-123' }, payload: JSON.stringify({ data: { tx_ref: 'sflate0001', status: 'successful', id: 5 } }) });
    expect(r.statusCode).toBe(200);
    expect((await txOf(tx.id)).status).toBe('success');
    expect(await planOf(o.userId)).toBe('growth');
  });

  it('a browser poll of a failed payment is coalesced (it must not become a provider call every few seconds) but does notice a late success', async () => {
    const o = await registerOwner(app);
    const tx = await mkTx(o.userId, { status: 'failed', failReason: 'declined_by_provider' });
    const p = fake('notchpay');
    const r1 = await refreshTransaction(tx, routerOf(p), quiet);
    const r2 = await refreshTransaction(tx, routerOf(p), quiet);
    expect(p.verifyCalls).toBe(1);
    expect(r1.outcome).toBe('pending'); expect(r2.outcome).toBe('pending');
    expect(await redis.pttl(`sf:pay:verify:${tx.id}`)).toBeGreaterThan(10_000); // a failed payment is polled far less eagerly than a pending one
    await redis.flushdb();
    p.setVerify(paid());
    expect((await refreshTransaction(tx, routerOf(p), quiet)).tx.status).toBe('success');
  });

  it('a poll never asks a provider about a payment that never reached it (but a webhook always does)', async () => {
    const o = await registerOwner(app);
    const tx = await mkTx(o.userId, { status: 'failed', failReason: 'psp_unavailable: x', pspReference: null, checkoutUrl: null });
    const p = fake('notchpay');
    expect((await refreshTransaction(tx, routerOf(p), quiet)).outcome).toBe('already_settled');
    expect(p.verifyCalls).toBe(0);
    await refreshTransaction(tx, routerOf(p), quiet, { force: true });
    expect(p.verifyCalls).toBe(1);
  });
});

describe('CRITICAL C3: an unconfirmed start of a push provider is never repeated at another provider', () => {
  const probe = routerOf(fake('campay'), fake('notchpay'));
  const first = probe.chain({ country: 'CM', currency: 'XAF', method: 'mobile_money', amountXAF: 39000 })[0]!.name;
  const second = first === 'campay' ? 'notchpay' : 'campay';

  it('a push provider that may have sent the prompt: no second provider is asked, the payment stays pending, the customer is told not to pay again', async () => {
    const o = await registerOwner(app);
    const P = fake(first, { initFails: 'ambiguous', push: true });
    const H = fake(second);
    const router = routerOf(P, H);
    await expect(initiatePayment(o.userId, momo, router)).rejects.toMatchObject({ status: 502, code: 'psp_unconfirmed' });
    expect(H.initCalls).toBe(0); // the second prompt that would have charged the customer twice
    const row = await prisma.paymentTransaction.findFirstOrThrow({ where: { userId: o.userId } });
    expect(row).toMatchObject({ status: 'pending', pspProvider: first });
    expect(row.failReason).toMatch(/^unconfirmed: timeout after sending/);
    expect(row.attempts).toEqual([expect.objectContaining({ psp: first, ok: false, ambiguous: true })]);

    // an impatient second click does not start another prompt…
    await expect(initiatePayment(o.userId, momo, router)).rejects.toMatchObject({ code: 'psp_unconfirmed' });
    expect(P.initCalls).toBe(1); expect(H.initCalls).toBe(0);
    expect(await prisma.paymentTransaction.count({ where: { userId: o.userId } })).toBe(1);
    // …until the first prompt cannot be alive any more:
    await prisma.paymentTransaction.update({ where: { id: row.id }, data: { createdAt: ago(4 * MIN) } });
    const again = await initiatePayment(o.userId, momo, routerOf(fake(first, { push: true }), H));
    expect(again.id).not.toBe(row.id);
  });

  it('…and if the prompt DID go out, the payment is found and settled afterwards', async () => {
    const o = await registerOwner(app);
    const P = fake(first, { initFails: 'ambiguous', push: true });
    await expect(initiatePayment(o.userId, momo, routerOf(P, fake(second)))).rejects.toMatchObject({ code: 'psp_unconfirmed' });
    const row = await prisma.paymentTransaction.findFirstOrThrow({ where: { userId: o.userId } });
    const asked = fake(first, { push: true }); asked.setVerify(paid());
    await prisma.paymentTransaction.update({ where: { id: row.id }, data: { pspReference: 'campay-ref-9' } }); // learnt from the provider's signed webhook
    expect(await reconcilePayments(new Date(), routerOf(asked), quiet)).toMatchObject({ recovered: 1 });
    expect(await planOf(o.userId)).toBe('growth');
  });

  it('a push provider that certainly did not send it (connection refused) still fails over; so does a HOSTED provider after an ambiguous failure', async () => {
    const o = await registerOwner(app);
    const refused = fake(first, { initFails: 'definite', push: true });
    const H = fake(second);
    const tx = await initiatePayment(o.userId, momo, routerOf(refused, H));
    expect(H.initCalls).toBe(1); expect(tx.pspProvider).toBe(second);

    const o2 = await registerOwner(app);
    const hostedAmbiguous = fake(first, { initFails: 'ambiguous' }); // a hosted checkout page nobody is shown
    const H2 = fake(second);
    const tx2 = await initiatePayment(o2.userId, momo, routerOf(hostedAmbiguous, H2));
    expect(H2.initCalls).toBe(1); expect(tx2.pspProvider).toBe(second);
    expect(tx2.attempts).toEqual([expect.objectContaining({ psp: first, ok: false, ambiguous: true }), expect.objectContaining({ psp: second, ok: true })]);
  });

  it('a signed webhook teaches us the provider\'s reference of a payment whose start we could not confirm, so the provider can be asked', async () => {
    const o = await registerOwner(app);
    const tx = await mkTx(o.userId, { pspProvider: 'flutterwave', reference: 'sfunconf01', pspReference: null, checkoutUrl: null, failReason: 'unconfirmed: x' });
    const hook = () => app.inject({ method: 'POST', url: '/api/payments/webhook/flutterwave', headers: { 'content-type': 'application/json', 'verif-hash': 'flw-hash-123' }, payload: JSON.stringify({ data: { tx_ref: 'sfunconf01', status: 'successful', id: 77 } }) });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('verification endpoint down'); }));
    expect((await hook()).statusCode).toBe(503);
    expect((await txOf(tx.id)).pspReference).toBe('77'); // kept even though the verification itself failed: the next attempt can use it
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'success', data: { status: 'successful', amount: 39000, currency: 'XAF', id: 77 } }), { status: 200 })));
    expect((await hook()).statusCode).toBe(200);
    expect(await txOf(tx.id)).toMatchObject({ status: 'success', pspReference: '77' });
  });

  it('the provider call tells "certainly not created" from "maybe created"', async () => {
    const classify = async (impl: () => Promise<Response>) => {
      vi.stubGlobal('fetch', vi.fn(impl));
      try { await pspFetch('campay', 'https://x.example/collect', { method: 'POST', json: {} }); return null; } catch (e) { const x = e as PspError; return { retryable: x.retryable, ambiguous: x.ambiguous }; }
    };
    const fetchFailed = (code: string) => () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); };
    expect(await classify(fetchFailed('ECONNREFUSED') as never)).toEqual({ retryable: true, ambiguous: false });
    expect(await classify(fetchFailed('ENOTFOUND') as never)).toEqual({ retryable: true, ambiguous: false });
    expect(await classify(fetchFailed('ECONNRESET') as never)).toEqual({ retryable: true, ambiguous: true });
    expect(await classify((() => { throw new DOMException('timed out', 'TimeoutError'); }) as never)).toEqual({ retryable: true, ambiguous: true });
    for (const [status, retryable, ambiguous] of [[400, false, false], [401, false, false], [429, true, false], [503, true, false], [500, true, true], [502, true, true], [504, true, true], [408, true, true]] as const) {
      expect(await classify(async () => new Response('x', { status }))).toEqual({ retryable, ambiguous });
    }
  });
});

describe('CRITICAL C4: money we received but cannot simply apply is never lost and never silent', () => {
  const ownerWithPhone = async (phone: string) => { const o = await registerOwner(app); await prisma.user.update({ where: { id: o.userId }, data: { phone } }); return o; };
  const outboxOf = async (phone: string) => (await redis.lrange(outboxKey('platform-mock', phone.replace(/\D/g, '')), 0, -1)).map((r) => JSON.parse(r).message?.body as string);

  it('an underpayment goes to REVIEW (not "failed"), is logged as PAYMENT_REVIEW and the customer is told once; nothing is activated', async () => {
    const o = await ownerWithPhone('+237677200001');
    const tx = await mkTx(o.userId);
    const { errors, log } = reviewLog();
    expect(await settleTransaction(tx.id, paid(3000), log)).toBe('needs_review');
    expect(await txOf(tx.id)).toMatchObject({ status: 'review', failReason: expect.stringMatching(/^underpaid: provider reports 3000 XAF, asked 39000 XAF/) });
    expect(await planOf(o.userId)).toBe('trial');
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toMatch(/^PAYMENT_REVIEW/);
    expect(await until(async () => (await outboxOf('+237677200001')).length === 1)).toBe(true);
    expect((await outboxOf('+237677200001'))[0]).toMatch(new RegExp(`ref ${tx.reference}.*no need to pay again`));
    // a second delivery of the same fact changes nothing and says nothing
    expect(await settleTransaction(tx.id, paid(3000), log)).toBe('already_settled');
    expect(await settleTransaction(tx.id, paid(), log)).toBe('already_settled'); // review is final until a person decides
    expect(errors).toHaveLength(1);
    expect(await outboxOf('+237677200001')).toHaveLength(1);
  });

  it('the wrong currency goes to review too, and the customer-facing status is "review", not a failure', async () => {
    const o = await registerOwner(app);
    const tx = await mkTx(o.userId);
    expect(await settleTransaction(tx.id, paid(39000, 'USD'), quiet)).toBe('needs_review');
    const dto = (await o.get(`/api/payments/${tx.id}`)).body as { status: string; failCode: string | null };
    expect(dto).toMatchObject({ status: 'review', failCode: null });
    expect((await txOf(tx.id)).failReason).toMatch(/^currency_mismatch/);
  });

  it('an activation that cannot be applied (a defect, not an outage) parks the payment for review and rolls everything back', async () => {
    const o = await registerOwner(app);
    const tx = await mkTx(o.userId, { plan: null });
    const { errors, log } = reviewLog();
    expect(await settleTransaction(tx.id, paid(), log)).toBe('needs_review');
    expect(await txOf(tx.id)).toMatchObject({ status: 'review', paidAt: null, failReason: expect.stringMatching(/^activation_failed: .*has no plan/) });
    expect(errors).toHaveLength(1);
  });

  it('a database outage is NOT a verdict: it is thrown (the webhook is retried, reconciliation tries again) and the payment is settled once the database is back', async () => {
    const o = await registerOwner(app);
    const tx = await mkTx(o.userId, { purpose: 'gift_topup', plan: null, amount: 10000 });
    const spy = vi.spyOn(wallet, 'creditWallet').mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Can\'t reach database server', { code: 'P1001', clientVersion: 'test' }));
    await expect(settleTransaction(tx.id, paid(10000), quiet)).rejects.toThrow(/reach database/);
    spy.mockRestore();
    expect((await txOf(tx.id)).status).toBe('pending'); // not parked, not failed, nothing half-applied
    expect(await settleTransaction(tx.id, paid(10000), quiet)).toBe('activated');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).giftBalance).toBe(10000);
  });

  it('which database errors are outages and which are defects', () => {
    const known = (code: string) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 't' });
    for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']) expect(isTransientDbError(known(code))).toBe(true);
    for (const code of ['P2002', 'P2003', 'P2025']) expect(isTransientDbError(known(code))).toBe(false);
    expect(isTransientDbError(new Prisma.PrismaClientUnknownRequestError('Server has closed the connection', { clientVersion: 't' }))).toBe(true);
    expect(isTransientDbError(new Prisma.PrismaClientUnknownRequestError('invalid byte sequence for encoding "UTF8": 0x00', { clientVersion: 't' }))).toBe(false);
    expect(isTransientDbError(new Error('subscription payment has no plan'))).toBe(false);
  });

  it('a payment for a LOWER plan than the one now active (started before the upgrade, landing late) is parked, not applied over the higher plan', async () => {
    const o = await registerOwner(app, { plan: 'business' });
    const tx = await mkTx(o.userId, { plan: 'starter', amount: 14500 });
    expect(await settleTransaction(tx.id, paid(14500), quiet)).toBe('needs_review');
    expect((await txOf(tx.id)).failReason).toMatch(/^lower_plan_than_active/);
    expect(await planOf(o.userId)).toBe('business');
  });

  it('a top-up whose wallet cannot take it (currency changed meanwhile) is parked, with nothing credited', async () => {
    const o = await registerOwner(app);
    await prisma.user.update({ where: { id: o.userId }, data: { giftCurrency: 'EUR', giftBalance: 0 } });
    const tx = await mkTx(o.userId, { purpose: 'gift_topup', plan: null, amount: 10000, currency: 'XAF' });
    expect(await settleTransaction(tx.id, paid(10000), quiet)).toBe('needs_review');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).giftBalance).toBe(0);
  });

  it('a person decides: credit applies it once (and only from review); reject closes it and tells the customer', async () => {
    const o = await ownerWithPhone('+237677200002');
    const tx = await mkTx(o.userId);
    expect(await resolveReview(tx.id, 'credit', 'x', quiet)).toBe('not_in_review'); // still pending: nothing to resolve
    await settleTransaction(tx.id, paid(3000), quiet);
    expect(await resolveReview(tx.id, 'credit', 'customer sent the rest by transfer', quiet)).toBe('credited');
    expect(await planOf(o.userId)).toBe('growth');
    expect(await txOf(tx.id)).toMatchObject({ status: 'success', failReason: expect.stringMatching(/credited by operator: customer sent the rest/) });
    expect(await resolveReview(tx.id, 'credit', 'again', quiet)).toBe('not_in_review');
    expect(await resolveReview(tx.id, 'reject', 'again', quiet)).toBe('not_in_review');

    const o2 = await ownerWithPhone('+237677200003');
    const tx2 = await mkTx(o2.userId);
    await settleTransaction(tx2.id, paid(39000, 'USD'), quiet);
    expect(await resolveReview(tx2.id, 'reject', 'refunded by hand', quiet)).toBe('rejected');
    expect((await txOf(tx2.id)).status).toBe('failed');
    expect(await planOf(o2.userId)).toBe('trial');
    expect(await until(async () => (await outboxOf('+237677200003')).some((m) => /will return it/.test(m)))).toBe(true);
  });

  it('two payments of one customer settling at the same moment both count (settlements are serialised per subscription)', async () => {
    const o = await registerOwner(app);
    const a = await mkTx(o.userId);
    const b = await mkTx(o.userId);
    await Promise.all([settleTransaction(a.id, paid(), quiet), settleTransaction(b.id, paid(), quiet)]);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: o.userId } });
    const expected = Date.now() + 55 * 86_400_000; // two months from now, not one
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(expected);
  });
});

describe('CRITICAL: the operator tool for payments in review', () => {
  const run = (...args: string[]) => runNpx(['tsx', 'scripts/payments-review.mts', ...args], { env: process.env });

  it('lists a payment in review, needs a note, credits it exactly once, and refuses to touch anything that is not in review', async () => {
    const o = await registerOwner(app);
    const tx = await mkTx(o.userId);
    await settleTransaction(tx.id, paid(3000), quiet);

    const list = run('list');
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(tx.reference);
    expect(list.stdout).toMatch(/underpaid: provider reports 3000 XAF, asked 39000 XAF/);
    expect(run('show', tx.reference).stdout).toContain('"status": "review"');

    const noNote = run('credit', tx.reference);
    expect(noNote.status).toBe(1);
    expect(noNote.stderr).toMatch(/--note/);
    expect(await planOf(o.userId)).toBe('trial');

    const ok = run('credit', tx.reference, '--note', 'paid the rest in cash');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/credited/);
    expect(await planOf(o.userId)).toBe('growth');
    expect(run('list').stdout).toMatch(/Nothing in "review"/);

    const again = run('credit', tx.reference, '--note', 'again');
    expect(again.status).toBe(1);
    expect(again.stdout).toMatch(/not "review"/);
    expect(run('reject', 'does-not-exist', '--note', 'x').status).toBe(1);
  }, 120_000);
});
