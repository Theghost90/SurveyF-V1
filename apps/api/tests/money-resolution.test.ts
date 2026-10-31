import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { prisma, type Tx } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { giftsToVerify, resolveGift, resolvePayment, revealGiftNumber } from '../src/services/money-resolution';
import { buildReport } from '../src/services/reconciliation';
import { creditWallet, debitWallet } from '../src/services/wallet';
import { buildWorld, chatOf, fundWallet, makeApp, resetAll, walletState, type World } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });
const savedCap = env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY;
afterEach(() => { env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY = savedCap; });

/**
 * PAY-07: the money that needs a person. Containment under test (docs/BACKLOG.md): a staff screen is a new privileged surface; manual errors. Delivered here as the
 * rules inside the functions (amounts from the ledger, one decision applies once, who and why on every decision, evidence for "the provider paid", masked numbers) and a
 * command line; no web route reaches them, because the admin backend that would protect one (ADM-01) does not exist yet.
 */
const who = { operator: 'Chantal (ops)', note: 'checked in the provider dashboard' };
const COST = 525;
const INSIDE = ['balance_vs_ledger', 'negative_balance', 'wallet_without_currency', 'gift_ledger_mismatch', 'topup_without_payment', 'topup_credited_twice', 'payment_without_credit'];
/** The books are consistent: the reconciliation's inside checks (ledger, top-ups, payouts) find nothing after a decision. */
const nobodyCanSee = async () => (await buildReport()).findings.filter((f) => INSIDE.includes(f.code)).map((f) => f.code);

/** A gift whose payout nobody can vouch for: debited, failed with an unknown outcome, never to be retried by itself. */
async function unknownOutcome(w: World, i: number) {
  const g = await prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[i]!, giftType: 'airtime', status: 'failed', amount: 500, fee: 25, currency: 'XAF', attempts: 1, errorMessage: 'ambiguous: timeout — check provider for ref sf-gift-x before retrying', providerRef: `sf-gift-${i}`, committedAt: new Date(), committedXAF: 500 } });
  await prisma.$transaction((tx) => debitWallet(tx, w.owner.userId, COST, g.id, 'gift'));
  return g;
}
/** A gift a limit holds for good: one amount above a cap. Never debited. */
const heldForGood = (w: World, i: number) => prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[i]!, giftType: 'airtime', status: 'held', heldReason: 'amount_above_cap', heldUntil: null, amount: 500, fee: 25, currency: 'XAF', notifyViaTemplate: true } });
const world = async (extra: Record<string, unknown> = {}) => {
  const w = await buildWorld(app, { plan: 'growth', contacts: 4, send: false, wallet: 0, gift: { giftType: 'airtime', giftValue: '500 FCFA airtime', giftAmount: 500, giftDeliveryMode: 'immediate' }, ...extra });
  await prisma.$transaction((tx) => creditWalletFor(tx, w.owner.userId));
  return w;
};
// the wallet money comes with a successful payment behind it, as in production, so that the reconciliation has nothing to say about it
async function creditWalletFor(tx: Tx, userId: string) {
  const sub = await tx.subscription.findUniqueOrThrow({ where: { userId } });
  const p = await tx.paymentTransaction.create({ data: { subscriptionId: sub.id, userId, pspProvider: 'flutterwave', currency: 'XAF', status: 'success', interval: 'monthly', method: 'mobile_money', purpose: 'gift_topup', amount: 10_000, reference: `m${Date.now()}${Math.random()}`, paidAt: new Date() } });
  await creditWallet(tx, userId, 10_000, 'topup', p.id, 'test', 'XAF');
}

describe('what needs a person', () => {
  it('lists unknown-outcome payouts and gifts held for good, with masked numbers and what the ledger holds; and nothing else', async () => {
    const w = await world();
    const a = await unknownOutcome(w, 0);
    const b = await heldForGood(w, 1);
    // none of these needs a person: a refunded failure, a gift in flight, one held by a clock, an unfunded one, a discount code
    await prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[2]!, giftType: 'airtime', status: 'failed', amount: 500, fee: 25, currency: 'XAF', refundedAt: new Date() } });
    await prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[3]!, giftType: 'airtime', status: 'held', heldReason: 'young_account', heldUntil: new Date(Date.now() + 86_400_000), amount: 500, fee: 25, currency: 'XAF' } });
    const rows = await giftsToVerify();
    expect(rows.map((r) => [r.id, r.why]).sort()).toEqual([[a.id, 'unknown_outcome'], [b.id, 'held_for_good']].sort());
    const unknown = rows.find((r) => r.id === a.id)!;
    expect(unknown).toMatchObject({ amount: 500, fee: 25, inLedger: COST, owner: expect.stringContaining('@') });
    expect(unknown.phone).toMatch(/XXX/);
    expect(unknown.phone).not.toContain('6771000'); // the number is masked
    expect(rows.find((r) => r.id === b.id)!.inLedger).toBe(0);
  });
});

describe('"the provider did pay"', () => {
  it('needs who, why and the provider\'s own reference; marks the gift sent, tells the participant, leaves the ledger alone, and applies once', async () => {
    const w = await world();
    const g = await unknownOutcome(w, 0);
    await expect(resolveGift(g.id, 'sent', { operator: '', note: 'x long enough' })).rejects.toThrow(/who is deciding/);
    await expect(resolveGift(g.id, 'sent', { operator: 'C', note: 'no' })).rejects.toThrow(/say why|who is deciding/);
    await expect(resolveGift(g.id, 'sent', { ...who })).rejects.toThrow(/provider's own reference/);
    expect((await prisma.giftDelivery.findUniqueOrThrow({ where: { id: g.id } })).status).toBe('failed'); // nothing changed by the refusals
    const before = (await walletState(w.owner.userId)).balance;
    expect(await resolveGift(g.id, 'sent', { ...who, evidence: 'CP-9981-A7' })).toBe('done');
    expect(await resolveGift(g.id, 'sent', { ...who, evidence: 'CP-9981-A7' })).toBe('not_resolvable');
    expect(await prisma.giftDelivery.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ status: 'sent', providerRef: 'CP-9981-A7', errorMessage: null });
    expect((await walletState(w.owner.userId)).balance).toBe(before);
    expect((await chatOf(0)).at(-1).message.kind).toBe('link'); // the participant is told, with the receipt button
    expect(await nobodyCanSee()).toEqual([]);
  });

  it('is recorded twice: in full, unlinked from the customer (so the note is never shown to them), and as a bare line in the customer\'s own activity', async () => {
    const w = await world();
    const g = await unknownOutcome(w, 0);
    await resolveGift(g.id, 'sent', { operator: 'Chantal (ops)', note: 'private reason about this account', evidence: 'CP-1' });
    const internal = await prisma.auditLog.findFirstOrThrow({ where: { action: 'staff_gift_resolved' } });
    expect(internal.userId).toBeNull();
    expect(internal.meta).toMatchObject({ ownerId: w.owner.userId, giftId: g.id, decision: 'sent', operator: 'Chantal (ops)', note: 'private reason about this account', evidence: 'CP-1' });
    const activity = await w.owner.get('/api/auth/activity');
    const line = activity.items.find((i: { action: string }) => i.action === 'support_action');
    expect(line.meta).toEqual({ what: 'gift', result: 'done' });
    expect(JSON.stringify(activity)).not.toContain('private reason');
  });
});

describe('"the provider did not pay"', () => {
  it('returns what the LEDGER says the gift holds (there is no amount to type), once, even if two operators decide at the same instant; the owner can then retry', async () => {
    const w = await world();
    const g = await unknownOutcome(w, 0);
    const before = (await walletState(w.owner.userId)).balance;
    const results = await Promise.all([resolveGift(g.id, 'refund', who), resolveGift(g.id, 'refund', { ...who, operator: 'Second person' })]);
    expect(results.sort()).toEqual(['done', 'not_resolvable']);
    const s = await walletState(w.owner.userId);
    expect(s.balance).toBe(before + COST); // once
    expect(s.balance).toBe(s.ledgerSum);
    expect(await prisma.giftDelivery.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ status: 'failed', refundedAt: expect.any(Date) });
    expect(await prisma.auditLog.count({ where: { action: 'staff_gift_resolved' } })).toBe(1); // the loser leaves no record of a decision that did not happen
    expect(await nobodyCanSee()).toEqual([]);
    const retry = await w.owner.post(`/api/surveys/${w.surveyId}/gifts/retry`);
    expect(retry).toMatchObject({ requeued: 1 });
  });

  it('refunds nothing for a gift the ledger never debited (a legacy or seeded row cannot make money out of nothing)', async () => {
    const w = await world();
    const g = await prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[0]!, giftType: 'airtime', status: 'failed', amount: 500, fee: 25, currency: 'XAF', errorMessage: 'ambiguous: x' } });
    const before = (await walletState(w.owner.userId)).balance;
    expect(await resolveGift(g.id, 'refund', who)).toBe('done');
    expect((await walletState(w.owner.userId)).balance).toBe(before);
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'staff_gift_resolved' } })).toMatchObject({ meta: expect.objectContaining({ moved: 0 }) });
  });
});

describe('a gift held for good', () => {
  it('"release" pays it whatever the limits say, once, counted in the limits from then on; with an empty wallet it waits for funds instead', async () => {
    env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY = 400; // the gift of 500 is above it
    const w = await world();
    const g = await heldForGood(w, 0);
    const before = (await walletState(w.owner.userId)).balance;
    expect(await resolveGift(g.id, 'release', who)).toBe('done');
    expect(await resolveGift(g.id, 'release', who)).toBe('not_resolvable');
    expect(await prisma.giftDelivery.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ status: 'pending', heldReason: null, committedXAF: 500, notifyViaTemplate: true });
    expect((await walletState(w.owner.userId)).balance).toBe(before - COST);
    expect(await nobodyCanSee()).toEqual([]);
    // an owner whose wallet is empty
    await resetAll();
    const poor = await buildWorld(app, { plan: 'growth', contacts: 1, send: false, gift: { giftType: 'airtime', giftValue: '500', giftAmount: 500, giftDeliveryMode: 'immediate' } });
    const h = await heldForGood(poor, 0);
    expect(await resolveGift(h.id, 'release', who)).toBe('insufficient');
    expect(await prisma.giftDelivery.findUniqueOrThrow({ where: { id: h.id } })).toMatchObject({ status: 'unfunded', committedAt: null });
  });

  it('"cancel" drops it: nothing was debited, nothing is given back, the books stay consistent', async () => {
    const w = await world();
    const g = await heldForGood(w, 0);
    const before = await walletState(w.owner.userId);
    expect(await resolveGift(g.id, 'cancel', { operator: 'Chantal', note: 'the number belongs to the owner' })).toBe('done');
    expect(await resolveGift(g.id, 'cancel', who)).toBe('not_resolvable');
    expect(await prisma.giftDelivery.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ status: 'failed', refundedAt: expect.any(Date), errorMessage: expect.stringContaining('cancelled by an operator') });
    expect((await walletState(w.owner.userId)).balance).toBe(before.balance);
    expect(await nobodyCanSee()).toEqual([]);
  });
});

describe('the wrong decision for the state is refused, and changes nothing', () => {
  it('sent or refund on a held gift, release or cancel on an unknown outcome, anything on a gift in flight or a missing one', async () => {
    const w = await world();
    const unknown = await unknownOutcome(w, 0);
    const held = await heldForGood(w, 1);
    const inflight = await prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[2]!, giftType: 'airtime', status: 'pending', amount: 500, fee: 25, currency: 'XAF' } });
    const before = (await walletState(w.owner.userId)).balance;
    expect(await resolveGift(held.id, 'sent', { ...who, evidence: 'ref-1' })).toBe('not_resolvable');
    expect(await resolveGift(held.id, 'refund', who)).toBe('not_resolvable');
    expect(await resolveGift(unknown.id, 'release', who)).toBe('not_resolvable');
    expect(await resolveGift(unknown.id, 'cancel', who)).toBe('not_resolvable');
    for (const d of ['sent', 'refund', 'release', 'cancel'] as const) expect(await resolveGift(inflight.id, d, { ...who, evidence: 'ref-2' })).toBe('not_resolvable');
    expect(await resolveGift('no-such-gift', 'refund', who)).toBe('not_resolvable');
    expect((await walletState(w.owner.userId)).balance).toBe(before);
    expect((await prisma.giftDelivery.findMany({ orderBy: { createdAt: 'asc' } })).map((g) => g.status)).toEqual(['failed', 'held', 'pending']);
    expect(await prisma.auditLog.count({ where: { action: { in: ['staff_gift_resolved', 'support_action'] } } })).toBe(0);
  });
});

describe('showing a participant\'s number in full', () => {
  it('is a separate step that needs who and why and leaves a record', async () => {
    const w = await world();
    const g = await unknownOutcome(w, 0);
    await expect(revealGiftNumber(g.id, { operator: 'C', note: '' })).rejects.toThrow();
    expect(await prisma.auditLog.count({ where: { action: 'staff_number_revealed' } })).toBe(0);
    expect(await revealGiftNumber(g.id, who)).toMatch(/^\+2376771000/);
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'staff_number_revealed' } })).toMatchObject({ userId: null, meta: expect.objectContaining({ giftId: g.id, operator: 'Chantal (ops)' }) });
  });
});

describe('payments the provider confirmed and SurveyFlow could not apply', () => {
  const review = async (userId: string) => {
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
    return prisma.paymentTransaction.create({ data: { subscriptionId: sub.id, userId, pspProvider: 'notchpay', amount: 39000, currency: 'XAF', status: 'review', reference: `rv${Math.random().toString(36).slice(2, 12)}`, purpose: 'subscription', plan: 'growth', interval: 'monthly', method: 'card', failReason: 'underpaid: provider reports 3000 XAF, asked 39000 XAF' } });
  };

  it('are credited or rejected with who and why, recorded in full for the operator and as a bare line for the customer, once', async () => {
    const w = await world();
    const a = await review(w.owner.userId);
    await expect(resolvePayment(a.id, 'credit', { operator: '', note: 'a reason' })).rejects.toThrow();
    expect(await resolvePayment(a.id, 'reject', who)).toBe('rejected');
    expect(await resolvePayment(a.id, 'reject', who)).toBe('not_in_review');
    expect(await resolvePayment(a.id, 'credit', who)).toBe('not_in_review');
    const tx = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: a.id } });
    expect(tx.status).toBe('failed');
    expect(tx.failReason).toContain('Chantal (ops): checked in the provider dashboard');
    const internal = await prisma.auditLog.findMany({ where: { action: 'staff_payment_resolved' } });
    expect(internal).toHaveLength(1);
    expect(internal[0]).toMatchObject({ userId: null, meta: expect.objectContaining({ ownerId: w.owner.userId, decision: 'reject', result: 'rejected', reference: a.reference }) });
    expect(await prisma.auditLog.count({ where: { action: 'support_action', userId: w.owner.userId } })).toBe(1);
    const b = await review(w.owner.userId);
    expect(await resolvePayment(b.id, 'credit', who)).toBe('credited');
    expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('success');
    expect(await resolvePayment('no-such-payment', 'credit', who)).toBe('not_in_review');
  });
});

describe('no web route reaches any of this', () => {
  it('there is no operator route: the decisions are only reachable from the command line (the admin backend that would protect one does not exist)', async () => {
    for (const url of ['/api/ops/gifts', '/api/admin/gifts', '/api/staff/gifts', '/api/operator/gifts', '/api/ops/payments']) {
      const w = await world();
      expect((await w.owner.raw('GET', url)).status).toBe(404);
      expect((await w.owner.raw('POST', url, {})).status).toBe(404);
    }
    void fundWallet;
  });
});
