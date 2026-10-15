import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { PSPRouter } from '../src/services/payments/router';
import { initiatePayment, settleTransaction } from '../src/services/payments/service';
import { PspError, type PSPAdapter } from '../src/services/payments/types';
import { runBillingLifecycle } from '../src/services/subscription/lifecycle';
import { makeApp, registerOwner, resetAll, setPlan } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

const momo = { plan: 'growth', interval: 'monthly', method: 'mobile_money', phone: '+237677000001' };

describe('payment flow (mock PSP through the real settle path)', () => {
  it('prices server-side, activates exactly once, and reports the invoice', async () => {
    const o = await registerOwner(app);
    // a client-supplied amount is ignored: the schema does not even accept one
    const init = await o.post('/api/payments/initiate', { ...momo, amount: 1 });
    expect(init.status).toBe(201);
    expect(init.body).toMatchObject({ amount: 39000, currency: 'XAF', status: 'pending', psp: 'mock' });
    expect(init.checkoutUrl).toContain('/billing/mock-checkout?ref=');

    // double-click protection: same pending payment, not a second charge
    const again = await o.post('/api/payments/initiate', momo);
    expect(again.id).toBe(init.id);
    expect(await prisma.paymentTransaction.count()).toBe(1);

    // still pending until the PSP says otherwise
    expect((await o.get(`/api/payments/${init.id}`)).body.status).toBe('pending');
    expect((await o.get('/api/auth/me')).plan.key).toBe('trial');

    const paid = await o.post(`/api/payments/mock/${init.reference}`, { outcome: 'success' });
    expect(paid.body.status).toBe('success');
    const me = await o.get('/api/auth/me');
    expect(me.plan.key).toBe('growth');
    expect(me.subscription).toMatchObject({ status: 'active', plan: 'growth', amountFCFA: 39000 });
    const end1 = me.subscription.currentPeriodEnd;

    // PSPs retry webhooks and browsers poll: settling again must not extend the period
    for (let i = 0; i < 3; i++) await o.get(`/api/payments/${init.id}`);
    await o.post(`/api/payments/mock/${init.reference}`, { outcome: 'success' });
    expect((await o.get('/api/auth/me')).subscription.currentPeriodEnd).toBe(end1);

    const sub = await o.get('/api/subscription');
    expect(sub.invoices).toHaveLength(1);
    expect(sub.prices.growth).toMatchObject({ monthly: 39000, annual: 390000, currency: 'XAF' });
  });

  it('a declined payment leaves the plan untouched', async () => {
    const o = await registerOwner(app);
    const init = await o.post('/api/payments/initiate', momo);
    expect((await o.post(`/api/payments/mock/${init.reference}`, { outcome: 'failed' })).body.status).toBe('failed');
    expect((await o.get('/api/auth/me')).plan.key).toBe('trial');
  });

  it('annual billing charges 10 months ("2 months free") and runs 12 months', async () => {
    const o = await registerOwner(app);
    const init = await o.post('/api/payments/initiate', { ...momo, plan: 'starter', interval: 'annual' });
    expect(init.amount).toBe(145000); // 10 × 14,500
    await o.post(`/api/payments/mock/${init.reference}`, { outcome: 'success' });
    const s = (await o.get('/api/auth/me')).subscription;
    const months = (new Date(s.currentPeriodEnd).getTime() - new Date(s.currentPeriodStart).getTime()) / 86_400_000;
    expect(months).toBeGreaterThan(360);
  });

  it('refuses a downgrade of an active paid plan, allows renewing the same plan', async () => {
    const o = await registerOwner(app);
    const first = await o.post('/api/payments/initiate', { ...momo, plan: 'business' });
    await o.post(`/api/payments/mock/${first.reference}`, { outcome: 'success' });
    const down = await o.put('/api/subscription/upgrade', { ...momo, plan: 'starter' });
    expect(down.status).toBe(409);
    expect(down.error).toBe('downgrade_not_supported');
    const renew = await o.put('/api/subscription/upgrade', { ...momo, plan: 'business' });
    expect(renew.status).toBe(200);
  });
});

describe('payment security', () => {
  const makeTx = async (userId: string, psp = 'flutterwave') => {
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
    return prisma.paymentTransaction.create({
      data: { subscriptionId: sub.id, userId, pspProvider: psp, amount: 39000, currency: 'XAF', status: 'pending', reference: 'sftestref001', plan: 'growth', interval: 'monthly', method: 'card' },
    });
  };
  const fwVerify = (status: string, amount: number, currency = 'XAF') =>
    vi.fn(async () => new Response(JSON.stringify({ status: 'success', data: { status, amount, currency, id: 777 } }), { status: 200 }));
  const hook = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/payments/webhook/flutterwave', headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify({ event: 'charge.completed', data: { tx_ref: 'sftestref001', status: 'successful', id: 777 } }) });

  it('rejects webhooks without the PSP signature', async () => {
    const o = await registerOwner(app);
    await makeTx(o.userId);
    expect((await hook({})).statusCode).toBe(401);
    expect((await hook({ 'verif-hash': 'wrong' })).statusCode).toBe(401);
    expect((await prisma.paymentTransaction.findFirst())!.status).toBe('pending');
  });

  it('does not trust the webhook body: a "successful" claim is checked with the PSP before activating', async () => {
    const o = await registerOwner(app);
    await makeTx(o.userId);
    vi.stubGlobal('fetch', fwVerify('pending', 0, ''));
    expect((await hook({ 'verif-hash': 'flw-hash-123' })).statusCode).toBe(200);
    expect((await prisma.paymentTransaction.findFirst())!.status).toBe('pending');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).plan).toBe('trial');
  });

  it('activates on a verified payment and ignores retried webhooks', async () => {
    const o = await registerOwner(app);
    await makeTx(o.userId);
    vi.stubGlobal('fetch', fwVerify('successful', 39000));
    await hook({ 'verif-hash': 'flw-hash-123' });
    const end1 = (await prisma.subscription.findUniqueOrThrow({ where: { userId: o.userId } })).currentPeriodEnd;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).plan).toBe('growth');
    await Promise.all([1, 2, 3, 4].map(() => hook({ 'verif-hash': 'flw-hash-123' })));
    expect((await prisma.subscription.findUniqueOrThrow({ where: { userId: o.userId } })).currentPeriodEnd).toEqual(end1);
    expect(await prisma.paymentTransaction.count({ where: { status: 'success' } })).toBe(1);
  });

  it('refuses to activate when the PSP says the paid amount or currency is lower than asked', async () => {
    const o = await registerOwner(app);
    const tx = await makeTx(o.userId);
    expect(await settleTransaction(tx.id, { status: 'success', amount: 100, currency: 'XAF' }, { warn: () => undefined })).toBe('amount_mismatch');
    const tx2 = await prisma.paymentTransaction.create({ data: { ...{ ...tx, id: undefined, createdAt: undefined }, reference: 'sftestref002', status: 'pending' } as never });
    expect(await settleTransaction(tx2.id, { status: 'success', amount: 39000, currency: 'USD' }, { warn: () => undefined })).toBe('amount_mismatch');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).plan).toBe('trial');
  });
});

describe('PSP failover', () => {
  const fake = (name: string, behaviour: 'fail' | 'ok'): PSPAdapter => ({
    name: name as never,
    isConfigured: () => true,
    initiatePayment: async () => { if (behaviour === 'fail') throw new PspError('503 from provider', name as never, true); return { checkoutUrl: `https://pay.example/${name}` }; },
    verifyPayment: async () => ({ status: 'pending', amount: 0, currency: '' }),
    parseWebhook: async () => ({ signatureValid: true }),
  });

  it('falls back to the next provider when the first is down (spec routed to exactly one PSP)', async () => {
    const prev = process.env.PSP_MOCK;
    const router = new PSPRouter([fake('campay', 'fail'), fake('notchpay', 'ok'), fake('mock', 'ok')]);
    // mock adapter reports unconfigured here, so the real chain for a Cameroon MoMo payment is campay → notchpay
    const mockOff = router.getAdapter('mock')!;
    mockOff.isConfigured = () => false;
    const o = await registerOwner(app);
    const tx = await initiatePayment(o.userId, { plan: 'starter', interval: 'monthly', method: 'mobile_money', phone: '+237677000001' }, router);
    expect(tx.pspProvider).toBe('notchpay');
    expect(tx.checkoutUrl).toBe('https://pay.example/notchpay');
    process.env.PSP_MOCK = prev;
  });

  it('fails cleanly (502) and records the failure when every provider is down', async () => {
    const router = new PSPRouter([fake('campay', 'fail'), fake('notchpay', 'fail'), fake('mock', 'ok')]);
    router.getAdapter('mock')!.isConfigured = () => false;
    const o = await registerOwner(app);
    await expect(initiatePayment(o.userId, { plan: 'starter', interval: 'monthly', method: 'mobile_money', phone: '+237677000001' }, router)).rejects.toMatchObject({ status: 502, code: 'psp_unavailable' });
    expect((await prisma.paymentTransaction.findFirst())!.status).toBe('failed');
  });

  it('only offers providers that support the country, method and currency (Campay never gets a card)', async () => {
    const router = new PSPRouter([fake('campay', 'ok'), fake('flutterwave', 'ok'), fake('mock', 'ok')]);
    router.getAdapter('mock')!.isConfigured = () => false;
    expect(router.chain({ country: 'CM', currency: 'XAF', method: 'card' }).map((a) => a.name)).toEqual(['flutterwave']);
    expect(router.chain({ country: 'CM', currency: 'XAF', method: 'mobile_money' }).map((a) => a.name)).toEqual(['campay']);
  });

  it('silently picks the cheapest provider by configured fee and keeps the others as failover; unknown fees keep the country order', async () => {
    const router = new PSPRouter([fake('campay', 'ok'), fake('notchpay', 'ok'), fake('payunit', 'ok'), fake('mock', 'ok')]);
    router.getAdapter('mock')!.isConfigured = () => false;
    const names = (fees: object) => router.chain({ country: 'CM', currency: 'XAF', method: 'mobile_money' }, fees as never).map((a) => a.name);
    expect(names({})).toEqual(['campay', 'notchpay', 'payunit']); // no fee data: configured order
    expect(names({ notchpay: { mobile_money: 1.5 }, campay: { mobile_money: 2.5 } })).toEqual(['notchpay', 'campay', 'payunit']);
    expect(names({ payunit: { mobile_money: 0.9 } })).toEqual(['payunit', 'campay', 'notchpay']);
    expect(names({ payunit: { card: 0.1 } })).toEqual(['campay', 'notchpay', 'payunit']); // a card fee says nothing about MoMo
  });

  it('charges through the cheapest provider and fails over to the next one when it is down', async () => {
    const router = new PSPRouter([fake('campay', 'ok'), fake('notchpay', 'fail'), fake('mock', 'ok')]);
    router.getAdapter('mock')!.isConfigured = () => false;
    const o = await registerOwner(app);
    const input = { plan: 'starter', interval: 'monthly', method: 'mobile_money', phone: '+237677000001' } as const;
    const fees = { notchpay: { mobile_money: 1 }, campay: { mobile_money: 2 } };
    const orig = router.chain.bind(router);
    router.chain = (p) => orig(p, fees as never); // notchpay is cheapest but down → campay
    const tx = await initiatePayment(o.userId, input, router);
    expect(tx.pspProvider).toBe('campay');
  });
});

describe('subscription lifecycle', () => {
  it('trial ending unpaid downgrades to Starter limits (spec) with no charge', async () => {
    const o = await registerOwner(app);
    await prisma.subscription.update({ where: { userId: o.userId }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    expect((await runBillingLifecycle()).trialsExpired).toBe(1);
    const me = await o.get('/api/auth/me');
    expect(me.plan.key).toBe('starter');
    expect(me.subscription).toMatchObject({ status: 'active', amountFCFA: 0 });
    expect(me.plan.limits.activeSurveys).toBe(3);
  });

  it('paid plan: active → past_due (3-day grace, full access) → suspended (read-only, 402 on publish)', async () => {
    const o = await registerOwner(app);
    await setPlan(o.userId, 'growth');
    await prisma.subscription.update({ where: { userId: o.userId }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    await runBillingLifecycle();
    let sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: o.userId } });
    expect(sub.status).toBe('past_due');
    const graceDays = (sub.graceEndsAt!.getTime() - sub.currentPeriodEnd.getTime()) / 86_400_000;
    expect(graceDays).toBe(3);
    const s = await o.post('/api/surveys', { title: 'T', questions: [{ text: 'q', type: 'text', required: true }] });
    expect((await o.post(`/api/surveys/${s.id}/publish`)).status).toBe(200); // grace: still works

    await prisma.subscription.update({ where: { userId: o.userId }, data: { graceEndsAt: new Date(Date.now() - 1000) } });
    await runBillingLifecycle();
    sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: o.userId } });
    expect(sub.status).toBe('suspended');
    const s2 = await o.post('/api/surveys', { title: 'T2', questions: [{ text: 'q', type: 'text', required: true }] });
    const blocked = await o.post(`/api/surveys/${s2.id}/publish`);
    expect(blocked).toMatchObject({ status: 402, error: 'subscription_suspended' });
    expect((await o.get('/api/surveys')).items).toHaveLength(2); // data stays readable
  });

  it('paying while past_due restores the account', async () => {
    const o = await registerOwner(app);
    await setPlan(o.userId, 'growth');
    await prisma.subscription.update({ where: { userId: o.userId }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    await runBillingLifecycle();
    const init = await o.post('/api/payments/initiate', momo);
    await o.post(`/api/payments/mock/${init.reference}`, { outcome: 'success' });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: o.userId } });
    expect(sub.status).toBe('active');
    expect(sub.graceEndsAt).toBeNull();
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
  });

  it('cancel-at-period-end downgrades instead of renewing', async () => {
    const o = await registerOwner(app);
    await setPlan(o.userId, 'business');
    await o.post('/api/subscription/cancel');
    await prisma.subscription.update({ where: { userId: o.userId }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    expect((await runBillingLifecycle()).cancelled).toBe(1);
    expect((await o.get('/api/auth/me')).plan.key).toBe('starter');
  });
});
