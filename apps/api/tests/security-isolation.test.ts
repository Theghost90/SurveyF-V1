import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { TEST_PASSWORD, answerIdFor, buildWorld, loginRaw, registerOwner, replyMsg, resetAll, say, templateBtn, textMsg, type Client, type World } from './helpers';

/**
 * SEC-12: one owner must never reach another owner's data, through ANY route.
 *
 * The API has no database-level row security (every query carries the owner's id); the protection is that every route does, and this file is the proof and the
 * guard. It reads the list of routes the application REALLY registered, so a route added later is held to the same rules without anybody remembering to
 * write a test for it:
 *   - a route that is not on the short PUBLIC list must refuse a caller who is not signed in;
 *   - a route with an id in its path must answer 404 (not 403: it does not even confirm the thing exists) when somebody else's id is used, change nothing, and
 *     show nothing;
 *   - a route WITHOUT an id must not show the other owner's data in a list;
 *   - a route that takes ids in its body must ignore the ones that are not yours.
 * A route with a path parameter nobody has said how to test fails this file on purpose.
 */
const inventory: string[] = [];
let app: FastifyInstance;

const PUBLIC = new Set([
  'GET /healthz',
  'GET /api/auth/config', 'POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/refresh',
  'POST /api/auth/signout', 'POST /api/auth/verify-email', 'POST /api/auth/verify-email/resend', 'POST /api/auth/password/forgot', 'POST /api/auth/password/reset',
  'POST /api/auth/google', 'POST /api/auth/google/link/confirm',
  'GET /api/pricing', 'GET /api/plans',
  'GET /api/receipts/:token', // a signed link the participant opens
  'GET /api/webhook/whatsapp', 'POST /api/webhook/whatsapp', // Meta's signature
  'GET /api/payments/webhook/:psp', 'POST /api/payments/webhook/:psp', // the provider is asked what really happened
  'GET /api/dev/mailbox', // development and demo only: the mock mail provider's mailbox (never registered in production)
]);

/** The page of A's data that the markers below let a test recognise anywhere in a response. */
interface Victim { world: World; contactIds: string[]; surveyId: string; sessionId: string; paymentId: string; paymentRef: string; accountId: string; ownerPhoneId: string; email: string; markers: string[] }

const PARAM: Array<[RegExp, (v: Victim) => string]> = [
  [/^\/api\/surveys\/:id/, (v) => v.surveyId],
  [/^\/api\/contacts\/:id/, (v) => v.contactIds[0]!],
  [/^\/api\/auth\/sessions\/:id/, (v) => v.sessionId],
  [/^\/api\/payments\/mock\/:reference/, (v) => v.paymentRef],
  [/^\/api\/payments\/:id/, (v) => v.paymentId],
  [/^\/api\/whatsapp\/accounts\/:id/, (v) => v.accountId],
  [/^\/api\/analytics-bot\/phones\/:id/, (v) => v.ownerPhoneId],
  [/^\/api\/dev\/simulator\/:contactId/, (v) => v.contactIds[0]!],
];

/** A body that is valid for the route, so that the answer comes from the ownership check and not from validation. */
const BODY: Record<string, unknown> = {
  'PUT /api/surveys/:id': { title: 'hijacked', language: 'en', questions: [{ text: 'q', type: 'text', required: true }] },
  'POST /api/surveys/:id/send': { all: true },
  'POST /api/surveys/:id/audience': { all: true },
  'POST /api/surveys/:id/remind': { target: 'no_reply' },
  'POST /api/surveys/:id/sync/google-sheets': { autoSync: true },
  'PATCH /api/contacts/:id': { name: 'hijacked' },
  'PATCH /api/analytics-bot/phones/:id': { alerts: false },
  'POST /api/payments/mock/:reference': { outcome: 'success' },
  'POST /api/dev/simulator/:contactId/send': { type: 'text', text: 'hello' },
};

const keyOf = (method: string, url: string) => `${method} ${url}`;
const routes = () => [...new Set(inventory)].sort().map((k) => { const [method, url] = k.split(' ') as [string, string]; return { key: k, method, url }; });
const owned = () => routes().filter((r) => !PUBLIC.has(r.key));
const withParams = (url: string, v?: Victim) => {
  if (!url.includes(':')) return url;
  const found = v ? PARAM.find(([re]) => re.test(url)) : undefined;
  return url.replace(/:[A-Za-z]+/g, v && found ? found[1](v) : 'x');
};

let A: Victim;
let a: Client;
let b: Client;
let bWorld: World;

const call = (client: Client | null, method: string, url: string, body?: unknown) =>
  app.inject({ method: method as never, url, headers: { 'content-type': 'application/json', ...(client ? { authorization: `Bearer ${client.token}` } : {}) }, payload: body === undefined || method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  app = await buildApp({ onRoute: (r) => { for (const m of [r.method].flat()) if (m !== 'HEAD' && m !== 'OPTIONS') inventory.push(keyOf(m, r.url)); } });
  await app.ready();
  await resetAll();

  // Owner A: everything an owner can have, each piece carrying a marker no other owner's data contains.
  const w = await buildWorld(app, { contacts: 3, plan: 'business', wallet: 20_000 });
  a = w.owner;
  const aUser = await prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
  expect((await a.raw('PATCH', '/api/auth/me', { name: 'ZZ-MARKER-NAME', businessName: 'ZZ-MARKER-BIZ', phone: '677733100' })).status).toBe(200);
  for (const [i, id] of w.contactIds.entries()) expect((await a.raw('PATCH', `/api/contacts/${id}`, { name: `ZZ-MARKER-CONTACT-${i + 1}` })).status).toBe(200);
  const cur = await a.get(`/api/surveys/${w.surveyId}`);
  expect((await a.put(`/api/surveys/${w.surveyId}`, { title: 'ZZ-MARKER-SURVEY', language: 'en', questions: cur.questions.map((q: any) => ({ text: q.text, type: q.type, required: q.required, options: q.options })) })).status).toBe(200);
  // one participant completes it, so analytics, responses and the answers table hold something to leak
  await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`));
  await say(app, w, 0, (f) => replyMsg(f, answerIdFor(w.questions[0]!, 0), 'button_reply'));
  await say(app, w, 0, (f) => replyMsg(f, answerIdFor(w.questions[1]!, 1), 'list_reply'));
  await say(app, w, 0, (f) => textMsg(f, 'ZZ-MARKER-ANSWER'));
  const topup = await a.post('/api/wallet/topup', { amount: 10_000, method: 'mobile_money', phone: '+237677000001' });
  const second = await loginRaw(app, aUser.email, TEST_PASSWORD);
  const account = await prisma.whatsAppAccount.findFirstOrThrow({ where: { userId: a.userId } });
  const phone = await prisma.ownerPhone.create({ data: { userId: a.userId, phone: '237677733101' } });
  A = {
    world: w, contactIds: w.contactIds, surveyId: w.surveyId, sessionId: JSON.parse(second.body).sessionId, paymentId: topup.id, paymentRef: topup.reference, accountId: account.id, ownerPhoneId: phone.id, email: aUser.email,
    markers: ['ZZ-MARKER', aUser.email, w.surveyId, ...w.contactIds, account.id, topup.id, topup.reference, JSON.parse(second.body).sessionId, '237677733101', '677733100'],
  };

  // Owner B: a different owner with data of their own (so lists are not empty) on the same plan.
  bWorld = await buildWorld(app, { contacts: 2, plan: 'business', send: false });
  b = bWorld.owner;
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });

const mentions = (body: string, v: Victim) => v.markers.filter((m) => body.includes(m));

describe('the route inventory', () => {
  it('sees the application\'s routes, and every entry of the public list is a route that exists', () => {
    expect(routes().length).toBeGreaterThan(90);
    const existing = new Set(routes().map((r) => r.key));
    const stale = [...PUBLIC].filter((k) => !existing.has(k));
    expect(stale, 'PUBLIC lists routes that no longer exist: remove them').toEqual([]);
  });

  it('every route that is not public refuses somebody who is not signed in, and somebody with a made-up token', async () => {
    const open: string[] = [];
    for (const r of owned()) {
      for (const client of [null, { token: 'not.a.token' } as Client]) {
        const res = await call(client, r.method, withParams(r.url), r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
        if (res.statusCode !== 401) open.push(`${r.key} -> ${res.statusCode}${client ? ' (bad token)' : ''}`);
      }
    }
    expect(open, 'These routes answered a caller who is not signed in. Protect them, or (only if they are meant to be public) add them to PUBLIC with the reason.').toEqual([]);
  });

  it('every route with an id in its path has a cross-owner case (a new one fails here until somebody writes it)', () => {
    const missing = owned().filter((r) => r.url.includes(':') && !PARAM.some(([re]) => re.test(r.url))).map((r) => r.key);
    expect(missing, 'Add the new route\'s id to PARAM in security-isolation.test.ts').toEqual([]);
  });
});

describe('another owner\'s id never opens anything (finding SEC-12)', () => {
  const targeted = () => owned().filter((r) => r.url.includes(':'));

  it('every route with an id answers 404 for somebody else\'s id, and says nothing about the real one', async () => {
    const problems: string[] = [];
    for (const r of targeted()) {
      const res = await call(b, r.method, withParams(r.url, A), r.method === 'GET' || r.method === 'DELETE' ? undefined : (BODY[r.key] ?? {}));
      if (res.statusCode !== 404) problems.push(`${r.key} -> ${res.statusCode} ${res.body.slice(0, 120)}`);
      const leaked = mentions(res.body, A);
      if (leaked.length) problems.push(`${r.key} showed ${leaked.join(', ')}`);
    }
    expect(problems).toEqual([]);
    expect(targeted().length).toBeGreaterThan(30);
  });

  it('and nothing of A\'s was changed by all those attempts', async () => {
    const survey = await a.get(`/api/surveys/${A.surveyId}`);
    expect(survey.body).toMatchObject({ status: 'active', title: 'ZZ-MARKER-SURVEY' });
    const contacts = await a.get('/api/contacts');
    expect(contacts.items.map((c: { name: string }) => c.name).sort()).toEqual(['ZZ-MARKER-CONTACT-1', 'ZZ-MARKER-CONTACT-2', 'ZZ-MARKER-CONTACT-3']);
    expect((await a.get('/api/whatsapp/accounts')).items).toHaveLength(1);
    expect((await a.get('/api/analytics-bot')).phones).toMatchObject([{ alerts: true }]);
    expect((await a.get('/api/auth/sessions')).items.length).toBeGreaterThanOrEqual(2);
    expect((await a.get('/api/payments')).items).toHaveLength(1);
    expect((await a.get('/api/auth/me')).user).toMatchObject({ name: 'ZZ-MARKER-NAME', businessName: 'ZZ-MARKER-BIZ' });
    expect(await prisma.auditLog.count({ where: { userId: b.userId, action: { in: ['contact_reveal', 'export', 'bulk_delete'] } } })).toBe(0);
  });

  it('the same calls work for the owner (so the 404s above come from ownership, not from a broken test)', async () => {
    for (const path of [`/api/surveys/${A.surveyId}`, `/api/surveys/${A.surveyId}/analytics`, `/api/surveys/${A.surveyId}/responses`, `/api/surveys/${A.surveyId}/recipients`, `/api/surveys/${A.surveyId}/gifts`, `/api/surveys/${A.surveyId}/not-started`, `/api/payments/${A.paymentId}`, `/api/dev/simulator/${A.contactIds[0]}`]) {
      const res = await call(a, 'GET', path);
      expect(res.statusCode, path).toBe(200);
    }
    expect((await call(a, 'POST', `/api/contacts/${A.contactIds[0]}/reveal`)).statusCode).toBe(200);
  });
});

describe('lists show only your own (finding SEC-12)', () => {
  it('no route without an id shows A\'s data to B', async () => {
    const problems: string[] = [];
    for (const r of owned().filter((x) => x.method === 'GET' && !x.url.includes(':') && !/\/export\/|not-started\.csv/.test(x.url))) {
      const res = await call(b, 'GET', r.url);
      const leaked = mentions(res.body, A);
      if (leaked.length) problems.push(`${r.key} (${res.statusCode}) showed ${leaked.join(', ')}`);
    }
    expect(problems).toEqual([]);
  });

  it('B\'s own lists hold B\'s data and none of A\'s', async () => {
    expect((await b.get('/api/surveys')).items.map((s: { id: string }) => s.id)).toEqual([bWorld.surveyId]);
    expect((await b.get('/api/contacts')).total).toBe(2);
    expect((await b.get('/api/whatsapp/accounts')).items).toHaveLength(1);
    expect((await b.get('/api/payments')).items).toHaveLength(0);
    expect((await b.get('/api/analytics-bot')).phones).toHaveLength(0);
    const sessions = (await b.get('/api/auth/sessions')).items;
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.every((s: { id: string }) => s.id !== A.sessionId)).toBe(true);
    expect((await b.get('/api/wallet')).balance ?? 0).toBe(0);
    expect(JSON.stringify(await b.get('/api/contacts?search=ZZ-MARKER'))).not.toContain('ZZ-MARKER-CONTACT');
    expect((await b.get('/api/contacts?search=ZZ-MARKER')).total).toBe(0);
  });
});

describe('ids in a request body that are not yours are ignored (finding SEC-12)', () => {
  it('bulk delete and bulk tag touch only your own contacts', async () => {
    const del = await b.post('/api/contacts/bulk-delete', { ids: A.contactIds });
    expect(del.status).toBe(200);
    expect(del.deleted).toBe(0);
    const tag = await b.post('/api/contacts/bulk-tag', { ids: A.contactIds, add: ['hijacked'] });
    expect(tag.updated).toBe(0);
    const aContacts = await a.get('/api/contacts');
    expect(aContacts.total).toBe(3);
    expect(aContacts.tags).not.toContain('hijacked');
  });

  it('a send or an audience built from A\'s contact ids reaches nobody', async () => {
    const audience = await b.post(`/api/surveys/${bWorld.surveyId}/audience`, { contactIds: A.contactIds });
    expect(audience.status).toBe(200);
    expect(audience.eligible).toBe(0);
    const send = await b.post(`/api/surveys/${bWorld.surveyId}/send`, { acceptMarketingCost: true, contactIds: A.contactIds });
    expect(send.status).toBe(400);
    expect(send.error).toBe('no_eligible_contacts');
    expect(await prisma.surveyRecipient.count({ where: { contactId: { in: A.contactIds }, survey: { userId: b.userId } } })).toBe(0);
  });

  it('a webhook for B\'s number cannot start, answer or read A\'s survey, even from A\'s participants\' numbers', async () => {
    const before = await prisma.response.count({ where: { surveyId: A.surveyId } });
    const { metaPayload, postWebhook, waIdOf } = await import('./helpers');
    const res = await postWebhook(app, metaPayload(bWorld.phoneNumberId, [templateBtn(waIdOf(1), `START:${A.surveyId}`)]));
    expect(res.statusCode).toBe(200);
    expect(await prisma.response.count({ where: { surveyId: A.surveyId } })).toBe(before);
    expect(await prisma.surveyRecipient.count({ where: { surveyId: A.surveyId, status: 'started', contactId: A.contactIds[1] } })).toBe(0);
  });
});

describe('the demo simulator cannot speak as, or read, another owner\'s phone', () => {
  it('refuses a phone linked to somebody else, or in somebody else\'s profile, for both reading the chat and sending commands', async () => {
    expect(env.waMode).toBe('mock');
    for (const from of ['237677733101', '237677733100']) {
      const read = await call(b, 'GET', `/api/dev/owner?from=${from}`);
      expect(read.statusCode, `read as ${from}`).toBe(404);
      const send = await call(b, 'POST', '/api/dev/owner/send', { from, text: 'RESULTS' });
      expect(send.statusCode, `send as ${from}`).toBe(404);
    }
    expect(await redis.keys('sf:mock:chat:*:237677733101')).toEqual([]); // nothing was said to, or as, A's phone
  });

  it('still lets an owner use their own phone, a linked phone of their own, and a phone that is nobody\'s', async () => {
    expect((await call(a, 'GET', '/api/dev/owner')).statusCode).toBe(200);
    expect((await call(a, 'GET', '/api/dev/owner?from=237677733101')).statusCode).toBe(200); // linked to A
    expect((await call(b, 'GET', '/api/dev/owner?from=237699000123')).statusCode).toBe(200); // unlinked, in nobody's profile: needed to try the linking
  });

  it('shows the contact\'s number masked', async () => {
    const snap = JSON.parse((await call(a, 'GET', `/api/dev/simulator/${A.contactIds[0]}`)).body);
    expect(snap.contact.phone).toMatch(/^\+237 6XX XXX \d{3}$/);
  });
});
