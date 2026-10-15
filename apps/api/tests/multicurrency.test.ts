import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { convertToXAF } from '@surveyflow/shared';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { GiftError, setGiftProvider, type GiftProvider } from '../src/services/gifts/providers';
import { processDueGifts } from '../src/services/gifts';
import { buildReceiptHtml, loadReceipt } from '../src/services/receipts';
import { buildWorld, client, makeApp, resetAll, say, setPlan, answerIdFor, replyMsg, templateBtn, textMsg, type World } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { setGiftProvider(null); await resetAll(); await prisma.fxRate.deleteMany(); });
afterEach(() => vi.unstubAllGlobals());

const NGN = 2.4; // 1 XAF = 2.4 NGN
const feed = (rates: Record<string, number> = { NGN, KES: 0.2 }) => ({ result: 'success', base_code: 'XAF', time_last_update_unix: Math.floor(Date.now() / 1000), rates });
const fxUp = (rates?: Record<string, number>) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => feed(rates) }) as Response));
const fxDown = async () => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); })); await redis.flushdb(); await prisma.fxRate.deleteMany(); };

async function registerFrom(country: string, plan?: 'growth') {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/register', headers: { 'content-type': 'application/json', 'x-sf-country': country },
    payload: JSON.stringify({ businessName: 'Lagos Shop', name: 'Ngozi', email: `mc${Math.random().toString(36).slice(2)}@example.com`, phone: ({ NG: '0803 123 4567', KE: '0712 345 678', CM: '677 12 34 56' } as Record<string, string>)[country]!, password: 'correct-horse-battery' }),
  });
  const body = JSON.parse(res.body);
  if (plan) await setPlan(body.user.id, plan);
  return client(app, body.token, body.user.id);
}
const settleMock = (c: ReturnType<typeof client>, ref: string, outcome: 'success' | 'failed' = 'success') => c.post(`/api/payments/mock/${ref}`, { outcome });

describe('a plan paid in the owner\'s currency', () => {
  it('a Nigerian owner is charged in naira (the FCFA price at the live rate), by card, and the plan is recorded at its FCFA price', async () => {
    fxUp();
    const c = await registerFrom('NG');
    const init = await c.post('/api/payments/initiate', { plan: 'starter', interval: 'monthly', method: 'card' });
    expect(init.status).toBe(201);
    expect(init.body).toMatchObject({ currency: 'NGN', amount: 34_800, method: 'card' });
    const row = await prisma.paymentTransaction.findFirstOrThrow({ where: { reference: init.reference } });
    expect(row).toMatchObject({ amount: 34_800, currency: 'NGN', amountXAF: 14_500, fxRate: NGN });
    await settleMock(c, init.reference);
    expect((await c.get('/api/auth/me')).subscription).toMatchObject({ status: 'active', plan: 'starter', amountFCFA: 14_500 }); // canonical FCFA, not the naira figure
  });

  it('annual is ten months converted once', async () => {
    fxUp();
    const c = await registerFrom('NG');
    const init = await c.post('/api/payments/initiate', { plan: 'growth', interval: 'annual', method: 'card' });
    expect(init.body).toMatchObject({ currency: 'NGN', amount: 936_000 }); // 390,000 FCFA × 2.4
  });

  it('Mobile Money does not exist in naira: refused, with the reason', async () => {
    fxUp();
    const c = await registerFrom('NG');
    const r = await c.raw('POST', '/api/payments/initiate', { plan: 'starter', interval: 'monthly', method: 'mobile_money', phone: '+2348031234567' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('method_unavailable');
    expect(await prisma.paymentTransaction.count()).toBe(0);
  });

  it('with no usable exchange rate the charge is made in FCFA at the FCFA price — never an invented conversion', async () => {
    await fxDown();
    const c = await registerFrom('NG');
    const sub = await c.get('/api/subscription');
    expect(sub).toMatchObject({ currency: 'XAF', requestedCurrency: 'NGN', fallback: true });
    expect(sub.methods).toEqual(['mobile_money', 'card']);
    const init = await c.post('/api/payments/initiate', { plan: 'starter', interval: 'monthly', method: 'card' });
    expect(init.body).toMatchObject({ currency: 'XAF', amount: 14_500 });
  });

  it('a Cameroonian owner is charged in FCFA and the network is never touched', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const c = await registerFrom('CM');
    const init = await c.post('/api/payments/initiate', { plan: 'starter', interval: 'monthly', method: 'mobile_money', phone: '+237677000001' });
    expect(init.body).toMatchObject({ currency: 'XAF', amount: 14_500 });
    expect(await prisma.paymentTransaction.findFirstOrThrow()).toMatchObject({ amountXAF: 14_500, fxRate: null });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('the euro: chargeable at the CFA franc\'s fixed peg, no live rate involved', () => {
  // No supported country uses EUR yet (a French visitor still gets Cameroon/FCFA), so an owner is put on EUR directly.
  async function euroOwner(plan?: 'growth') {
    const c = await registerFrom('CM', plan);
    await prisma.user.update({ where: { id: c.userId }, data: { preferredCurrency: 'EUR' } });
    return c;
  }

  it('prices, charges by card and records the XAF equivalent — and the network is never touched', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const c = await euroOwner();
    const sub = await c.get('/api/subscription');
    expect(sub).toMatchObject({ currency: 'EUR', requestedCurrency: 'EUR', fallback: false, quote: { source: 'peg' }, methods: ['card'] });
    expect(sub.prices).toMatchObject({ starter: { monthly: 22, annual: 221, currency: 'EUR' }, growth: { monthly: 59 }, business: { monthly: 145 } }); // 14,500 / 655.957 = 22.1 …
    const init = await c.post('/api/payments/initiate', { plan: 'starter', interval: 'monthly', method: 'card' });
    expect(init.status).toBe(201);
    expect(init.body).toMatchObject({ currency: 'EUR', amount: 22, method: 'card' });
    const row = await prisma.paymentTransaction.findFirstOrThrow({ where: { reference: init.reference } });
    expect(row).toMatchObject({ amount: 22, currency: 'EUR', amountXAF: 14_431 }); // 22 × 655.957, what the provider settles
    expect(row.fxRate).toBeCloseTo(1 / 655.957, 8);
    expect((await c.raw('POST', '/api/payments/initiate', { plan: 'starter', interval: 'monthly', method: 'mobile_money', phone: '+237677000001' })).json.error).toBe('method_unavailable');
    await settleMock(c, init.reference);
    expect((await c.get('/api/auth/me')).subscription).toMatchObject({ status: 'active', plan: 'starter', amountFCFA: 14_500 }); // canonical FCFA price stays
    expect(f).not.toHaveBeenCalled();
  });

  it('the wallet is topped up in euros and its limits are euro values', async () => {
    const c = await euroOwner('growth');
    const before = await c.get('/api/wallet');
    expect(before).toMatchObject({ currency: 'EUR', balance: 0, fxUnavailable: false, methods: ['card'] });
    expect(before.limits).toEqual({ topupMin: 2, topupMax: 2_000, presets: [10, 20, 50, 100, 200], giftMin: 1, giftMax: 20 });
    const init = await c.post('/api/wallet/topup', { amount: 20, method: 'card' });
    expect(init.body).toMatchObject({ purpose: 'gift_topup', amount: 20, currency: 'EUR' });
    await settleMock(c, init.reference);
    expect(await c.get('/api/wallet')).toMatchObject({ currency: 'EUR', balance: 20 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.userId } })).giftCurrency).toBe('EUR');
  });
});

describe('the gift wallet in the owner\'s currency', () => {
  it('shows the wallet and its limits in naira, tops up in naira by card, and the ledger holds naira', async () => {
    fxUp();
    const c = await registerFrom('NG', 'growth');
    const before = await c.get('/api/wallet');
    expect(before).toMatchObject({ currency: 'NGN', balance: 0, fxUnavailable: false, methods: ['card'] });
    expect(before.limits).toEqual({ topupMin: 5_000, topupMax: 2_000_000, presets: [10_000, 20_000, 50_000, 100_000, 200_000], giftMin: 200, giftMax: 50_000 });

    const low = await c.raw('POST', '/api/wallet/topup', { amount: 1_000, method: 'card' });
    expect(low.status).toBe(400);
    expect(low.json).toMatchObject({ error: 'invalid_amount', details: { min: 5_000, max: 2_000_000, currency: 'NGN' } });
    expect((await c.raw('POST', '/api/wallet/topup', { amount: 10_000, method: 'mobile_money', phone: '+2348031234567' })).json.error).toBe('method_unavailable');

    const init = await c.post('/api/wallet/topup', { amount: 10_000, method: 'card' });
    expect(init.body).toMatchObject({ purpose: 'gift_topup', amount: 10_000, currency: 'NGN' });
    expect(await prisma.paymentTransaction.findFirstOrThrow({ where: { reference: init.reference } })).toMatchObject({ amountXAF: convertToXAF(10_000, { currency: 'NGN', rate: NGN, asOf: null, source: 'live' }), fxRate: NGN });
    expect((await c.get('/api/wallet')).balance).toBe(0); // pending never credits
    await settleMock(c, init.reference);
    const after = await c.get('/api/wallet');
    expect(after).toMatchObject({ currency: 'NGN', balance: 10_000 });
    expect(after.entries[0]).toMatchObject({ kind: 'topup', delta: 10_000 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.userId } })).giftCurrency).toBe('NGN');
  });

  it('while the rate is unavailable top-ups pause (503) and the wallet says so, instead of guessing', async () => {
    fxUp();
    const c = await registerFrom('NG', 'growth');
    await settleMock(c, (await c.post('/api/wallet/topup', { amount: 10_000, method: 'card' })).reference);
    await fxDown();
    const r = await c.raw('POST', '/api/wallet/topup', { amount: 10_000, method: 'card' });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('fx_unavailable');
    expect(await c.get('/api/wallet')).toMatchObject({ currency: 'NGN', balance: 10_000, fxUnavailable: true, limits: null });
  });

  it('the wallet currency is fixed by the first top-up: moving country afterwards changes nothing', async () => {
    fxUp({ NGN, KES: 0.2 });
    const c = await registerFrom('NG', 'growth');
    await settleMock(c, (await c.post('/api/wallet/topup', { amount: 10_000, method: 'card' })).reference);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${c.token}`, 'x-sf-country': 'KE' } });
    expect(JSON.parse(me.body).user).toMatchObject({ country: 'NG', preferredCurrency: 'NGN' });
    expect(await c.get('/api/wallet')).toMatchObject({ currency: 'NGN' });
  });

  it('a top-up in flight also freezes the currency, and a second one in another currency is refused', async () => {
    fxUp({ NGN, KES: 0.2 });
    const c = await registerFrom('NG', 'growth');
    await c.post('/api/wallet/topup', { amount: 10_000, method: 'card' }); // pending
    await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${c.token}`, 'x-sf-country': 'KE' } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.userId } })).preferredCurrency).toBe('NGN');
    // force the (impossible by the guards above) case of an owner whose currency differs from a pending top-up
    await prisma.user.update({ where: { id: c.userId }, data: { country: 'KE', preferredCurrency: 'KES' } });
    const r = await c.raw('POST', '/api/wallet/topup', { amount: 5_000, method: 'card' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('topup_in_other_currency');
  });

  it('a wallet credit in another currency than the wallet\'s is refused by the database guard, atomically', async () => {
    fxUp();
    const c = await registerFrom('NG', 'growth');
    await settleMock(c, (await c.post('/api/wallet/topup', { amount: 10_000, method: 'card' })).reference);
    const { creditWallet } = await import('../src/services/wallet');
    await expect(prisma.$transaction((tx) => creditWallet(tx, c.userId, 5_000, 'topup', 'x', 'wrong currency', 'KES'))).rejects.toThrow(/currency mismatch/);
    expect((await c.get('/api/wallet')).balance).toBe(10_000);
  });
});

describe('gifts in the owner\'s currency, paid out in CFA francs', () => {
  const airtime = (amount: number) => ({ giftType: 'airtime', giftValue: '500 NGN airtime', giftAmount: amount, giftDeliveryMode: 'immediate' });
  async function complete(w: World, idx = 0) {
    const [q1, q2] = w.questions;
    await say(app, w, idx, (f) => templateBtn(f, `START:${w.surveyId}`));
    await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q1!, 0), 'button_reply'));
    await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q2!, 0), 'list_reply'));
    await say(app, w, idx, (f) => textMsg(f, 'done'));
  }
  const giftOf = (w: World) => prisma.giftDelivery.findFirstOrThrow({ where: { surveyId: w.surveyId } });
  const spy = (): GiftProvider & { calls: Array<{ kind: string; phone: string; amountXAF: number }> } => {
    const calls: Array<{ kind: string; phone: string; amountXAF: number }> = [];
    return { name: 'spy', calls, sendAirtime: async (phone, amountXAF) => { calls.push({ kind: 'airtime', phone, amountXAF }); return { providerRef: 'spy-1' }; }, sendMoMo: async (phone, amountXAF) => { calls.push({ kind: 'momo', phone, amountXAF }); return { providerRef: 'spy-2' }; } };
  };

  it('the amount is limited to the currency\'s range (200–50,000 NGN, the 100–20,000 FCFA converted)', async () => {
    fxUp();
    const w = await buildWorld(app, { country: 'NG', plan: 'growth', wallet: 10_000, send: false, gift: airtime(500) });
    const body = (n: number) => ({ title: 'T', language: 'en', questions: [{ text: 'Q?', type: 'text', required: true, options: null }], gift: airtime(n) });
    const bad = await w.owner.raw('POST', '/api/surveys', body(100));
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: 'gift_amount_range', details: { min: 200, max: 50_000, currency: 'NGN' } });
    expect((await w.owner.raw('POST', '/api/surveys', body(60_000))).status).toBe(400);
    expect((await w.owner.raw('POST', '/api/surveys', body(200))).status).toBe(201);
    expect((await w.owner.raw('POST', '/api/surveys', body(50_000))).status).toBe(201);
  });

  it('debits amount + fee in naira, converts to FCFA at the live rate for the payout, pins it, and the receipt shows both', async () => {
    fxUp();
    const provider = spy();
    setGiftProvider(provider);
    const w = await buildWorld(app, { country: 'NG', plan: 'growth', wallet: 10_000, gift: airtime(500) });
    await complete(w);
    let g = await giftOf(w);
    expect(g).toMatchObject({ status: 'pending', amount: 500, fee: 25, currency: 'NGN', payoutXAF: null });
    expect((await w.owner.get('/api/wallet')).balance).toBe(9_475); // 10,000 − (500 + 5 %)

    await processDueGifts();
    g = await giftOf(w);
    expect(g).toMatchObject({ status: 'sent', payoutXAF: 208 }); // 500 NGN / 2.4 = 208 FCFA
    expect(provider.calls).toEqual([{ kind: 'airtime', phone: '237677100000', amountXAF: 208 }]);

    const list = await w.owner.get(`/api/surveys/${w.surveyId}/gifts`);
    expect(list).toMatchObject({ currency: 'NGN', money: { sent: { count: 1, amount: 525 } } });
    expect(list.items[0]).toMatchObject({ cost: 525 });

    const html = buildReceiptHtml((await loadReceipt(g.id))!);
    expect(html).toContain('500 NGN');
    expect(html).toContain('208 FCFA');
    expect(html).not.toMatch(/525|fee|frais/i);
  });

  it('with no exchange rate at payout time the gift waits (still debited, provider not called) and goes out once the rate is back', async () => {
    fxUp();
    const provider = spy();
    setGiftProvider(provider);
    const w = await buildWorld(app, { country: 'NG', plan: 'growth', wallet: 10_000, gift: airtime(500) });
    await complete(w);
    await fxDown();
    await processDueGifts();
    let g = await giftOf(w);
    expect(g.status).toBe('pending');
    expect(g.errorMessage).toMatch(/^fx_unavailable/);
    expect(g.attempts).toBe(0); // waiting for a rate is not a failed attempt
    expect(provider.calls).toHaveLength(0);
    expect((await w.owner.get('/api/wallet')).balance).toBe(9_475);

    fxUp();
    await prisma.giftDelivery.update({ where: { id: g.id }, data: { scheduledFor: new Date() } });
    await processDueGifts();
    g = await giftOf(w);
    expect(g).toMatchObject({ status: 'sent', payoutXAF: 208 });
    expect(provider.calls).toHaveLength(1);
  });

  it('a definite provider rejection refunds exactly what was debited, in naira', async () => {
    fxUp();
    setGiftProvider({ name: 'declining', sendMoMo: async () => ({ providerRef: 'x' }), sendAirtime: async () => { throw new GiftError('number not eligible', false); } });
    const w = await buildWorld(app, { country: 'NG', plan: 'growth', wallet: 10_000, gift: airtime(500) });
    await complete(w);
    for (let i = 0; i < 3; i++) { await processDueGifts(); await prisma.giftDelivery.updateMany({ where: { status: 'pending' }, data: { scheduledFor: new Date() } }); }
    expect(await giftOf(w)).toMatchObject({ status: 'failed', payoutXAF: 208 });
    expect((await w.owner.get('/api/wallet')).balance).toBe(10_000);
  });

  it('a Cameroonian owner is untouched: FCFA, 1:1 payout, no exchange rate needed', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const provider = spy();
    setGiftProvider(provider);
    const w = await buildWorld(app, { plan: 'growth', wallet: 10_000, gift: { giftType: 'airtime', giftValue: '500 FCFA airtime', giftAmount: 500, giftDeliveryMode: 'immediate' } });
    await complete(w);
    await processDueGifts();
    expect(await giftOf(w)).toMatchObject({ status: 'sent', currency: 'XAF', amount: 500, fee: 25, payoutXAF: 500 });
    expect(provider.calls[0]!.amountXAF).toBe(500);
    expect(f).not.toHaveBeenCalled();
  });
});
