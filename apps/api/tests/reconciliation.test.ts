import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Currency } from '@surveyflow/shared';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { readMockMailbox } from '../src/services/mail';
import { BALANCE_FETCHERS, buildReport, fetchProviderBalances, recordBalance, runDailyReconciliation, runReconciliation } from '../src/services/reconciliation';
import { creditWallet, debitWallet } from '../src/services/wallet';
import { buildWorld, makeApp, registerOwner, resetAll } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });
const saved = { ...env } as Record<string, unknown>;
afterEach(() => { for (const k of ['OPERATOR_EMAIL', 'BALANCE_SOURCES', 'FLUTTERWAVE_SECRET_KEY', 'CAMPAY_API_KEY', 'CAMPAY_ENV', 'RECONCILE_MIN_SHORTFALL_XAF', 'RECONCILE_MIN_SHORTFALL_PERCENT', 'RECONCILE_BALANCE_MAX_AGE_HOURS']) (env as Record<string, unknown>)[k] = saved[k]; });

/**
 * PAY-02: a silent cash shortfall is the failure nobody sees until a payout is refused. Containment under test (docs/BACKLOG.md): read-only keys, thresholds,
 * de-duplicated alerts; the stop-gap is a daily check. What must hold: the inside checks are exact; the comparison with the providers is only made when it can be made
 * honestly (every provider that holds money has a fresh balance); a shortfall below the thresholds is no alarm; each finding alarms once a day; nothing here ever sends
 * anything but a GET, and a balance that cannot be read is "unknown", never a shortfall.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const codes = (r: { findings: Array<{ code: string; severity: string }> }, severity = 'alert') => r.findings.filter((f) => f.severity === severity).map((f) => f.code);
let seq = 0;

/** A wallet top-up the way production makes one: a successful payment, and a ledger credit that points at it. */
async function topUp(userId: string, amount: number, provider = 'flutterwave', currency: Currency = 'XAF') {
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
  const p = await prisma.paymentTransaction.create({
    data: { subscriptionId: sub.id, userId, pspProvider: provider, currency, status: 'success', interval: 'monthly', method: 'mobile_money', purpose: 'gift_topup', amount, reference: `t${++seq}-${Date.now()}`, paidAt: new Date() },
  });
  await prisma.$transaction((tx) => creditWallet(tx, userId, amount, 'topup', p.id, 'test top-up', currency));
  return p;
}
const hold = (provider: string, amount: number, extra: Partial<{ currency: string; asOf: Date }> = {}) => recordBalance({ provider, currency: extra.currency ?? 'XAF', available: amount, source: 'manual', asOf: extra.asOf });

describe('inside SurveyFlow: the checks that need no provider', () => {
  it('a clean system has no finding, whatever happens to a wallet through the real operations', async () => {
    const w = await buildWorld(app, { plan: 'growth', contacts: 1, send: false, gift: { giftType: 'airtime', giftValue: '500', giftAmount: 500, giftDeliveryMode: 'immediate' } });
    await topUp(w.owner.userId, 10_000);
    const gift = await prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[0]!, giftType: 'airtime', status: 'pending', amount: 500, fee: 25, currency: 'XAF' } });
    await prisma.$transaction((tx) => debitWallet(tx, w.owner.userId, 525, gift.id, 'test'));
    await hold('flutterwave', 20_000);
    const r = await buildReport();
    expect(codes(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.wallets).toEqual([{ currency: 'XAF', amount: 9_475, xaf: 9_475 }]);
    expect(r.payoutsInFlight).toEqual([{ currency: 'XAF', amount: 500, xaf: 500 }]); // the payout, not the fee: the fee is SurveyFlow's
    expect(r.obligationsXAF).toBe(9_975);
  });

  it('finds a balance that is not the sum of its ledger, and a negative one', async () => {
    const o = await registerOwner(app, { plan: 'growth' });
    await topUp(o.userId, 5_000);
    await prisma.$executeRaw`UPDATE "User" SET "giftBalanceFCFA" = 5100 WHERE "id" = ${o.userId}`;
    expect(codes(await buildReport())).toContain('balance_vs_ledger');
    // The database itself refuses a negative balance (a check constraint): the finding is the second line, for the day somebody drops that constraint.
    await prisma.$executeRawUnsafe('ALTER TABLE "User" DROP CONSTRAINT "User_giftBalanceFCFA_nonnegative"');
    try {
      await prisma.$executeRaw`UPDATE "User" SET "giftBalanceFCFA" = -1 WHERE "id" = ${o.userId}`;
      expect(codes(await buildReport())).toEqual(expect.arrayContaining(['balance_vs_ledger', 'negative_balance']));
    } finally {
      await prisma.$executeRaw`UPDATE "User" SET "giftBalanceFCFA" = 0 WHERE "id" = ${o.userId}`;
      await prisma.$executeRawUnsafe('ALTER TABLE "User" ADD CONSTRAINT "User_giftBalanceFCFA_nonnegative" CHECK ("giftBalanceFCFA" >= 0)');
    }
  });

  it('finds a gift debited twice or never, and a refund for a gift that did not fail', async () => {
    const w = await buildWorld(app, { plan: 'growth', contacts: 3, send: false });
    await topUp(w.owner.userId, 10_000);
    const mk = (i: number, status: 'pending' | 'failed', refundedAt?: Date) => prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[i]!, giftType: 'airtime', status, amount: 500, fee: 25, currency: 'XAF', refundedAt } });
    const never = await mk(0, 'pending'); // pending but never debited
    const twice = await mk(1, 'pending');
    await prisma.$transaction(async (tx) => { await debitWallet(tx, w.owner.userId, 525, twice.id); await debitWallet(tx, w.owner.userId, 525, twice.id); });
    const refund = await mk(2, 'pending');
    await prisma.$transaction(async (tx) => { await debitWallet(tx, w.owner.userId, 525, refund.id); await creditWallet(tx, w.owner.userId, 525, 'gift_refund', refund.id); });
    const r = await buildReport();
    const f = r.findings.find((x) => x.code === 'gift_ledger_mismatch')!;
    expect(f.message).toContain('3 gift(s)');
    expect((f.detail as Array<{ id: string }>).map((d) => d.id).sort()).toEqual([never.id, twice.id, refund.id].sort());
  });

  it('a definitely refunded gift, an unfunded one and a held one are consistent with a ledger that has nothing for them', async () => {
    const w = await buildWorld(app, { plan: 'growth', contacts: 3, send: false });
    await topUp(w.owner.userId, 10_000);
    const refunded = await prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[0]!, giftType: 'airtime', status: 'failed', amount: 500, fee: 25, currency: 'XAF', refundedAt: new Date() } });
    await prisma.$transaction(async (tx) => { await debitWallet(tx, w.owner.userId, 525, refunded.id); await creditWallet(tx, w.owner.userId, 525, 'gift_refund', refunded.id); });
    await prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[1]!, giftType: 'airtime', status: 'unfunded', amount: 500, fee: 25, currency: 'XAF' } });
    await prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[2]!, giftType: 'airtime', status: 'held', amount: 500, fee: 25, currency: 'XAF' } });
    await hold('flutterwave', 10_000);
    expect(codes(await buildReport())).toEqual([]);
  });

  it('finds money in a wallet that never arrived, a payment credited twice, and a payment that never reached a wallet', async () => {
    const o = await registerOwner(app, { plan: 'growth' });
    // a credit pointing at nothing
    await prisma.$transaction((tx) => creditWallet(tx, o.userId, 1_000, 'topup', 'no-such-payment', 'x', 'XAF'));
    // a payment credited twice
    const p = await topUp(o.userId, 2_000);
    await prisma.$transaction((tx) => creditWallet(tx, o.userId, 2_000, 'topup', p.id, 'again', 'XAF'));
    // a successful payment that was never credited
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: o.userId } });
    await prisma.paymentTransaction.create({ data: { subscriptionId: sub.id, userId: o.userId, pspProvider: 'flutterwave', currency: 'XAF', status: 'success', interval: 'monthly', method: 'card', purpose: 'gift_topup', amount: 3_000, reference: `lost-${Date.now()}`, paidAt: new Date() } });
    expect(codes(await buildReport())).toEqual(expect.arrayContaining(['topup_without_payment', 'topup_credited_twice', 'payment_without_credit']));
    // a credit whose amount differs from its payment is the same finding
    await resetAll();
    const o2 = await registerOwner(app, { plan: 'growth' });
    const p2 = await topUp(o2.userId, 2_000);
    await prisma.$executeRaw`UPDATE "PaymentTransaction" SET "amount" = 1999 WHERE "id" = ${p2.id}`;
    expect(codes(await buildReport())).toContain('topup_without_payment');
  });
});

describe('against the providers', () => {
  it('compares what is owed with what the providers hold, in CFA francs, only when every provider that holds customers\' money has a fresh balance', async () => {
    const a = await registerOwner(app, { plan: 'growth' });
    const b = await registerOwner(app, { plan: 'growth' });
    await topUp(a.userId, 40_000, 'flutterwave');
    await topUp(b.userId, 60_000, 'notchpay');
    // nothing typed in: not compared, and the nag says which
    let r = await buildReport();
    expect(r.assetsXAF).toBeNull();
    expect(r.findings.find((f) => f.code === 'provider_balance_missing')!.message).toMatch(/flutterwave \(never\), notchpay \(never\)/);
    // one of the two: still not compared (half of the money against all of the debt would be a false alarm)
    await hold('flutterwave', 40_000);
    r = await buildReport();
    expect(r.assetsXAF).toBeNull();
    expect(r.findings.find((f) => f.code === 'provider_balance_missing')!.message).toMatch(/notchpay \(never\)/);
    // both: compared
    await hold('notchpay', 60_000);
    r = await buildReport();
    expect(r).toMatchObject({ obligationsXAF: 100_000, assetsXAF: 100_000, shortfallXAF: 0, ok: true });
  });

  it('is no alarm for a shortfall under the thresholds (in francs AND in percent), an alarm above both, and none for a surplus', async () => {
    const o = await registerOwner(app, { plan: 'growth' });
    await topUp(o.userId, 1_000_000);
    // 3,000 short: under 5,000 francs
    await hold('flutterwave', 997_000);
    expect(codes(await buildReport())).toEqual([]);
    // 15,000 short: over 5,000 francs but under 2 % of 1,000,000 (20,000)
    await hold('flutterwave', 985_000);
    expect(codes(await buildReport())).toEqual([]);
    // 25,000 short: over both
    await hold('flutterwave', 975_000);
    const r = await buildReport();
    expect(codes(r)).toEqual(['provider_shortfall']);
    expect(r.findings[0]!.detail).toMatchObject({ obligationsXAF: 1_000_000, assetsXAF: 975_000, shortfallXAF: 25_000, threshold: 20_000 });
    // a surplus is fine (the provider also holds SurveyFlow's own income)
    await hold('flutterwave', 5_000_000);
    expect(codes(await buildReport())).toEqual([]);
    // the thresholds are settings
    env.RECONCILE_MIN_SHORTFALL_PERCENT = 0;
    env.RECONCILE_MIN_SHORTFALL_XAF = 0;
    await hold('flutterwave', 999_999);
    expect(codes(await buildReport())).toEqual(['provider_shortfall']);
  });

  it('money that only came through the mock provider is a demo, not a shortfall: nothing to compare, said as information', async () => {
    const o = await registerOwner(app, { plan: 'growth' });
    await topUp(o.userId, 10_000, 'mock');
    const r = await buildReport();
    expect(codes(r)).toEqual([]);
    expect(codes(r, 'info')).toEqual(['no_provider_holds_money']);
    expect(r).toMatchObject({ ok: true, obligationsXAF: 10_000, assetsXAF: null, shortfallXAF: null });
  });

  it('does not use a balance that is too old, and says how old the last one was', async () => {
    const o = await registerOwner(app, { plan: 'growth' });
    await topUp(o.userId, 10_000);
    await hold('flutterwave', 10_000, { asOf: new Date(Date.now() - 3 * DAY) });
    const r = await buildReport();
    expect(r.assetsXAF).toBeNull();
    expect(r.findings.find((f) => f.code === 'provider_balance_missing')!.message).toMatch(/flutterwave \(last 72 h ago\)/);
    expect(r.providers[0]).toMatchObject({ provider: 'flutterwave', fresh: false });
    env.RECONCILE_BALANCE_MAX_AGE_HOURS = 100;
    expect((await buildReport()).assetsXAF).toBe(10_000);
  });

  it('uses the latest balance of each provider and currency, not the sum of the history', async () => {
    const o = await registerOwner(app, { plan: 'growth' });
    await topUp(o.userId, 10_000);
    await hold('flutterwave', 50_000, { asOf: new Date(Date.now() - 2 * HOUR) });
    await hold('flutterwave', 10_000, { asOf: new Date(Date.now() - 1 * HOUR) });
    expect((await buildReport()).assetsXAF).toBe(10_000);
  });

  it('adds payouts in flight to what is owed, converts the euro at its fixed peg, and leaves out (and says so) a currency with no known rate instead of guessing', async () => {
    const o = await registerOwner(app, { plan: 'growth' });
    await topUp(o.userId, 10, 'flutterwave', 'EUR');
    const n = await registerOwner(app, { plan: 'growth' });
    await topUp(n.userId, 5_000, 'flutterwave', 'NGN');
    const r = await buildReport();
    expect(r.wallets.find((w) => w.currency === 'EUR')).toMatchObject({ amount: 10, xaf: 6_560 }); // 10 x 655.957
    expect(r.wallets.find((w) => w.currency === 'NGN')).toMatchObject({ amount: 5_000, xaf: null });
    expect(r.obligationsXAF).toBe(6_560);
    expect(codes(r, 'info')).toContain('fx_unavailable');
  });
});

describe('alerts: once a day, to the operator, and never a changed wallet', () => {
  const tamper = async () => { const o = await registerOwner(app, { plan: 'growth' }); await topUp(o.userId, 1_000); await prisma.$executeRaw`UPDATE "User" SET "giftBalanceFCFA" = 1 WHERE "id" = ${o.userId}`; return o; };
  const mails = async () => (await readMockMailbox('ops@example.test')).filter((m) => m.kind === 'reconciliation_alert');

  it('sends one mail for a new finding, none for the same finding the same day, and one again the next day while it lasts', async () => {
    env.OPERATOR_EMAIL = 'ops@example.test';
    const o = await tamper();
    const balanceBefore = (await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).giftBalance;
    const t0 = new Date('2026-11-02T08:00:00Z');
    expect((await runReconciliation({ now: t0, fetchBalances: false })).ok).toBe(false);
    await runReconciliation({ now: new Date(t0.getTime() + 2 * HOUR), fetchBalances: false });
    expect(await mails()).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: 'reconciliation_alert' } })).toBe(1);
    await runReconciliation({ now: new Date(t0.getTime() + DAY), fetchBalances: false });
    expect(await mails()).toHaveLength(2);
    // the check changed nothing
    expect((await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).giftBalance).toBe(balanceBefore);
    expect(await prisma.reconciliationRun.count()).toBe(3);
  });

  it('a second, different finding the same day is told on its own; a clean run says nothing', async () => {
    env.OPERATOR_EMAIL = 'ops@example.test';
    const o = await tamper();
    const t0 = new Date('2026-11-02T08:00:00Z');
    await runReconciliation({ now: t0, fetchBalances: false });
    await prisma.$transaction((tx) => creditWallet(tx, o.userId, 700, 'topup', 'no-such-payment', 'x', 'XAF')); // a second, different finding
    await runReconciliation({ now: new Date(t0.getTime() + HOUR), fetchBalances: false });
    const m = await mails();
    expect(m).toHaveLength(2);
    await resetAll();
    await runReconciliation({ now: new Date(t0.getTime() + 3 * DAY), fetchBalances: false });
    expect(await mails()).toHaveLength(0);
  });

  it('without an operator address the alert is logged and recorded, and nothing is mailed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await tamper();
      expect((await runReconciliation({ fetchBalances: false })).ok).toBe(false);
      expect(spy).toHaveBeenCalledWith('RECONCILIATION', expect.any(Array));
      expect((await prisma.reconciliationRun.findFirstOrThrow()).ok).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('the scheduled entry runs once a day however often it is called', async () => {
    const t0 = new Date('2026-11-02T08:00:00Z');
    expect(await runDailyReconciliation(t0)).toMatchObject({ ran: true, ok: true });
    expect(await runDailyReconciliation(new Date(t0.getTime() + 6 * HOUR))).toEqual({ ran: false });
    expect(await runDailyReconciliation(new Date(t0.getTime() + 24 * HOUR))).toMatchObject({ ran: true });
    expect(await prisma.reconciliationRun.count()).toBe(2);
  });
});

describe('reading the balances the providers publish (GET only, off by default)', () => {
  const answer = (body: unknown, ok = true) => vi.fn(async (_url: string, init?: RequestInit) => { void init; return { ok, status: ok ? 200 : 401, json: async () => body } as Response; });

  it('does nothing at all unless a provider is named in BALANCE_SOURCES', async () => {
    env.FLUTTERWAVE_SECRET_KEY = 'sk-test';
    const f = answer({});
    expect(await fetchProviderBalances(new Date(), f as never)).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it('reads Flutterwave\'s documented answer with a GET and the key it already has, and stores it as an API reading', async () => {
    env.BALANCE_SOURCES = 'flutterwave';
    env.FLUTTERWAVE_SECRET_KEY = 'sk-test';
    const f = answer({ status: 'success', message: 'Wallet balances fetched', data: [{ currency: 'NGN', available_balance: 12345.6, ledger_balance: 20000 }, { currency: 'USD', available_balance: 10, ledger_balance: 10 }] });
    expect(await fetchProviderBalances(new Date(), f as never)).toEqual([]);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.flutterwave.com/v3/balances');
    expect(init).toMatchObject({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }) });
    expect(init!.body).toBeUndefined();
    const rows = await prisma.providerBalance.findMany({ orderBy: { currency: 'asc' } });
    expect(rows.map((r) => [r.provider, r.currency, r.available, r.source])).toEqual([['flutterwave', 'NGN', 12345.6, 'api'], ['flutterwave', 'USD', 10, 'api']]);
  });

  it('reads Campay\'s balance from the endpoint third-party SDKs document, on the host of its environment', async () => {
    env.BALANCE_SOURCES = 'campay';
    env.CAMPAY_API_KEY = 'ck';
    env.CAMPAY_ENV = 'prod';
    const f = answer({ total_balance: 250_000, mtn_balance: 100_000, orange_balance: 150_000, currency: 'XAF' });
    await fetchProviderBalances(new Date(), f as never);
    expect(f.mock.calls[0]![0]).toBe('https://campay.net/api/balance/');
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Token ck' }) });
    expect((await prisma.providerBalance.findFirstOrThrow()).available).toBe(250_000);
  });

  it('a balance that cannot be read is unknown, never a shortfall: the last one on record is kept, and the reason is reported without any key', async () => {
    env.BALANCE_SOURCES = 'flutterwave';
    env.FLUTTERWAVE_SECRET_KEY = 'sk-secret-value';
    for (const f of [answer({}, false), answer({ status: 'error' }), vi.fn(async () => { throw new Error('connect ECONNREFUSED'); })]) {
      const notes = await fetchProviderBalances(new Date(), f as never);
      expect(notes.map((x) => [x.code, x.severity])).toEqual([['balance_unreadable', 'info']]);
      expect(JSON.stringify(notes)).not.toContain('sk-secret-value');
    }
    expect(await prisma.providerBalance.count()).toBe(0);
    const o = await registerOwner(app, { plan: 'growth' });
    await topUp(o.userId, 10_000);
    const r = await runReconciliation({ fetchImpl: answer({}, false) as never });
    expect(codes(r)).toEqual(['provider_balance_missing']); // a nag to type it in, not a claim of a shortfall
    expect(r.shortfallXAF).toBeNull();
  });

  it('says so for a provider that is named but cannot be read, or whose credentials are not set; the providers that need a login or a private key are not offered', async () => {
    env.BALANCE_SOURCES = 'notchpay, campay, nonsense';
    env.CAMPAY_API_KEY = undefined as never;
    const f = answer({});
    const notes = await fetchProviderBalances(new Date(), f as never);
    expect(notes.map((x) => x.code).sort()).toEqual(['balance_source_unconfigured', 'balance_source_unknown', 'balance_source_unknown']);
    expect(f).not.toHaveBeenCalled();
    expect(Object.keys(BALANCE_FETCHERS).sort()).toEqual(['campay', 'flutterwave']);
  });

  it('a provider balance read by the API counts like a typed one', async () => {
    env.BALANCE_SOURCES = 'flutterwave';
    env.FLUTTERWAVE_SECRET_KEY = 'sk-test';
    const o = await registerOwner(app, { plan: 'growth' });
    await topUp(o.userId, 10_000);
    const r = await runReconciliation({ fetchImpl: answer({ status: 'success', data: [{ currency: 'XAF', available_balance: 10_000, ledger_balance: 10_000 }] }) as never });
    expect(r).toMatchObject({ ok: true, obligationsXAF: 10_000, assetsXAF: 10_000 });
    expect(r.providers[0]).toMatchObject({ source: 'api', fresh: true });
  });
});

describe('typing a balance in', () => {
  it('refuses what is not an amount, and keeps provider names in one spelling', async () => {
    await expect(recordBalance({ provider: 'x', currency: 'XAF', available: -1, source: 'manual' })).rejects.toThrow(/zero or more/);
    await expect(recordBalance({ provider: 'x', currency: 'XAF', available: Number.NaN, source: 'manual' })).rejects.toThrow();
    const row = await recordBalance({ provider: 'FlutterWave', currency: 'xaf', available: 5, source: 'manual', note: 'dashboard' });
    expect(row).toMatchObject({ provider: 'flutterwave', currency: 'XAF', note: 'dashboard' });
  });
});
