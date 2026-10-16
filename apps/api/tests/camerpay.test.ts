import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env } from '../src/config/env';
import { hmacHex } from '../src/lib/crypto';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { CamerPayAdapter, camerpaySignedString } from '../src/services/payments/adapters/camerpay';
import { PspError } from '../src/services/payments/types';
import { makeApp, registerOwner, resetAll } from './helpers';

const SECRET = 'camerpay-callback-secret-for-tests';
let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); env.CAMERPAY_API_KEY = 'cp_test_key'; env.CAMERPAY_WEBHOOK_SECRET = SECRET; });
afterEach(() => { vi.unstubAllGlobals(); env.CAMERPAY_API_KEY = undefined; env.CAMERPAY_WEBHOOK_SECRET = undefined; });

const params = { amount: 14_500, currency: 'XAF', method: 'mobile_money' as const, reference: 'sfcamerref001', customerName: 'Ada', customerEmail: 'a@example.com', customerPhone: '237677000001', description: 'SurveyFlow starter (monthly)', returnUrl: 'https://app.example/billing/return?ref=x', notifyUrl: 'https://api.example/api/payments/webhook/camerpay' };

describe('CamerPay adapter: initiate', () => {
  const stubInit = (answer: unknown, status = 200) => {
    const f = vi.fn(async () => new Response(JSON.stringify(answer), { status }));
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('is only configured with BOTH the API key and the callback secret (a webhook it cannot verify is worse than none)', () => {
    expect(new CamerPayAdapter().isConfigured()).toBe(true);
    env.CAMERPAY_WEBHOOK_SECRET = undefined;
    expect(new CamerPayAdapter().isConfigured()).toBe(false);
    env.CAMERPAY_WEBHOOK_SECRET = SECRET; env.CAMERPAY_API_KEY = undefined;
    expect(new CamerPayAdapter().isConfigured()).toBe(false);
  });

  it('posts to /api/payment/initiate with the Bearer key, our reference as invoice_id and both callback URLs; mobile money lets the payer pick the operator', async () => {
    const f = stubInit({ uuid: 'tx-uuid-1', pay_url: 'https://camerpay.biz/pay/tx-uuid-1' });
    const r = await new CamerPayAdapter().initiatePayment(params);
    expect(r).toEqual({ checkoutUrl: 'https://camerpay.biz/pay/tx-uuid-1', pspReference: 'tx-uuid-1' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://camerpay.biz/api/payment/initiate');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cp_test_key');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ amount: 14_500, currency: 'XAF', invoice_id: 'sfcamerref001', customer_phone: '237677000001', merchant_callback_url: params.notifyUrl, merchant_return_url: params.returnUrl });
    expect(body).not.toHaveProperty('payment_method'); // the hosted page asks Orange or MTN
  });

  it('cards ask for the card rail; a payment in naira is sent in naira', async () => {
    const f = stubInit({ data: { transaction_id: 'u2', payment_url: 'https://camerpay.biz/pay/u2' } });
    const r = await new CamerPayAdapter().initiatePayment({ ...params, method: 'card', currency: 'NGN', amount: 34_800 });
    expect(r.checkoutUrl).toBe('https://camerpay.biz/pay/u2');
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ payment_method: 'card', currency: 'NGN', amount: 34_800 });
  });

  it('an answer without a payment page, or a 5xx, is a retryable provider error (the router fails over)', async () => {
    stubInit({ uuid: 'x' });
    await expect(new CamerPayAdapter().initiatePayment(params)).rejects.toBeInstanceOf(PspError);
    stubInit({ error: 'boom' }, 503);
    await expect(new CamerPayAdapter().initiatePayment(params)).rejects.toMatchObject({ retryable: true });
    stubInit({ error: 'bad key' }, 401);
    await expect(new CamerPayAdapter().initiatePayment(params)).rejects.toMatchObject({ retryable: false });
  });
});

describe('CamerPay webhooks: HMAC-SHA256 over uuid|invoice_id|status|amount', () => {
  const sign = (p: { uuid: string; invoice_id: string; status: string; amount: string | number }) => hmacHex(SECRET, camerpaySignedString(p));
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
  const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/payments/webhook/camerpay', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: form(fields) });

  async function pendingTx(over: Partial<{ amount: number; currency: string; purpose: string; plan: string | null }> = {}) {
    const o = await registerOwner(app);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: o.userId } });
    const tx = await prisma.paymentTransaction.create({
      data: { subscriptionId: sub.id, userId: o.userId, pspProvider: 'camerpay', amount: over.amount ?? 14_500, currency: over.currency ?? 'XAF', status: 'pending', reference: 'sfcamerref001', purpose: over.purpose ?? 'subscription', plan: (over.plan === undefined ? 'starter' : over.plan) as never, interval: 'monthly', method: 'mobile_money' },
    });
    return { o, tx };
  }
  const completed = (amount: string, over: Record<string, string> = {}) => {
    const f = { uuid: 'cp-uuid-9', invoice_id: 'sfcamerref001', status: 'completed', amount, ...over };
    return { ...f, signature: sign(f) };
  };

  it('the signed string is exactly uuid|invoice_id|status|amount with two decimals', () => {
    expect(camerpaySignedString({ uuid: 'u', invoice_id: 'i', status: 'completed', amount: 14500 })).toBe('u|i|completed|14500.00');
    expect(camerpaySignedString({ uuid: 'u', invoice_id: 'i', status: 'completed', amount: '14500.5' })).toBe('u|i|completed|14500.50');
  });

  it('a correctly signed "completed" webhook activates the plan once (header or body signature), and a replay changes nothing', async () => {
    const { o } = await pendingTx();
    const f = completed('14500.00');
    expect((await post(f, { 'x-camerpay-signature': f.signature })).statusCode).toBe(200);
    expect((await o.get('/api/auth/me')).subscription).toMatchObject({ status: 'active', plan: 'starter', amountFCFA: 14_500 });
    const sub1 = await prisma.subscription.findUniqueOrThrow({ where: { userId: o.userId } });
    expect((await post(f)).statusCode).toBe(200); // replay, signature in the body this time
    const sub2 = await prisma.subscription.findUniqueOrThrow({ where: { userId: o.userId } });
    expect(sub2.currentPeriodEnd.getTime()).toBe(sub1.currentPeriodEnd.getTime()); // not extended twice
    expect(await prisma.paymentTransaction.count({ where: { status: 'success' } })).toBe(1);
  });

  it('refuses a forged signature, a tampered amount, a tampered status and a missing field — nothing is activated', async () => {
    const { o } = await pendingTx();
    const good = completed('14500.00');
    expect((await post({ ...good, signature: 'f'.repeat(64) })).statusCode).toBe(401);
    expect((await post({ ...good, amount: '1.00' })).statusCode).toBe(401); // signature was for 14500.00
    expect((await post({ ...good, status: 'completed ' })).statusCode).toBe(401);
    expect((await post({ ...good, uuid: 'other' })).statusCode).toBe(401);
    const { signature, ...noSig } = good; void signature;
    expect((await post(noSig)).statusCode).toBe(401);
    const { amount, ...noAmount } = good; void amount;
    expect((await post(noAmount)).statusCode).toBe(401);
    expect((await o.get('/api/auth/me')).subscription.status).toBe('trial');
    expect((await prisma.paymentTransaction.findFirstOrThrow()).status).toBe('pending');
  });

  it('a validly signed but UNDER-paid amount does not activate (the common amount check still applies)', async () => {
    const { o } = await pendingTx();
    expect((await post(completed('100.00'))).statusCode).toBe(200);
    expect((await o.get('/api/auth/me')).subscription.status).toBe('trial');
    expect((await prisma.paymentTransaction.findFirstOrThrow()).status).toBe('review'); // money received: a person decides, it is not a failure
  });

  it('a card payment that carries the buyer-side processing fee on top is accepted: the plan is credited at what we asked, not what was collected', async () => {
    const { o } = await pendingTx();
    expect((await post(completed('14900.00'))).statusCode).toBe(200);
    expect((await o.get('/api/auth/me')).subscription).toMatchObject({ status: 'active', amountFCFA: 14_500 });
  });

  it('a "failed" webhook fails the payment; "refunded" or unknown states leave it pending', async () => {
    await pendingTx();
    expect((await post(completed('14500.00', { status: 'refunded' }))).statusCode).toBe(200);
    expect((await prisma.paymentTransaction.findFirstOrThrow()).status).toBe('pending');
    expect((await post(completed('14500.00', { status: 'failed' }))).statusCode).toBe(200);
    expect((await prisma.paymentTransaction.findFirstOrThrow()).status).toBe('failed');
  });

  it('an unknown invoice answers 200 (no retry storm) and touches nothing; a wallet top-up is credited through the same path', async () => {
    await pendingTx();
    const f = completed('14500.00', { invoice_id: 'does-not-exist' });
    expect((await post(f)).statusCode).toBe(200);
    expect((await prisma.paymentTransaction.findFirstOrThrow()).status).toBe('pending');

    await resetAll();
    const { o } = await pendingTx({ amount: 10_000, purpose: 'gift_topup', plan: null });
    expect((await post(completed('10000.00'))).statusCode).toBe(200);
    expect(await o.get('/api/wallet')).toMatchObject({ balance: 10_000, currency: 'XAF' });
  });

  it('without a configured secret nothing is accepted', async () => {
    await pendingTx();
    const f = completed('14500.00');
    env.CAMERPAY_WEBHOOK_SECRET = undefined;
    expect((await post(f)).statusCode).toBe(404); // adapter not configured: the route does not even exist for it
  });
});
