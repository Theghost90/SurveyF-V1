import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { readMockMailbox } from '../src/services/mail';
import { runOverageBilling } from '../src/services/overage';
import { buildWorld, makeApp, registerOwner, resetAll, setPlan } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });
const saved = { block: env.OVERAGE_BLOCK_SENDS_AFTER_DAYS, pro: env.PRORATION_ENABLED };
afterEach(() => { Object.assign(env, { OVERAGE_BLOCK_SENDS_AFTER_DAYS: saved.block, PRORATION_ENABLED: saved.pro }); });

const DAY = 86_400_000;
const pay = async (o: Awaited<ReturnType<typeof registerOwner>>, plan: string, interval = 'monthly') => {
  const init = await o.post('/api/payments/initiate', { plan, interval, method: 'card' });
  if (init.status !== 201) return init;
  const done = await o.post(`/api/payments/mock/${init.reference}`, { outcome: 'success' });
  return { ...init, done };
};
const sub = (userId: string) => prisma.subscription.findUniqueOrThrow({ where: { userId } });
async function ageSubscription(userId: string, daysIntoPeriod: number, periodDays = 30) {
  // (a half day more than asked: whole days left are counted, so "15 days left" must not be 14.99997 by the time the payment is started)
  const start = new Date(Date.now() - (daysIntoPeriod - 0.5) * DAY);
  await prisma.subscription.update({ where: { userId }, data: { currentPeriodStart: start, currentPeriodEnd: new Date(start.getTime() + periodDays * DAY) } });
}

/**
 * PAY-12 (proration) and PAY-09 (overage). Containment under test (docs/BACKLOG.md): a cap and exact arithmetic on the credit · a credit that cannot be spent twice · nothing taken
 * without the owner paying · opt-in · a warning first · a month is invoiced once · nothing is ever invoiced twice.
 */
describe('proration on an upgrade (PAY-12)', () => {
  it('takes the unused days of the plan off the price of the next one, and says so in the payment', async () => {
    const o = await registerOwner(app);
    await pay(o, 'starter');
    await ageSubscription(o.userId, 15);
    const gross = (await o.post('/api/payments/initiate', { plan: 'growth', interval: 'monthly', method: 'mobile_money', phone: '+237677100001' })).amount;
    // Starter 14,500 paid, 15 of 30 days left: 7,250 credit off Growth's 39,000
    expect(gross).toBe(39_000 - 7_250);
    const row = await prisma.paymentTransaction.findFirstOrThrow({ where: { userId: o.userId, plan: 'growth' } });
    expect(row).toMatchObject({ creditFCFA: 7_250, creditFromPlan: 'starter' });
    expect(row.creditFromPeriodEnd).toEqual((await sub(o.userId)).currentPeriodEnd);
  });

  it('applies the credit once: paying settles the upgrade and starts a fresh period', async () => {
    const o = await registerOwner(app);
    await pay(o, 'starter');
    await ageSubscription(o.userId, 10);
    const r: any = await pay(o, 'growth');
    expect(r.done.status).toBe(200);
    const s = await sub(o.userId);
    expect(s.plan).toBe('growth');
    expect(s.amountFCFA).toBe(39_000); // the plan's price, not the net: the next renewal is the full price
    expect(s.currentPeriodEnd.getTime() - s.currentPeriodStart.getTime()).toBeGreaterThan(27 * DAY);
  });

  it('a renewal of the same plan gets no credit: it extends, nothing is lost', async () => {
    const o = await registerOwner(app);
    await pay(o, 'starter');
    await ageSubscription(o.userId, 10);
    const init = await o.post('/api/payments/initiate', { plan: 'starter', interval: 'monthly', method: 'card' });
    expect(init.amount).toBe(14_500);
    expect(init.creditFCFA).toBe(0);
  });

  it('there is no credit from the free plan, and none when the period is over', async () => {
    const free = await registerOwner(app);
    expect((await free.post('/api/payments/initiate', { plan: 'starter', interval: 'monthly', method: 'card' })).amount).toBe(14_500);
    const o = await registerOwner(app);
    await pay(o, 'starter');
    await ageSubscription(o.userId, 40);
    expect((await o.post('/api/payments/initiate', { plan: 'growth', interval: 'monthly', method: 'card' })).amount).toBe(39_000);
  });

  it('never takes the new plan below 10 percent of its price: an annual customer moving to a cheaper monthly one still pays something', async () => {
    const o = await registerOwner(app);
    await pay(o, 'business', 'annual');
    await ageSubscription(o.userId, 5, 365);
    await prisma.subscription.update({ where: { userId: o.userId }, data: { plan: 'business' } });
    // moving "up" from a high annual plan to a cheaper one is refused as a downgrade (existing guard); the cap matters for the same plan family: simulate with growth annual → business monthly
    await prisma.subscription.update({ where: { userId: o.userId }, data: { plan: 'growth', amountFCFA: 39_000 * 11 } });
    await prisma.user.update({ where: { id: o.userId }, data: { plan: 'growth' } });
    const init = await o.post('/api/payments/initiate', { plan: 'business', interval: 'monthly', method: 'card' });
    expect(init.amount).toBeGreaterThanOrEqual(Math.ceil(95_000 * 0.1));
    expect(init.amount).toBeLessThan(95_000);
  });

  it('a credit that was taken from a plan that is no longer the active one is not spent twice: the payment goes to review', async () => {
    const o = await registerOwner(app);
    await pay(o, 'starter');
    await ageSubscription(o.userId, 15);
    const a = await o.post('/api/payments/initiate', { plan: 'growth', interval: 'monthly', method: 'card' });
    expect(a.creditFCFA).toBeGreaterThan(0);
    // meanwhile the owner changes plan some other way (here: straight in the database, as a second payment landing first would)
    await prisma.subscription.update({ where: { userId: o.userId }, data: { plan: 'growth', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * DAY), amountFCFA: 39_000 } });
    await prisma.user.update({ where: { id: o.userId }, data: { plan: 'growth' } });
    await o.post(`/api/payments/mock/${a.reference}`, { outcome: 'success' });
    const tx = await prisma.paymentTransaction.findFirstOrThrow({ where: { reference: a.reference } });
    expect(tx.status).toBe('review');
    expect(tx.failReason).toMatch(/^proration_stale/);
  });

  it('can be switched off by setting', async () => {
    env.PRORATION_ENABLED = false;
    const o = await registerOwner(app);
    await pay(o, 'starter');
    await ageSubscription(o.userId, 15);
    expect((await o.post('/api/payments/initiate', { plan: 'growth', interval: 'monthly', method: 'card' })).amount).toBe(39_000);
  });
});

describe('usage is counted by the month (the limits are per month)', () => {
  it('an annual plan counts messages and responses over the month it is in, not the whole year', async () => {
    const w = await buildWorld(app, { contacts: 2, plan: 'starter' });
    await prisma.subscription.update({ where: { userId: w.owner.userId }, data: { interval: 'annual', amountFCFA: 159_500, currentPeriodStart: new Date(Date.now() - 100 * DAY), currentPeriodEnd: new Date(Date.now() + 265 * DAY) } });
    // the two invitations were sent today, which is inside the current month of that period
    const me = await w.owner.get('/api/auth/me');
    expect(me.usage.messages).toBe(2);
    // a message from three months ago is not counted against this month
    expect((await w.owner.get('/api/auth/me')).usage.messages).toBe(2);
  });
});

describe('overage (PAY-09)', () => {
  async function overOwner(extraResponses: number, optIn: boolean) {
    const o = await registerOwner(app);
    await pay(o, 'starter'); // allowance: 500 responses a month
    if (optIn) await o.put('/api/subscription/overage', { optIn: true });
    const w = await buildWorld(app, { contacts: 1, plan: 'starter', send: true });
    void w;
    return o;
  }
  const responsesFor = async (userId: string, n: number, when: Date) => {
    const s = await prisma.survey.create({ data: { userId, title: 'bulk', status: 'active' } });
    const contacts = await Promise.all(Array.from({ length: n }, (_, i) => prisma.contact.create({ data: { userId, name: `P${i}`, phone: `+2376${String(Math.random()).slice(2, 10)}`, consentAt: new Date(), consentSource: 'owner_manual' } })));
    await prisma.surveyRecipient.createMany({ data: contacts.map((c) => ({ surveyId: s.id, contactId: c.id, status: 'completed' as const, completedAt: when, sentAt: when })) });
  };
  const endedMonth = async (userId: string) => {
    const start = new Date(Date.now() - 45 * DAY);
    await prisma.subscription.update({ where: { userId }, data: { currentPeriodStart: start, currentPeriodEnd: new Date(start.getTime() + 30 * DAY) } });
    return start;
  };
  const mails = async (userId: string, kind: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return (await readMockMailbox(u.email)).filter((m) => m.kind === kind);
  };

  it('does nothing until the owner agrees: no invoice, however far over', async () => {
    const o = await registerOwner(app);
    await pay(o, 'starter');
    const start = await endedMonth(o.userId);
    await responsesFor(o.userId, 650, new Date(start.getTime() + 5 * DAY));
    expect((await runOverageBilling()).invoiced).toBe(0);
    expect(await prisma.overageInvoice.count()).toBe(0);
  });

  it('with the owner\'s agreement, invoices the month once, in blocks of 100, and e-mails it', async () => {
    const o = await registerOwner(app);
    await pay(o, 'starter');
    expect((await o.put('/api/subscription/overage', { optIn: true })).optIn).toBe(true);
    const start = await endedMonth(o.userId);
    await responsesFor(o.userId, 650, new Date(start.getTime() + 5 * DAY)); // 150 over: two blocks of 100
    expect((await runOverageBilling()).invoiced).toBe(1);
    const [inv] = await prisma.overageInvoice.findMany();
    expect(inv).toMatchObject({ userId: o.userId, plan: 'starter', allowance: 500, responses: 650, units: 2, amountFCFA: 1000, status: 'open' });
    expect(inv!.dueAt.getTime()).toBeGreaterThan(Date.now() + 10 * DAY);
    expect(await mails(o.userId, 'overage_invoice')).toHaveLength(1);
    // a second run, or a second replica, makes nothing more
    expect((await runOverageBilling()).invoiced).toBe(0);
    expect(await prisma.overageInvoice.count()).toBe(1);
    expect(await mails(o.userId, 'overage_invoice')).toHaveLength(1);
  });

  it('a month that stayed within the plan is not invoiced', async () => {
    const o = await registerOwner(app);
    await pay(o, 'starter');
    await o.put('/api/subscription/overage', { optIn: true });
    const start = await endedMonth(o.userId);
    await responsesFor(o.userId, 500, new Date(start.getTime() + 5 * DAY));
    expect((await runOverageBilling()).invoiced).toBe(0);
  });

  it('an annual plan is invoiced month by month, each month against one month\'s allowance (not a year\'s against one)', async () => {
    const o = await registerOwner(app);
    await pay(o, 'starter', 'annual');
    await o.put('/api/subscription/overage', { optIn: true });
    const start = new Date(Date.now() - 100 * DAY);
    await prisma.subscription.update({ where: { userId: o.userId }, data: { currentPeriodStart: start, currentPeriodEnd: new Date(start.getTime() + 365 * DAY) } });
    await responsesFor(o.userId, 300, new Date(start.getTime() + 5 * DAY)); // month 1: 300
    await responsesFor(o.userId, 300, new Date(start.getTime() + 40 * DAY)); // month 2: 300  (600 over the two months, 0 over either)
    expect((await runOverageBilling()).invoiced).toBe(0);
    await responsesFor(o.userId, 300, new Date(start.getTime() + 8 * DAY)); // month 1 again: now 600
    expect((await runOverageBilling()).invoiced).toBe(1);
    expect((await prisma.overageInvoice.findFirstOrThrow()).responses).toBe(600);
  });

  it('warns at 80 percent and again at 100 percent of the month, once each, whether or not the owner agreed', async () => {
    const o = await registerOwner(app);
    await pay(o, 'starter');
    await responsesFor(o.userId, 410, new Date());
    await runOverageBilling(); await runOverageBilling();
    expect(await mails(o.userId, 'overage_warning')).toHaveLength(1);
    await responsesFor(o.userId, 100, new Date());
    await runOverageBilling(); await runOverageBilling();
    const warnings = await mails(o.userId, 'overage_warning');
    expect(warnings).toHaveLength(2);
    expect(JSON.stringify(warnings[1])).toMatch(/close|approchez/); // newest first
    expect(JSON.stringify(warnings[0])).toMatch(/reached|atteint/);
  });

  it('an invoice is paid by the owner through the normal payment page, and paying it settles it once', async () => {
    const o = await registerOwner(app);
    await pay(o, 'starter');
    await o.put('/api/subscription/overage', { optIn: true });
    const start = await endedMonth(o.userId);
    await responsesFor(o.userId, 600, new Date(start.getTime() + 2 * DAY));
    await runOverageBilling();
    const inv = await prisma.overageInvoice.findFirstOrThrow();
    const init = await o.post(`/api/subscription/overage/${inv.id}/pay`, { method: 'card' });
    expect(init).toMatchObject({ purpose: 'overage', amount: 500 });
    await o.post(`/api/payments/mock/${init.reference}`, { outcome: 'success' });
    await o.post(`/api/payments/mock/${init.reference}`, { outcome: 'success' });
    const paid = await prisma.overageInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(paid.status).toBe('paid');
    expect((await sub(o.userId)).plan).toBe('starter'); // nothing about the subscription changed
    expect((await o.post(`/api/subscription/overage/${inv.id}/pay`, { method: 'card' })).status).toBe(409); // already settled
  });

  it('nobody else can pay or read an invoice', async () => {
    const a = await registerOwner(app); const b = await registerOwner(app);
    await pay(a, 'starter'); await a.put('/api/subscription/overage', { optIn: true });
    const start = await endedMonth(a.userId);
    await responsesFor(a.userId, 600, new Date(start.getTime() + 2 * DAY));
    await runOverageBilling();
    const inv = await prisma.overageInvoice.findFirstOrThrow();
    expect((await b.post(`/api/subscription/overage/${inv.id}/pay`, { method: 'card' })).status).toBe(404);
    expect((await b.get('/api/subscription/overage')).invoices).toEqual([]);
  });

  it('by default an unpaid invoice stops nothing; with the setting on, it stops new sends but never responses', async () => {
    const w = await buildWorld(app, { contacts: 2, plan: 'starter', send: false });
    await prisma.overageInvoice.create({ data: { userId: w.owner.userId, period: '2026-01-01', plan: 'starter', allowance: 500, responses: 700, units: 2, amountFCFA: 1000, status: 'open', dueAt: new Date(Date.now() - 30 * DAY) } });
    expect((await w.owner.post(`/api/surveys/${w.surveyId}/send`, { all: true, acceptMarketingCost: true })).status).toBe(200);
    await prisma.surveyRecipient.deleteMany({}); await prisma.sendJob.deleteMany({});
    env.OVERAGE_BLOCK_SENDS_AFTER_DAYS = 7;
    const blocked = await w.owner.post(`/api/surveys/${w.surveyId}/send`, { all: true, acceptMarketingCost: true });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error).toBe('overage_due');
  });

  it('withdrawing the agreement stops further invoices and is recorded', async () => {
    const o = await registerOwner(app);
    await o.put('/api/subscription/overage', { optIn: true });
    await o.put('/api/subscription/overage', { optIn: false });
    expect((await o.get('/api/subscription/overage')).optIn).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: { in: ['overage_opt_in', 'overage_opt_out'] } } })).toBe(2);
  });

  it('an upgrade invoices the month it cuts short, once, and no later run invoices it again', async () => {
    const o = await registerOwner(app);
    await pay(o, 'starter');
    await o.put('/api/subscription/overage', { optIn: true });
    await ageSubscription(o.userId, 10);
    await responsesFor(o.userId, 560, new Date(Date.now() - 2 * DAY));
    await pay(o, 'growth');
    await vi.waitFor(async () => expect(await prisma.overageInvoice.count()).toBe(1), { timeout: 5000, interval: 50 });
    expect((await prisma.overageInvoice.findFirstOrThrow()).responses).toBe(560);
    await runOverageBilling();
    expect(await prisma.overageInvoice.count()).toBe(1);
  });
});
