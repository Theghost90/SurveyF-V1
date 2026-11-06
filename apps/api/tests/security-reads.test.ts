import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { readMockMailbox } from '../src/services/mail';
import { TEST_PASSWORD, buildWorld, makeApp, registerOwner, resetAll, say, templateBtn, type Client } from './helpers';

/**
 * SEC-20: names and free-text answers are not masked, so how many DIFFERENT participants one login looks at in 24 hours is counted. Past a soft number a recent
 * "confirm it is you" is needed and the owner is e-mailed once; past a hard number the lists stop. Looking at the same people again is free.
 */
let app: FastifyInstance;
const saved = { soft: env.READ_SOFT_PEOPLE, hard: env.READ_HARD_PEOPLE };
beforeAll(async () => { app = await makeApp(); });
beforeEach(async () => { await resetAll(); env.READ_SOFT_PEOPLE = 30; env.READ_HARD_PEOPLE = 60; });
afterEach(() => { Object.assign(env, { READ_SOFT_PEOPLE: saved.soft, READ_HARD_PEOPLE: saved.hard }); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });

const call = (method: 'GET' | 'POST', url: string, owner: Client, body?: unknown) =>
  app.inject({ method, url, headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` }, payload: body === undefined ? undefined : JSON.stringify(body) });
const json = (r: { body: string }) => JSON.parse(r.body);
const mailsOf = async (userId: string, kind: string) => (await readMockMailbox((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email)).filter((m) => m.kind === kind);
const auditRows = (action: string, userId: string) => prisma.auditLog.findMany({ where: { action, userId } });
const confirmIdentity = (o: Client) => call('POST', '/api/auth/step-up', o, { method: 'password', secret: TEST_PASSWORD });
const page = (o: Client, n: number, size = 25) => call('GET', `/api/contacts?page=${n}&pageSize=${size}`, o);

describe('how many different participants one login can list in a day (SEC-20)', () => {
  it('looking at the same people again and again costs nothing', async () => {
    const w = await buildWorld(app, { contacts: 40, send: false });
    for (let i = 0; i < 6; i++) expect((await page(w.owner, 1)).statusCode).toBe(200); // 6 × 25 rows, but only 25 different people (limit 30)
  });

  it('past the soft number a recent confirmation is needed, and the owner is told once, with a count and no name', async () => {
    const w = await buildWorld(app, { contacts: 40, send: false });
    expect((await page(w.owner, 1)).statusCode).toBe(200); // 25 people
    const blocked = await page(w.owner, 2); // 15 more: 40 > 30
    expect(blocked.statusCode).toBe(403);
    expect(json(blocked)).toMatchObject({ error: 'step_up_required' });
    expect(await mailsOf(w.owner.userId, 'bulk_read_alert')).toHaveLength(1);
    const mail = (await mailsOf(w.owner.userId, 'bulk_read_alert'))[0]!;
    expect(mail.text).toMatch(/30/);
    expect(mail.text).not.toMatch(/Contact \d/);
    expect(await auditRows('bulk_read', w.owner.userId)).toHaveLength(1);

    expect((await confirmIdentity(w.owner)).statusCode).toBe(200);
    expect((await page(w.owner, 2)).statusCode).toBe(200);
    expect((await page(w.owner, 1)).statusCode).toBe(200);
    expect(await mailsOf(w.owner.userId, 'bulk_read_alert')).toHaveLength(1); // once per window, not once per request
    expect(await auditRows('bulk_read', w.owner.userId)).toHaveLength(1);
  });

  it('the not-started list counts towards the same total as the contacts list', async () => {
    const w = await buildWorld(app, { contacts: 40, plan: 'growth', send: false });
    // all 40 were invited and none replied (written directly: the send worker's batching is not what is under test)
    await prisma.surveyRecipient.createMany({ data: w.contactIds.map((contactId) => ({ surveyId: w.surveyId, contactId, status: 'sent' as const, sentAt: new Date() })) });
    expect((await page(w.owner, 1)).statusCode).toBe(200); // 25 people
    const all = await call('GET', `/api/surveys/${w.surveyId}/not-started?page=1&pageSize=100`, w.owner); // all 40, 25 of them already counted: 40 > 30
    expect(all.statusCode).toBe(403);
    expect(json(all).error).toBe('step_up_required');
  });

  it('the responses list (names and free-text answers) is behind the same gate', async () => {
    const w = await buildWorld(app, { contacts: 35, plan: 'growth' });
    for (let i = 0; i < 35; i++) await say(app, w, i, (f) => templateBtn(f, `START:${w.surveyId}`)); // 35 people have started
    const first = await call('GET', `/api/surveys/${w.surveyId}/responses?page=1&pageSize=100`, w.owner); // 35 > 30
    expect(first.statusCode).toBe(403);
    expect(json(first).error).toBe('step_up_required');
    await confirmIdentity(w.owner);
    const again = await call('GET', `/api/surveys/${w.surveyId}/responses?page=1&pageSize=100`, w.owner);
    expect(again.statusCode).toBe(200);
    expect(json(again).items).toHaveLength(35);
  });

  it('past the hard number the lists stop, even for somebody who has confirmed, and the trail says so once', async () => {
    const w = await buildWorld(app, { contacts: 70, send: false });
    await confirmIdentity(w.owner);
    expect((await page(w.owner, 1)).statusCode).toBe(200); // 25
    expect((await page(w.owner, 2)).statusCode).toBe(200); // 50
    const stopped = await page(w.owner, 3); // 70 > 60
    expect(stopped.statusCode).toBe(429);
    expect(json(stopped).error).toBe('read_cap');
    expect((await page(w.owner, 1)).statusCode).toBe(429); // the whole list is closed until the window has passed
    expect(await auditRows('bulk_read_blocked', w.owner.userId)).toHaveLength(1);
  });

  it('the count is per owner and the window ends by itself (24 hours)', async () => {
    const a = await buildWorld(app, { contacts: 40, send: false });
    const b = await registerOwner(app, { email: 'other@example.com' });
    await call('POST', '/api/contacts', b, { name: 'Mine', phone: '+237677000500', consent: true });
    await page(a.owner, 1);
    await page(a.owner, 2); // blocked for a
    expect((await call('GET', '/api/contacts', b)).statusCode).toBe(200); // b has their own count
    const key = `sf:c:read:people:${a.owner.userId}`;
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
    await redis.del(key); // what 24 hours do
    await confirmIdentity(a.owner);
    expect((await page(a.owner, 1)).statusCode).toBe(200);
  });

  it('a search lists people too: it counts the people it returns, not the ones it looked through', async () => {
    const w = await buildWorld(app, { contacts: 40, send: false });
    const r = await call('GET', '/api/contacts?search=Contact%201&pageSize=25', w.owner); // "Contact 1", "Contact 10".."Contact 19"
    expect(r.statusCode).toBe(200);
    expect(json(r).items.length).toBe(11);
    const key = `sf:c:read:people:${w.owner.userId}`;
    expect(await redis.pfcount(key)).toBe(11);
  });
});
