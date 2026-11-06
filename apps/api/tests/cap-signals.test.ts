import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { capReport, MIN_GROUP } from '../src/services/cap-report';
import { buildWorld, makeApp, registerOwner, resetAll, sampleQuestions } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });

/**
 * BIZ-03: the free plan's cap on different people reached is judged on facts. Containment under test (docs/BACKLOG.md): evidence without the platform dashboard (ADM-03):
 * counts only, one signal per owner per hour, an owner's own number never in it, and small groups never reported as numbers.
 */
const signals = () => prisma.capSignal.findMany({ orderBy: { at: 'asc' } });

async function blockedOwner() {
  const o = await registerOwner(app);
  for (let i = 0; i < 8; i++) await o.post('/api/contacts', { name: `P${i}`, phone: `+2376771000${String(i).padStart(2, '0')}`, tags: [], consent: true });
  const s = await o.post('/api/surveys', { title: 'T', language: 'en', questions: sampleQuestions(), gift: {} });
  await o.post(`/api/surveys/${s.id}/publish`);
  const res = await o.post(`/api/surveys/${s.id}/send`, { all: true, acceptMarketingCost: true });
  return { o, res };
}

describe('what is recorded', () => {
  it('an owner stopped by the cap leaves one signal with counts, and pressing the button again does not add more', async () => {
    const { o, res } = await blockedOwner();
    expect(res.status).toBe(402);
    await o.post(`/api/surveys/${(await prisma.survey.findFirstOrThrow()).id}/send`, { all: true, acceptMarketingCost: true });
    const rows = await signals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'send_blocked', cap: 5, reached: 0, wanted: 8, plan: 'trial' });
  });

  it('records the first payment with how many different people had been reached, once', async () => {
    const w = await buildWorld(app, { contacts: 3, plan: 'trial' });
    const init = await w.owner.post('/api/payments/initiate', { plan: 'starter', interval: 'monthly', method: 'card' });
    await w.owner.post(`/api/payments/mock/${init.reference}`, { outcome: 'success' });
    await vi.waitFor(async () => expect((await signals()).filter((s) => s.kind === 'activated')).toHaveLength(1), { timeout: 5000, interval: 50 });
    expect((await signals()).find((s) => s.kind === 'activated')).toMatchObject({ reached: 3, plan: 'starter', cap: null });
    const again = await w.owner.post('/api/payments/initiate', { plan: 'growth', interval: 'monthly', method: 'card' });
    await w.owner.post(`/api/payments/mock/${again.reference}`, { outcome: 'success' });
    await new Promise((r) => setTimeout(r, 300));
    expect((await signals()).filter((s) => s.kind === 'activated')).toHaveLength(1);
  });

  it('holds counts and a plan name and nothing that names a person', async () => {
    await blockedOwner();
    const text = JSON.stringify(await signals());
    expect(text).not.toMatch(/\+?237677\d{6}/);
    expect(Object.keys((await signals())[0]!).sort()).toEqual(['at', 'cap', 'id', 'kind', 'plan', 'reached', 'userId', 'wanted']);
  });

  it('goes with the account when it is erased', async () => {
    const { o } = await blockedOwner();
    expect(await prisma.capSignal.count()).toBe(1);
    await prisma.user.delete({ where: { id: o.userId } });
    expect(await prisma.capSignal.count()).toBe(0);
  });
});

describe('the report', () => {
  async function seed(n: number, build: (i: number, userId: string) => Array<{ kind: string; reached: number; daysAgo: number }>) {
    for (let i = 0; i < n; i++) {
      const o = await registerOwner(app, { email: `cap${i}@example.test` });
      for (const s of build(i, o.userId)) await prisma.capSignal.create({ data: { userId: o.userId, kind: s.kind, reached: s.reached, plan: 'trial', cap: s.kind === 'activated' ? null : 5, at: new Date(Date.now() - s.daysAgo * 86_400_000) } });
    }
  }

  it('says "fewer than 5" for any group that small, and never a number or a share', async () => {
    await seed(3, () => [{ kind: 'send_blocked', reached: 5, daysAgo: 20 }]);
    const r = await capReport();
    expect(r.blockedOwners).toBe(`fewer than ${MIN_GROUP}`);
    expect(r.exploreOwners).toBe(`fewer than ${MIN_GROUP}`);
    expect(r.paidAfterBlockedShare).toBeNull();
    expect(r.reachedAtActivation).toBe('fewer than 5 owners');
  });

  it('counts who paid soon after being stopped, who paid without being stopped, and who is stuck', async () => {
    await seed(12, (i) => {
      if (i < 5) return [{ kind: 'send_blocked', reached: 5, daysAgo: 10 }, { kind: 'activated', reached: 5 + i, daysAgo: 8 }]; // paid 2 days after the block
      if (i < 7) return [{ kind: 'activated', reached: 2, daysAgo: 3 }]; // paid, never blocked
      if (i < 12) return [{ kind: 'send_blocked', reached: 5, daysAgo: 30 }]; // blocked, never paid, long ago
      return [];
    });
    const r = await capReport();
    expect(r.blockedOwners).toBe(10);
    expect(r.paidAfterBlocked7d).toBe(5);
    expect(r.paidAfterBlockedShare).toBe(50);
    expect(r.paidWithoutBlock).toBe(`fewer than ${MIN_GROUP}`); // 2 owners
    expect(r.stuckAfterBlocked14d).toBe(5);
    expect(r.reachedAtActivation).toMatchObject({ median: 6, p25: 2, p75: 8 }); // 2, 2, 5, 6, 7, 8, 9
  });

  it('ignores signals older than the window', async () => {
    await seed(6, () => [{ kind: 'send_blocked', reached: 5, daysAgo: 200 }]);
    expect((await capReport(new Date(), 90)).blockedOwners).toBe(`fewer than ${MIN_GROUP}`);
  });
});
