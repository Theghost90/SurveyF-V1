import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { planGift, processDueGifts, releaseHeldGifts } from '../src/services/gifts';
import { setGiftProvider } from '../src/services/gifts/providers';
import { readMockMailbox } from '../src/services/mail';
import { TEST_PASSWORD, answerIdFor, buildWorld, chatOf, fundWallet, makeApp, replyMsg, resetAll, say, templateBtn, textMsg, walletState, type World } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { setGiftProvider(null); await resetAll(); });
const saved = { hold: env.payoutHoldDays, account: env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY, phoneXaf: env.PAYOUT_PHONE_MAX_XAF_PER_DAY, phoneCount: env.PAYOUT_PHONE_MAX_COUNT_PER_DAY };
afterEach(() => { Object.assign(env, { payoutHoldDays: saved.hold, PAYOUT_ACCOUNT_MAX_XAF_PER_DAY: saved.account, PAYOUT_PHONE_MAX_XAF_PER_DAY: saved.phoneXaf, PAYOUT_PHONE_MAX_COUNT_PER_DAY: saved.phoneCount }); });

/**
 * PAY-13: a wallet topped up by card and paid out to phone numbers is the cash-out route for a stolen card, and the chargeback arrives after the money has gone.
 * Containment under test (docs/BACKLOG.md): a cap per account and per phone per day, a hold on young accounts, sized against the providers' dispute terms.
 * The properties that matter: nothing is debited or promised while a gift is held; a cap is exact even when participants finish at the same instant; the owner's
 * "release" and "retry" buttons cannot walk around a cap; held gifts go by themselves, oldest first, when the limit allows.
 */
const DAY = 86_400_000;
const HOUR = 3_600_000;
const airtime = { giftType: 'airtime', giftValue: '500 FCFA airtime', giftAmount: 500, giftDeliveryMode: 'immediate' };
const rich = (extra: Record<string, unknown> = {}) => ({ plan: 'growth' as const, gift: airtime, wallet: 100_000, ...extra });

async function complete(w: World, idx: number) {
  const [q1, q2] = w.questions;
  await say(app, w, idx, (f) => templateBtn(f, `START:${w.surveyId}`));
  await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q1!, 0), 'button_reply'));
  await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q2!, 0), 'list_reply'));
  await say(app, w, idx, (f) => textMsg(f, 'done'));
}
const gifts = () => prisma.giftDelivery.findMany({ orderBy: { createdAt: 'asc' } });
const mailsOf = async (w: World, kind: string) => (await readMockMailbox((await prisma.user.findUniqueOrThrow({ where: { id: w.owner.userId } })).email)).filter((m) => m.kind === kind);

describe('a young account', () => {
  it('has its payouts held: nothing debited, nothing promised, the owner told once; and released by itself, oldest first, when the account is old enough', async () => {
    env.payoutHoldDays = 3;
    const w = await buildWorld(app, rich({ contacts: 3 }));
    await complete(w, 0);
    await complete(w, 1);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: w.owner.userId } });
    const [a, b] = await gifts();
    expect(a).toMatchObject({ status: 'held', heldReason: 'young_account', committedAt: null, committedXAF: null, notifyViaTemplate: true });
    expect(a!.heldUntil!.getTime()).toBe(user.createdAt.getTime() + 3 * DAY);
    expect(b!.status).toBe('held');
    // nothing debited
    expect((await walletState(w.owner.userId)).balance).toBe(100_000);
    // the participant is not promised the gift
    const last = (await chatOf(0)).at(-1).message.body as string;
    expect(last).not.toContain('500 FCFA airtime');
    // the owner is told once (a second held gift does not send a second mail), and the trail says why
    expect(await mailsOf(w, 'payouts_held')).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: 'payout_held' } })).toBe(1);
    // too early: the job leaves them alone
    expect(await releaseHeldGifts(new Date(Date.now() + 2 * DAY))).toEqual({ released: 0, stillHeld: 0, unfunded: 0 });
    // the account is old enough: both go, in order, are debited, committed, and notified by template when sent
    await prisma.user.update({ where: { id: w.owner.userId }, data: { createdAt: new Date(Date.now() - 4 * DAY) } });
    await prisma.giftDelivery.updateMany({ data: { heldUntil: new Date(Date.now() - 1000) } });
    expect(await releaseHeldGifts()).toEqual({ released: 2, stillHeld: 0, unfunded: 0 });
    expect((await gifts()).map((g) => [g.status, g.heldReason, g.heldUntil, g.committedXAF])).toEqual([['pending', null, null, 500], ['pending', null, null, 500]]);
    expect((await walletState(w.owner.userId)).balance).toBeLessThan(100_000 - 1000);
    await processDueGifts();
    expect((await gifts()).map((g) => g.status)).toEqual(['sent', 'sent']);
    expect(await prisma.sendJob.count({ where: { kind: 'gift_notice' } })).toBe(2); // told through the template, the 24 h window being closed
  });

  it('with the hold at 0 nothing is held (the setting for a demo, where nothing real moves)', async () => {
    env.payoutHoldDays = 0;
    const w = await buildWorld(app, rich({ contacts: 1 }));
    await complete(w, 0);
    expect((await gifts())[0]!.status).toBe('pending');
  });
});

describe('the daily cap per account', () => {
  it('lets payouts through up to the cap in any rolling 24 hours, holds the next one, and lets it go once earlier ones have left the window', async () => {
    env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY = 1000;
    const w = await buildWorld(app, rich({ contacts: 3 }));
    for (const i of [0, 1, 2]) await complete(w, i);
    const rows = await gifts();
    expect(rows.map((g) => g.status)).toEqual(['pending', 'pending', 'held']);
    expect(rows[2]).toMatchObject({ heldReason: 'account_daily_cap', committedAt: null });
    expect(rows[2]!.heldUntil!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000); // looked at again in about an hour
    expect(rows[0]!.committedXAF! + rows[1]!.committedXAF!).toBe(1000);
    expect((await walletState(w.owner.userId)).balance).toBe(100_000 - 2 * (500 + 25)); // the held one cost nothing
    // an hour on, the window still holds both: still held
    expect(await releaseHeldGifts(new Date(Date.now() + 2 * HOUR))).toEqual({ released: 0, stillHeld: 1, unfunded: 0 });
    // the first two were committed more than a day before: the third may go
    await prisma.giftDelivery.updateMany({ where: { status: 'pending' }, data: { committedAt: new Date(Date.now() - 25 * HOUR) } });
    expect(await releaseHeldGifts(new Date(Date.now() + 4 * HOUR))).toEqual({ released: 1, stillHeld: 0, unfunded: 0 });
    expect((await gifts()).map((g) => g.status)).toEqual(['pending', 'pending', 'pending']);
  });

  it('counts a gift that failed with an unknown outcome (the money may have left) but not one definitely refunded', async () => {
    env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY = 1000;
    const w = await buildWorld(app, rich({ contacts: 3 }));
    await complete(w, 0);
    await complete(w, 1);
    const [a, b] = await gifts();
    await prisma.giftDelivery.update({ where: { id: a!.id }, data: { status: 'failed', errorMessage: 'ambiguous: x' } }); // unknown outcome: still counts
    await prisma.giftDelivery.update({ where: { id: b!.id }, data: { status: 'failed', refundedAt: new Date() } }); // definitely refunded: does not
    await complete(w, 2);
    expect((await gifts()).map((g) => g.status)).toEqual(['failed', 'failed', 'pending']); // 500 counted, 500 free: fits
    await prisma.giftDelivery.updateMany({ data: { surveyId: w.surveyId } });
    const again = await buildWorld(app, rich({ contacts: 1 })); // a different account: its own cap
    await complete(again, 0);
    expect((await gifts()).at(-1)!.status).toBe('pending');
  });

  it('a single gift above a cap is held for good (it cannot clear by itself), and says so', async () => {
    env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY = 400;
    const w = await buildWorld(app, rich({ contacts: 1 }));
    await complete(w, 0);
    expect((await gifts())[0]).toMatchObject({ status: 'held', heldReason: 'amount_above_cap', heldUntil: null });
    expect(await releaseHeldGifts(new Date(Date.now() + 30 * DAY))).toEqual({ released: 0, stillHeld: 0, unfunded: 0 });
    expect((await gifts())[0]!.status).toBe('held');
  });
});

describe('the daily cap per phone number, from every account together', () => {
  it('stops a number that receives from many accounts, in count and in amount, though each account is far below its own cap', async () => {
    env.PAYOUT_PHONE_MAX_COUNT_PER_DAY = 2;
    const worlds = [await buildWorld(app, rich({ contacts: 1 })), await buildWorld(app, rich({ contacts: 1 })), await buildWorld(app, rich({ contacts: 1 }))];
    for (const w of worlds) await complete(w, 0); // the same number (+237677100000) in all three accounts
    expect((await gifts()).map((g) => [g.status, g.heldReason])).toEqual([['pending', null], ['pending', null], ['held', 'phone_daily_cap']]);
    await resetAll();
    env.PAYOUT_PHONE_MAX_COUNT_PER_DAY = 10;
    env.PAYOUT_PHONE_MAX_XAF_PER_DAY = 1000;
    const again = [await buildWorld(app, rich({ contacts: 1 })), await buildWorld(app, rich({ contacts: 1 })), await buildWorld(app, rich({ contacts: 1 }))];
    for (const w of again) await complete(w, 0);
    expect((await gifts()).map((g) => g.status)).toEqual(['pending', 'pending', 'held']); // 500 + 500 fills it
  });

  it('does not mix up two different numbers', async () => {
    env.PAYOUT_PHONE_MAX_COUNT_PER_DAY = 1;
    const w = await buildWorld(app, rich({ contacts: 3 }));
    for (const i of [0, 1, 2]) await complete(w, i);
    expect((await gifts()).map((g) => g.status)).toEqual(['pending', 'pending', 'pending']);
  });
});

describe('the caps are exact when participants finish at the same instant', () => {
  it('five gifts planned in parallel against room for three: exactly three go, two are held (the locks, not luck)', async () => {
    env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY = 1500;
    const w = await buildWorld(app, rich({ contacts: 5, send: false }));
    const survey = await prisma.survey.findUniqueOrThrow({ where: { id: w.surveyId }, include: { user: true } });
    const contacts = await prisma.contact.findMany({ where: { userId: w.owner.userId } });
    const plans = await Promise.all(contacts.map((c) => prisma.$transaction((tx) => planGift(tx, survey, c))));
    expect(plans.filter((p) => p.type === 'airtime')).toHaveLength(3);
    expect(plans.filter((p) => p.held?.reason === 'account_daily_cap')).toHaveLength(2);
    const rows = await gifts();
    expect(rows.filter((g) => g.status === 'pending')).toHaveLength(3);
    expect(rows.filter((g) => g.status === 'held')).toHaveLength(2);
    expect((await walletState(w.owner.userId)).balance).toBe(100_000 - 3 * (500 + 25));
  });
});

describe('the owner cannot walk around a cap', () => {
  it('"release" after a top-up moves a gift to held instead of paying it when a cap is reached, and pays the others', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime, contacts: 3 }); // no wallet: every gift is unfunded
    for (const i of [0, 1, 2]) await complete(w, i);
    expect((await gifts()).map((g) => g.status)).toEqual(['unfunded', 'unfunded', 'unfunded']);
    await fundWallet(w.owner.userId, 100_000);
    env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY = 1000;
    const r = await w.owner.post(`/api/surveys/${w.surveyId}/gifts/release`);
    expect(r).toMatchObject({ released: 2, held: 1, remaining: 0 });
    expect((await gifts()).map((g) => [g.status, g.heldReason])).toEqual([['pending', null], ['pending', null], ['held', 'account_daily_cap']]);
    expect((await walletState(w.owner.userId)).balance).toBe(100_000 - 2 * 525);
  });

  it('"retry" of a definitely failed gift goes through the same check', async () => {
    const w = await buildWorld(app, rich({ contacts: 2 }));
    await complete(w, 0);
    await complete(w, 1);
    const [a, b] = await gifts();
    for (const g of [a!, b!]) await prisma.giftDelivery.update({ where: { id: g.id }, data: { status: 'failed', refundedAt: new Date(), committedAt: null, committedXAF: null } });
    env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY = 500;
    const r = await w.owner.post(`/api/surveys/${w.surveyId}/gifts/retry`);
    expect(r).toMatchObject({ requeued: 1, held: 1, insufficient: 0 });
    expect((await gifts()).map((g) => g.status)).toEqual(['pending', 'held']);
  });

  it('a held gift that the limits now allow but the wallet can no longer pay becomes unfunded, and waits for the owner', async () => {
    env.payoutHoldDays = 3;
    const w = await buildWorld(app, rich({ contacts: 1 }));
    await complete(w, 0);
    await prisma.user.update({ where: { id: w.owner.userId }, data: { createdAt: new Date(Date.now() - 4 * DAY), giftBalance: 0 } });
    await prisma.giftDelivery.updateMany({ data: { heldUntil: new Date(Date.now() - 1000) } });
    expect(await releaseHeldGifts()).toEqual({ released: 0, stillHeld: 0, unfunded: 1 });
    expect((await gifts())[0]).toMatchObject({ status: 'unfunded', committedAt: null, heldReason: null });
  });
});

describe('around it', () => {
  it('the owner sees held gifts in the survey gifts list, with the reason, and the account cannot be deleted while any is waiting', async () => {
    env.payoutHoldDays = 3;
    const w = await buildWorld(app, rich({ contacts: 1 }));
    await complete(w, 0);
    const list = await w.owner.get(`/api/surveys/${w.surveyId}/gifts`);
    expect(list.money.held).toMatchObject({ count: 1 });
    expect(list.items[0]).toMatchObject({ status: 'held', heldReason: 'young_account' });
    expect(list.items[0].heldUntil).toBeTruthy();
    await w.owner.post('/api/auth/step-up', { method: 'password', secret: TEST_PASSWORD });
    const del = await w.owner.raw('POST', '/api/account/delete', { confirm: 'DELETE' });
    expect(del.status).toBe(409);
    expect(del.json.details.blockers).toContainEqual({ code: 'gifts_in_flight', count: 1 }); // (the wallet balance is a blocker too)
  });

  it('defaults: three days of hold with a real gift provider, none with the mock one; the caps have defaults that a real provider is to be sized against', () => {
    expect(env.PAYOUT_ACCOUNT_MAX_XAF_PER_DAY).toBeGreaterThan(env.PAYOUT_PHONE_MAX_XAF_PER_DAY);
    expect(env.PAYOUT_PHONE_MAX_COUNT_PER_DAY).toBeGreaterThanOrEqual(1);
    expect(saved.hold).toBe(0); // the test environment uses the mock gift provider
  });
});
