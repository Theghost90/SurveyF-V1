import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { runBillingLifecycle } from '../src/services/subscription/lifecycle';
import { runSendWorkerOnce } from '../src/services/whatsapp/sender';
import { buildWorld, connectMockWhatsApp, makeApp, registerOwner, resetAll, sampleQuestions, setPlan } from './helpers';

/**
 * Explore / Activate: free with no clock, capped by usage (1 live survey, 5 different people for the life of the account), and a plan to
 * reach everyone else. Plus: nothing that touches the WhatsApp number works before the number is connected.
 */

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });

const contacts = async (o: Awaited<ReturnType<typeof registerOwner>>, n: number, from = 0) => {
  const ids: string[] = [];
  for (let i = from; i < from + n; i++) ids.push((await o.post('/api/contacts', { name: `P${i}`, phone: `+2376771000${String(i).padStart(2, '0')}`, consent: true })).id);
  return ids;
};
const publishedSurvey = async (o: Awaited<ReturnType<typeof registerOwner>>, title = 'S') => {
  const s = await o.post('/api/surveys', { title, language: 'en', questions: sampleQuestions() });
  await o.post(`/api/surveys/${s.id}/publish`);
  return s.id as string;
};

describe('Explore: usage cap, no clock', () => {
  it('reaches 5 people for free, the 6th is the wall (402 with the plan to activate), and nobody is sent anything by the refused call', async () => {
    const o = await registerOwner(app);
    const ids = await contacts(o, 8);
    const sid = await publishedSurvey(o);
    const aud = await o.post(`/api/surveys/${sid}/audience`, { all: true });
    expect(aud).toMatchObject({ eligible: 8, recipientsRemaining: 5, newPeople: 8 });

    const refused = await o.post(`/api/surveys/${sid}/send`, { all: true });
    expect(refused.status).toBe(402);
    expect(refused).toMatchObject({ error: 'plan_limit', details: { limit: 'recipients', max: 5, remaining: 5, requested: 8, upgrade: { recommendedPlan: 'starter' } } });
    expect(await prisma.surveyRecipient.count()).toBe(0);

    expect((await o.post(`/api/surveys/${sid}/send`, { contactIds: ids.slice(0, 5) })).status).toBe(200);
    const again = await o.post(`/api/surveys/${sid}/send`, { contactIds: [ids[5]!] });
    expect(again.status).toBe(402);
    expect(again.details).toMatchObject({ limit: 'recipients', remaining: 0 });
    expect((await o.get('/api/auth/me')).usage.recipients).toBe(5);
  });

  it('people already invited cost nothing new: a second survey to the same 5 is free', async () => {
    const o = await registerOwner(app);
    const ids = await contacts(o, 5);
    const a = await publishedSurvey(o, 'A');
    expect((await o.post(`/api/surveys/${a}/send`, { all: true })).status).toBe(200);
    await o.post(`/api/surveys/${a}/close`);
    const b = await publishedSurvey(o, 'B');
    const aud = await o.post(`/api/surveys/${b}/audience`, { all: true });
    expect(aud).toMatchObject({ recipientsRemaining: 0, newPeople: 0 });
    expect((await o.post(`/api/surveys/${b}/send`, { contactIds: ids })).status).toBe(200);
  });

  it('a paid plan has no such cap', async () => {
    const w = await buildWorld(app, { contacts: 8, plan: 'starter', send: false });
    expect((await w.owner.post(`/api/surveys/${w.surveyId}/send`, { all: true })).status).toBe(200);
    expect((await w.owner.get('/api/auth/me')).plan.limits.recipients).toBeNull();
  });

  it('nothing expires and a plan that lapses lands on Explore with the cap already used: no way back to a free Starter', async () => {
    const w = await buildWorld(app, { contacts: 8, plan: 'growth', send: false });
    expect((await w.owner.post(`/api/surveys/${w.surveyId}/send`, { all: true })).status).toBe(200);
    await runSendWorkerOnce(100);
    await prisma.subscription.update({ where: { userId: w.owner.userId }, data: { cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() - 1000) } });
    await runBillingLifecycle();
    const me = await w.owner.get('/api/auth/me');
    expect(me.plan.key).toBe('trial');
    expect(me.usage.recipients).toBe(8); // 8 people were reached while paid: Explore's 5 are long gone
    const extra = (await contacts(w.owner, 1, 20))[0]!;
    await w.owner.post(`/api/surveys/${w.surveyId}/close`); // Explore has one live survey
    const s2 = await publishedSurvey(w.owner, 'After');
    const r = await w.owner.post(`/api/surveys/${s2}/send`, { contactIds: [extra] });
    expect(r.status).toBe(402);
    expect(r.details).toMatchObject({ limit: 'recipients', remaining: 0 });
    expect(me.usage.responseOverageFCFA).toBe(0); // nothing is billed to someone on Explore
  });

  it('only paid plans can ask for the Analytics Bot (a feature flag the bot checks)', async () => {
    const o = await registerOwner(app);
    expect((await o.get('/api/auth/me')).plan.features.analyticsBot).toBe(false);
    for (const p of ['starter', 'growth', 'business'] as const) {
      await setPlan(o.userId, p);
      expect((await o.get('/api/auth/me')).plan.features.analyticsBot).toBe(true);
    }
  });
});

describe('connect WhatsApp first', () => {
  it('without a connected number: no surveys, no contacts, no import, no publish, no send, no top-up (409 whatsapp_not_connected)', async () => {
    const o = await registerOwner(app, { plan: 'growth', whatsapp: false });
    const expectBlocked = async (r: { status: number; error?: string }) => { expect(r.status).toBe(409); expect(r.error).toBe('whatsapp_not_connected'); };
    await expectBlocked(await o.post('/api/surveys', { title: 'T', questions: sampleQuestions() }));
    await expectBlocked(await o.post('/api/contacts', { name: 'A', phone: '+237677100001', consent: true }));
    await expectBlocked(await o.post('/api/wallet/topup', { amount: 5000, method: 'card' }));
    await expectBlocked(await o.post('/api/surveys/anything/publish'));
    await expectBlocked(await o.post('/api/surveys/anything/send', { all: true }));
    await expectBlocked(await o.post('/api/surveys/anything/duplicate'));
    await expectBlocked(await o.post('/api/surveys/anything/remind', { target: 'no_reply' }));
    expect(await prisma.survey.count()).toBe(0);
    expect(await prisma.contact.count()).toBe(0);

    await connectMockWhatsApp(o.userId);
    expect((await o.post('/api/contacts', { name: 'A', phone: '+237677100001', consent: true })).status).toBe(201);
    expect((await o.post('/api/surveys', { title: 'T', questions: sampleQuestions() })).status).toBe(201);
  });

  it('an import is refused before it reads the file; viewing, deleting and exporting still work without a number', async () => {
    const o = await registerOwner(app, { whatsapp: false });
    const r = await app.inject({ method: 'POST', url: '/api/contacts/import', headers: { authorization: `Bearer ${o.token}`, 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--' });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).error).toBe('whatsapp_not_connected');
    expect((await o.get('/api/contacts')).status).toBe(200);
    expect((await o.get('/api/surveys')).status).toBe(200);
  });

  it('setup is "done" only with a segment AND a connected number', async () => {
    const o = await registerOwner(app, { whatsapp: false });
    expect((await o.raw('PATCH', '/api/auth/me', { onboardingDone: true, segment: 'business' })).status).toBe(409);
    await connectMockWhatsApp(o.userId);
    expect((await o.raw('PATCH', '/api/auth/me', { onboardingDone: true, segment: 'business' })).status).toBe(200);
    expect((await o.get('/api/auth/me')).onboarding).toMatchObject({ whatsappConnected: true, done: true });
  });
});

describe('funnel milestones: the first time each happens, once', () => {
  const names = async (userId: string) => (await prisma.funnelEvent.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })).map((e) => e.name);

  it('signup → whatsapp_connected → survey_created → first_send → paywall_view, each recorded once', async () => {
    const o = await registerOwner(app, { whatsapp: false });
    expect(await names(o.userId)).toEqual(['signup']);
    expect((await o.post('/api/whatsapp/accounts/mock')).status).toBe(201);
    await contacts(o, 8);
    const sid = await publishedSurvey(o);
    await o.post('/api/surveys', { title: 'Second', questions: sampleQuestions() });
    await o.post(`/api/surveys/${sid}/send`, { contactIds: (await prisma.contact.findMany({ take: 2 })).map((c) => c.id) });
    await o.post(`/api/surveys/${sid}/send`, { contactIds: (await prisma.contact.findMany({ skip: 2, take: 2 })).map((c) => c.id) });
    await o.post(`/api/surveys/${sid}/send`, { all: true }); // 4 left to reach but only 1 slot: the wall
    expect(await names(o.userId)).toEqual(['signup', 'whatsapp_connected', 'survey_created', 'first_send', 'paywall_view']);
  });

  it('checkout_start and paid are recorded when a plan is bought', async () => {
    const o = await registerOwner(app);
    const init = await o.post('/api/payments/initiate', { plan: 'starter', interval: 'monthly', method: 'card' });
    await o.post(`/api/payments/mock/${init.reference}`, { outcome: 'success' });
    expect(await names(o.userId)).toContain('checkout_start');
    // `paid` is recorded off the settlement's critical path (a failed analytics write must never fail a payment), so it may land a moment after the response.
    await vi.waitFor(async () => expect(await names(o.userId)).toContain('paid'), { timeout: 5000, interval: 50 });
  });
});
