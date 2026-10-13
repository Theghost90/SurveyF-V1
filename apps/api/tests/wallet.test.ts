import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { giftFeeFCFA, giftUnitCostFCFA, worstCaseGiftCostFCFA } from '@surveyflow/shared';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { GiftError, setGiftProvider } from '../src/services/gifts/providers';
import { processDueGifts } from '../src/services/gifts';
import { notifyEmptyWallets } from '../src/services/wallet';
import { settleTransaction } from '../src/services/payments/service';
import { answerIdFor, buildWorld, chatOf, fundWallet, makeApp, registerOwner, replyMsg, resetAll, say, templateBtn, textMsg, walletState, type World } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { setGiftProvider(null); await resetAll(); });

const airtime = { giftType: 'airtime', giftValue: '500 FCFA airtime', giftAmountFCFA: 500, giftDeliveryMode: 'immediate' };
const FEE = giftFeeFCFA(500, env.GIFT_FEE_PERCENT);
const COST = 500 + FEE; // what ONE gift costs the owner

async function complete(w: World, idx: number) {
  const [q1, q2] = w.questions;
  await say(app, w, idx, (f) => templateBtn(f, `START:${w.surveyId}`));
  await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q1!, 0), 'button_reply'));
  await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q2!, 0), 'list_reply'));
  await say(app, w, idx, (f) => textMsg(f, 'done'));
}

/** The two properties the wallet must keep after ANY sequence of operations. */
async function expectConsistent(userId: string) {
  const s = await walletState(userId);
  expect(s.balance).toBeGreaterThanOrEqual(0);
  expect(s.balance).toBe(s.ledgerSum);
  return s;
}

describe('cost rules (shared)', () => {
  it('rounds the fee UP so SurveyFlow never loses a fraction of a franc, and prices exposure with the gift cap', () => {
    expect(giftFeeFCFA(500, 5)).toBe(25);
    expect(giftFeeFCFA(501, 5)).toBe(26); // 25.05 → 26
    expect(giftFeeFCFA(500, 0)).toBe(0);
    expect(giftUnitCostFCFA(500, 5)).toBe(525);
    expect(worstCaseGiftCostFCFA({ amountFCFA: 500, percent: 5, invited: 1000, alreadyGifted: 0, maxCount: 100 })).toBe(52_500);
    expect(worstCaseGiftCostFCFA({ amountFCFA: 500, percent: 5, invited: 40, alreadyGifted: 0, maxCount: null })).toBe(21_000);
    expect(worstCaseGiftCostFCFA({ amountFCFA: 500, percent: 5, invited: 40, alreadyGifted: 100, maxCount: 100 })).toBe(0);
  });
});

describe('wallet top-up (through the real payment settle path)', () => {
  it('is refused on plans without gift automation (a balance that can never be spent must not be collected)', async () => {
    const o = await registerOwner(app); // trial
    const r = await o.post('/api/wallet/topup', { amountFCFA: 10_000, method: 'mobile_money', phone: '+237677000001' });
    expect(r.status).toBe(402);
    expect(r.error).toBe('plan_feature');
  });

  it('validates the amount server-side and credits only after the PSP confirms, exactly once', async () => {
    const o = await registerOwner(app, { plan: 'growth' });
    const body = { method: 'mobile_money', phone: '+237677000001' };
    expect((await o.post('/api/wallet/topup', { ...body, amountFCFA: 500 })).status).toBe(400); // below minimum
    expect((await o.post('/api/wallet/topup', { ...body, amountFCFA: 5_000_000 })).status).toBe(400); // above cap
    expect((await o.post('/api/wallet/topup', { ...body, amountFCFA: 1234.5 })).status).toBe(400); // not whole francs

    const init = await o.post('/api/wallet/topup', { ...body, amountFCFA: 10_000 });
    expect(init.status).toBe(201);
    expect(init.body).toMatchObject({ purpose: 'gift_topup', amount: 10_000, currency: 'XAF', status: 'pending', plan: null });
    expect((await o.post('/api/wallet/topup', { ...body, amountFCFA: 10_000 })).id).toBe(init.id); // double click: one charge

    expect((await o.get('/api/wallet')).balanceFCFA).toBe(0); // the redirect / pending state never credits
    await o.post(`/api/payments/mock/${init.reference}`, { outcome: 'success' });
    for (let i = 0; i < 3; i++) await o.get(`/api/payments/${init.id}`); // polling + webhook retries
    await o.post(`/api/payments/mock/${init.reference}`, { outcome: 'success' });

    const w = await o.get('/api/wallet');
    expect(w.balanceFCFA).toBe(10_000);
    expect(w.entries).toHaveLength(1);
    expect(w.entries[0]).toMatchObject({ kind: 'topup', deltaFCFA: 10_000, balanceAfter: 10_000 });
    expect((await o.get('/api/auth/me')).plan.key).toBe('growth'); // a top-up must not touch the subscription
    expect((await o.get('/api/subscription')).invoices).toHaveLength(0); // and is not a plan invoice
    await expectConsistent(o.userId);
  });

  it('a declined top-up credits nothing; an under-payment is rejected; an over-payment credits only what was asked', async () => {
    const o = await registerOwner(app, { plan: 'growth' });
    const body = { method: 'mobile_money', phone: '+237677000001' };

    const declined = await o.post('/api/wallet/topup', { ...body, amountFCFA: 5_000 });
    expect((await o.post(`/api/payments/mock/${declined.reference}`, { outcome: 'failed' })).body.status).toBe('failed');

    const under = await prisma.paymentTransaction.create({ data: { ...(await txBase(o.userId)), amount: 8_000, reference: 'sfunder', purpose: 'gift_topup', plan: null } });
    expect(await settleTransaction(under.id, { status: 'success', amount: 7_000, currency: 'XAF' }, { warn() {} })).toBe('amount_mismatch');

    const over = await prisma.paymentTransaction.create({ data: { ...(await txBase(o.userId)), amount: 8_000, reference: 'sfover', purpose: 'gift_topup', plan: null } });
    expect(await settleTransaction(over.id, { status: 'success', amount: 9_999, currency: 'XAF' }, { warn() {} })).toBe('activated');
    expect((await o.get('/api/wallet')).balanceFCFA).toBe(8_000);
    await expectConsistent(o.userId);
  });
});

async function txBase(userId: string) {
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
  return { subscriptionId: sub.id, userId, pspProvider: 'mock', currency: 'XAF', status: 'pending' as const, interval: 'monthly', method: 'mobile_money' };
}

describe('gifts are paid by the owner', () => {
  it('debits amount + fee in the completion transaction, once, and only then promises the gift', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime, wallet: 10_000 });
    await complete(w, 0);
    const s = await expectConsistent(w.owner.userId);
    expect(s.balance).toBe(10_000 - COST);
    expect(s.entries.map((e) => e.kind)).toEqual(['topup', 'gift_debit']);
    const g = (await prisma.giftDelivery.findFirst())!;
    expect(g).toMatchObject({ status: 'pending', amountFCFA: 500, feeFCFA: FEE });
    expect(s.entries[1]).toMatchObject({ deltaFCFA: -COST, refId: g.id });
    expect(((await chatOf(0)).at(-1).message.body as string)).toContain('500 FCFA airtime');

    await processDueGifts();
    expect((await expectConsistent(w.owner.userId)).balance).toBe(10_000 - COST); // delivery itself costs nothing more
  });

  it('with an EMPTY wallet the participant gets a plain thank-you (no promise), nothing is paid, nothing goes negative', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime }); // no wallet
    await complete(w, 0);
    const g = (await prisma.giftDelivery.findFirst())!;
    expect(g.status).toBe('unfunded');
    expect((await chatOf(0)).at(-1).message.body as string).not.toMatch(/airtime|gift/i);
    expect(await processDueGifts()).toBe(0); // the provider is never called for an unpaid gift
    const s = await expectConsistent(w.owner.userId);
    expect(s.balance).toBe(0);
    expect(s.entries).toHaveLength(0);
  });

  it('a partially funded wallet pays the first gifts and leaves the rest unfunded', async () => {
    const w = await buildWorld(app, { plan: 'growth', contacts: 3, gift: airtime, wallet: COST * 2 });
    for (const i of [0, 1, 2]) await complete(w, i);
    const byStatus = (await prisma.giftDelivery.findMany()).map((g) => g.status).sort();
    expect(byStatus).toEqual(['pending', 'pending', 'unfunded']);
    expect((await expectConsistent(w.owner.userId)).balance).toBe(0);
  });

  it('PARALLEL completions can never spend more than the balance (guarded UPDATE, not read-then-write)', async () => {
    const w = await buildWorld(app, { plan: 'growth', contacts: 6, gift: airtime, wallet: COST * 3 + 10 });
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => complete(w, i)));
    const gifts = await prisma.giftDelivery.findMany();
    expect(gifts).toHaveLength(6);
    expect(gifts.filter((g) => g.status === 'pending')).toHaveLength(3);
    expect(gifts.filter((g) => g.status === 'unfunded')).toHaveLength(3);
    expect((await expectConsistent(w.owner.userId)).balance).toBe(10);
  });

  it('the survey cap and the wallet are independent limits (cap reached → no row at all)', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: { ...airtime, giftMaxCount: 1 }, wallet: 10_000 });
    await complete(w, 0);
    await complete(w, 1);
    expect(await prisma.giftDelivery.count()).toBe(1);
    expect((await expectConsistent(w.owner.userId)).balance).toBe(10_000 - COST);
  });
});

describe('releasing the unfunded backlog (explicit, never automatic)', () => {
  it('top-up alone spends nothing; release pays oldest first, stops when funds run out, and notifies by template', async () => {
    const w = await buildWorld(app, { plan: 'growth', contacts: 3, gift: airtime });
    for (const i of [0, 1, 2]) await complete(w, i);
    expect(await prisma.giftDelivery.count({ where: { status: 'unfunded' } })).toBe(3);

    await fundWallet(w.owner.userId, COST * 2);
    expect(await prisma.giftDelivery.count({ where: { status: 'unfunded' } })).toBe(3); // a top-up never auto-spends
    expect((await w.owner.get('/api/wallet')).unfunded).toMatchObject({ count: 3, fcfa: COST * 3 });

    const r = await w.owner.post(`/api/surveys/${w.surveyId}/gifts/release`);
    expect(r).toMatchObject({ released: 2, remaining: 1 });
    expect((await expectConsistent(w.owner.userId)).balance).toBe(0);

    expect(await processDueGifts()).toBe(2);
    const done = await prisma.giftDelivery.findMany({ where: { status: 'sent' } });
    expect(done).toHaveLength(2);
    // the 24h window is long closed: the notice must go through the approved template queue, not as free text
    expect(await prisma.sendJob.count({ where: { kind: 'gift_notice' } })).toBe(2);
  });

  it('a double click / two tabs releases and charges once', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime });
    await complete(w, 0);
    // Funds for TWO gifts but only ONE is owed. If the claim were not a compare-and-set on status, both clicks would debit.
    await fundWallet(w.owner.userId, COST * 2);
    const [a, b] = await Promise.all([1, 2].map(() => w.owner.post(`/api/surveys/${w.surveyId}/gifts/release`)));
    expect(a.released + b.released).toBe(1);
    expect((await expectConsistent(w.owner.userId)).balance).toBe(COST);
    expect(await prisma.giftDelivery.count({ where: { status: 'pending' } })).toBe(1);
  });
});

describe('failures give the money back — except when we cannot know', () => {
  async function failThreeTimes() {
    setGiftProvider({ name: 'declining', sendMoMo: async () => ({ providerRef: 'x' }), sendAirtime: async () => { throw new GiftError('number not eligible', false); } });
    for (let i = 0; i < 3; i++) {
      await processDueGifts();
      await prisma.giftDelivery.updateMany({ where: { status: 'pending' }, data: { scheduledFor: new Date() } });
    }
  }

  it('a DEFINITE provider rejection refunds exactly what was debited, once', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime, wallet: 5_000 });
    await complete(w, 0);
    expect((await walletState(w.owner.userId)).balance).toBe(5_000 - COST);
    await failThreeTimes();
    const g = (await prisma.giftDelivery.findFirst())!;
    expect(g.status).toBe('failed');
    expect(g.refundedAt).not.toBeNull();
    const s = await expectConsistent(w.owner.userId);
    expect(s.balance).toBe(5_000);
    expect(s.entries.map((e) => e.kind)).toEqual(['topup', 'gift_debit', 'gift_refund']);
    await processDueGifts();
    expect((await walletState(w.owner.userId)).balance).toBe(5_000); // nothing to refund twice
  });

  it('retry re-debits; with too little balance it stays failed (and says so)', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime, wallet: COST });
    await complete(w, 0);
    await failThreeTimes();
    setGiftProvider(null);
    // spend the refunded money elsewhere (a second survey's gift) so the retry cannot be covered
    await prisma.user.update({ where: { id: w.owner.userId }, data: { giftBalanceFCFA: 0 } });
    await prisma.walletEntry.create({ data: { userId: w.owner.userId, deltaFCFA: -COST, balanceAfter: 0, kind: 'gift_debit', note: 'spent elsewhere' } });
    expect(await w.owner.post(`/api/surveys/${w.surveyId}/gifts/retry`)).toMatchObject({ requeued: 0, insufficient: 1 });
    expect((await prisma.giftDelivery.findFirst())!.status).toBe('failed');

    await fundWallet(w.owner.userId, COST * 2); // enough for a double charge, so only the compare-and-set can prevent one
    const [a, b] = await Promise.all([1, 2].map(() => w.owner.post(`/api/surveys/${w.surveyId}/gifts/retry`)));
    expect(a.requeued + b.requeued).toBe(1); // concurrent retries charge once
    expect((await expectConsistent(w.owner.userId)).balance).toBe(COST);
    await processDueGifts();
    expect((await prisma.giftDelivery.findFirst())!.status).toBe('sent');
  });

  it('refunds only what the LEDGER says was debited: a gift that was never charged can never mint balance', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime });
    // a pre-wallet / hand-inserted pending gift with no ledger entry
    await prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[0]!, giftType: 'airtime', giftValue: 'x', amountFCFA: 500, feeFCFA: FEE, status: 'pending' } });
    await failThreeTimes();
    expect((await prisma.giftDelivery.findFirst())!.status).toBe('failed');
    const s = await expectConsistent(w.owner.userId);
    expect(s.balance).toBe(0);
    expect(s.entries).toHaveLength(0);
  });

  it('an AMBIGUOUS failure keeps the debit (the provider may have paid) and is surfaced as "needs check"', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime, wallet: 5_000 });
    await complete(w, 0);
    setGiftProvider({ name: 'flaky', sendMoMo: async () => ({ providerRef: 'x' }), sendAirtime: async () => { throw new GiftError('timeout after send', true); } });
    await processDueGifts();
    const g = (await prisma.giftDelivery.findFirst())!;
    expect(g).toMatchObject({ status: 'failed', refundedAt: null });
    expect((await expectConsistent(w.owner.userId)).balance).toBe(5_000 - COST);
    expect((await w.owner.get('/api/wallet')).needsCheck).toMatchObject({ count: 1, fcfa: COST });
    expect(await w.owner.post(`/api/surveys/${w.surveyId}/gifts/retry`)).toMatchObject({ requeued: 0 });
    expect((await w.owner.get(`/api/surveys/${w.surveyId}/gifts`)).money).toMatchObject({ needsCheck: { count: 1, fcfa: COST }, failedRefunded: 0 });
  });
});

describe('money cannot vanish through deletion', () => {
  it('refuses to delete a survey or contact while a paid gift is still being delivered, then allows it', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime, wallet: 5_000 });
    await complete(w, 0);
    await w.owner.post(`/api/surveys/${w.surveyId}/close`);
    expect((await w.owner.del(`/api/surveys/${w.surveyId}`)).status).toBe(409);
    expect((await w.owner.post('/api/contacts/bulk-delete', { ids: [w.contactIds[0]] })).error).toBe('gifts_in_flight');
    expect((await w.owner.del(`/api/contacts/${w.contactIds[0]}`)).status).toBe(409);
    await processDueGifts();
    expect((await w.owner.del(`/api/surveys/${w.surveyId}`)).status).toBe(204);
    await expectConsistent(w.owner.userId);
  });
});

describe('warnings the owner sees (non-blocking)', () => {
  it('publish warns when the wallet is empty; audience previews the worst case; wallet and survey cost agree', async () => {
    const o = await registerOwner(app, { plan: 'growth' });
    await o.post('/api/whatsapp/accounts/mock');
    for (let i = 0; i < 4; i++) await o.post('/api/contacts', { name: `C${i}`, phone: `+2376771000${String(i).padStart(2, '0')}`, consent: true });
    const s = await o.post('/api/surveys', { title: 'T', questions: [{ text: 'q', type: 'text', required: true }], gift: airtime });
    const pub = await o.post(`/api/surveys/${s.id}/publish`);
    expect(pub.status).toBe(200);
    expect(pub.giftWarning).toMatchObject({ code: 'gift_wallet_empty', unitCostFCFA: COST, balanceFCFA: 0 });

    const aud = await o.post(`/api/surveys/${s.id}/audience`, { all: true });
    expect(aud.gift).toMatchObject({ unitCostFCFA: COST, worstCaseFCFA: COST * 4, sufficient: false, empty: true });

    await fundWallet(o.userId, COST * 4);
    expect((await o.post(`/api/surveys/${s.id}/audience`, { all: true })).gift).toMatchObject({ sufficient: true, giftsCovered: 4 });
  });
});

describe('empty-wallet alert', () => {
  it('fires once per owner per day, only when participants were actually left unrewarded', async () => {
    const funded = await buildWorld(app, { plan: 'growth', gift: airtime, wallet: 10_000 });
    await complete(funded, 0);
    expect(await notifyEmptyWallets()).toEqual({ notified: 0 }); // everyone was paid: nothing to say

    const dry = await buildWorld(app, { plan: 'growth', gift: airtime });
    await complete(dry, 0);
    expect(await notifyEmptyWallets()).toEqual({ notified: 1 });
    expect(await notifyEmptyWallets()).toEqual({ notified: 0 }); // not a second time the same day
    await complete(dry, 1);
    expect(await notifyEmptyWallets()).toEqual({ notified: 0 }); // still the same day: one notice, not one per participant
  });
});
