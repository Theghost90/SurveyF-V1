import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { newJoinCode } from '../src/services/survey/join';
import { answerIdFor, buildWorld, chatOf, makeApp, metaPayload, postWebhook, replyMsg, resetAll, setPlan, textMsg, type World } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
const savedHold = env.payoutHoldDays;
beforeEach(async () => { await resetAll(); env.payoutHoldDays = 0; });
afterEach(() => { env.payoutHoldDays = savedHold; });

/**
 * WA-05 / WA-06: joining a survey from a link or a QR code, and what a public door may win.
 * Containment under test (docs/BACKLOG.md): unguessable codes · expiry · a maximum · a country limit · a consent line and STOP · joiners count toward the Explore cap ·
 * one gift per number per survey · a ceiling on gifts to joiners · a gifts switch that starts OFF.
 */
const airtime = { giftType: 'airtime', giftValue: '500 FCFA airtime', giftAmount: 500, giftDeliveryMode: 'immediate' };
const waIdOf = (n: number) => `2376771009${String(n).padStart(2, '0')}`;
const phoneOf = (n: number) => `+${waIdOf(n)}`;
const chatFor = async (n: number) => {
  const keys = await redis.keys(`sf:mock:chat:*:${waIdOf(n)}`);
  const raw = keys.length ? await redis.lrange(keys[0]!, 0, -1) : [];
  return raw.map((r) => JSON.parse(r));
};
const send = (w: World, n: number, body: string, name?: string) => {
  const payload = metaPayload(w.phoneNumberId, [textMsg(waIdOf(n), body)]) as any;
  if (name) payload.entry[0].changes[0].value.contacts = [{ wa_id: waIdOf(n), profile: { name } }];
  return postWebhook(app, payload);
};
const joinOn = (w: World, over: Record<string, unknown> = {}) => w.owner.put(`/api/surveys/${w.surveyId}/join`, { enabled: true, ...over });
const live = (extra: Record<string, unknown> = {}) => buildWorld(app, { contacts: 0, send: false, plan: 'starter', ...extra });
const textsOf = (chat: any[]) => chat.filter((m) => m.direction === 'out').map((m) => m.message?.body ?? '').join('\n');
const recipientOf = async (n: number) => prisma.surveyRecipient.findFirst({ where: { contact: { phoneHash: { not: null } }, via: 'join' }, orderBy: { createdAt: 'desc' } }).then(async (r) => (r && (await prisma.contact.findUnique({ where: { id: r.contactId } }))?.phone === phoneOf(n) ? r : null));

describe('the code', () => {
  it('is 26 characters of base32 (128 bits) and never repeats', () => {
    const codes = new Set(Array.from({ length: 500 }, newJoinCode));
    expect(codes.size).toBe(500);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{26}$/);
  });

  it('is created when the link is switched on, with an end date, and is different for every survey', async () => {
    const a = await live(); const b = await live();
    const on = await joinOn(a);
    expect(on.status).toBe(200);
    expect(on.body.code).toMatch(/^[a-z2-7]{26}$/);
    expect(on.body.enabled).toBe(true);
    expect(new Date(on.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 25 * 86_400_000); // 30 days by default: a printed QR code does not stay open for ever by accident
    expect(on.body.link).toContain(`text=JOIN%20${on.body.code}`);
    expect((await joinOn(b)).body.code).not.toBe(on.body.code);
    expect(await prisma.auditLog.count({ where: { action: 'join_link_on' } })).toBe(2);
  });

  it('can be replaced: the old one stops working at once', async () => {
    const w = await live();
    const old = (await joinOn(w)).body.code as string;
    const fresh = (await w.owner.put(`/api/surveys/${w.surveyId}/join`, { rotate: true })).body.code as string;
    expect(fresh).not.toBe(old);
    await send(w, 1, `JOIN ${old}`);
    expect(await prisma.surveyRecipient.count({ where: { via: 'join' } })).toBe(0);
    await send(w, 2, `JOIN ${fresh}`);
    expect(await prisma.surveyRecipient.count({ where: { via: 'join' } })).toBe(1);
  });
});

describe('joining', () => {
  it('a stranger who sends the join words gets a consent message first, and nothing starts until they answer START', async () => {
    const w = await live();
    const { body } = await joinOn(w);
    expect((await send(w, 1, `JOIN ${body.code}`, 'Aïcha  M. ')).statusCode).toBe(200);
    const contact = await prisma.contact.findFirstOrThrow({ where: { userId: w.owner.userId } });
    expect(contact.phone).toBe(phoneOf(1));
    expect(contact.name).toBe('Aïcha M.');
    expect(contact.consentSource).toBe('join_link');
    expect(contact.consentAt).not.toBeNull();
    const recipient = await prisma.surveyRecipient.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(recipient).toMatchObject({ status: 'sent', via: 'join' });
    const said = textsOf(await chatFor(1));
    expect(said).toMatch(/STOP/);
    expect(said).toMatch(/START/);
    expect(said).toMatch(/answers and this WhatsApp number/);
    expect(await prisma.response.count()).toBe(0);

    await send(w, 1, 'START');
    expect((await prisma.surveyRecipient.findUniqueOrThrow({ where: { id: recipient.id } })).status).toBe('started');
    await postWebhook(app, metaPayload(w.phoneNumberId, [replyMsg(waIdOf(1), answerIdFor(w.questions[0], 0))]));
    expect(await prisma.response.count()).toBe(1);
  });

  it('STOP works for somebody who joined, and a second join does not make a second row', async () => {
    const w = await live();
    const { body } = await joinOn(w);
    await send(w, 1, `JOIN ${body.code}`);
    await send(w, 1, `JOIN ${body.code}`);
    expect(await prisma.surveyRecipient.count({ where: { via: 'join' } })).toBe(1);
    await send(w, 1, 'STOP');
    const contact = await prisma.contact.findFirstOrThrow({ where: { userId: w.owner.userId } });
    expect(contact.optedOutAt).not.toBeNull();
  });

  it('nothing is created for a message that is not exactly the join words', async () => {
    const w = await live();
    const { body } = await joinOn(w);
    for (const text of [`please JOIN ${body.code}`, `JOIN ${body.code} and send me the gift`, `JOIN ${String(body.code).slice(0, 25)}`, 'JOIN']) await send(w, 1, text);
    expect(await prisma.contact.count()).toBe(0);
  });

  it('an unknown code and a refused join look the same to the person: the link "is not valid any more"', async () => {
    const w = await live();
    await joinOn(w, { max: 1 });
    const code = (await w.owner.get(`/api/surveys/${w.surveyId}/join`)).body.code;
    await send(w, 1, `JOIN ${code}`); // fills it
    await send(w, 2, `JOIN ${code}`); // refused: full
    await send(w, 3, `JOIN ${newJoinCode()}`); // unknown
    const refusedFull = textsOf(await chatFor(2));
    const refusedUnknown = textsOf(await chatFor(3));
    expect(refusedFull).toBe(refusedUnknown);
    expect(refusedFull).toMatch(/no longer valid|not valid any more/i);
    expect(refusedFull).not.toMatch(/full|expired|country|limit|max/i);
    expect(await prisma.surveyRecipient.count({ where: { via: 'join' } })).toBe(1);
  });
});

describe('the limits on a link', () => {
  it('stops after the maximum', async () => {
    const w = await live();
    const code = (await joinOn(w, { max: 2 })).body.code;
    for (const n of [1, 2, 3, 4]) await send(w, n, `JOIN ${code}`);
    expect(await prisma.surveyRecipient.count({ where: { via: 'join' } })).toBe(2);
    expect((await w.owner.get(`/api/surveys/${w.surveyId}/join`)).body.joined).toBe(2);
  });

  it('stops at the end date', async () => {
    const w = await live();
    const code = (await joinOn(w)).body.code;
    await prisma.survey.update({ where: { id: w.surveyId }, data: { joinExpiresAt: new Date(Date.now() - 1000) } });
    await send(w, 1, `JOIN ${code}`);
    expect(await prisma.contact.count()).toBe(0);
  });

  it('accepts only the countries on the list', async () => {
    const w = await live();
    const code = (await joinOn(w, { countries: ['cm', 'CI'] })).body.code;
    await postWebhook(app, metaPayload(w.phoneNumberId, [textMsg('221771234567', `JOIN ${code}`)])); // Senegal
    expect(await prisma.contact.count()).toBe(0);
    await postWebhook(app, metaPayload(w.phoneNumberId, [textMsg('2250712345678', `JOIN ${code}`)])); // Côte d'Ivoire
    expect(await prisma.contact.count()).toBe(1);
    expect((await w.owner.get(`/api/surveys/${w.surveyId}/join`)).body.countries).toEqual(['CM', 'CI']);
  });

  it('does nothing while the survey is paused or closed, or when the link is switched off', async () => {
    const w = await live();
    const code = (await joinOn(w)).body.code;
    await w.owner.post(`/api/surveys/${w.surveyId}/pause`);
    await send(w, 1, `JOIN ${code}`);
    await w.owner.post(`/api/surveys/${w.surveyId}/resume`);
    await w.owner.put(`/api/surveys/${w.surveyId}/join`, { enabled: false });
    await send(w, 2, `JOIN ${code}`);
    expect(await prisma.contact.count()).toBe(0);
  });

  it('a code of one owner does nothing on another owner\'s number', async () => {
    const a = await live(); const b = await live();
    const code = (await joinOn(a)).body.code;
    await send(b, 1, `JOIN ${code}`);
    expect(await prisma.contact.count()).toBe(0);
  });

  it('answers a number at most six times an hour, then stays silent', async () => {
    const w = await live();
    for (let i = 0; i < 9; i++) await send(w, 1, `JOIN ${newJoinCode()}`);
    expect((await chatFor(1)).filter((m) => m.direction === 'out').length).toBe(6);
  });
});

describe('the free plan\'s cap counts the people who join', () => {
  it('Explore lets in five different people through the link and no sixth; the refusal is recorded as a count', async () => {
    const w = await buildWorld(app, { contacts: 0, send: false, plan: 'trial' });
    const code = (await joinOn(w)).body.code;
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await send(w, n, `JOIN ${code}`);
    expect(await prisma.surveyRecipient.count({ where: { via: 'join' } })).toBe(5);
    expect(await prisma.contact.count()).toBe(5);
    const signals = await prisma.capSignal.findMany();
    expect(signals).toHaveLength(1); // one per hour per owner, not one per attempt
    expect(signals[0]).toMatchObject({ kind: 'join_refused', cap: 5, reached: 5, plan: 'trial' });
    expect(JSON.stringify(signals)).not.toMatch(/\+?2376771009/); // counts only: no number anywhere
  });

  it('a paid plan has no such cap', async () => {
    const w = await live();
    const code = (await joinOn(w)).body.code;
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await send(w, n, `JOIN ${code}`);
    expect(await prisma.surveyRecipient.count({ where: { via: 'join' } })).toBe(7);
  });
});

describe('what a public door may win (WA-06)', () => {
  const growth = (extra: Record<string, unknown> = {}) => buildWorld(app, { contacts: 0, send: false, plan: 'growth', gift: airtime, wallet: 100_000, ...extra });
  async function finish(w: World, n: number, code: string) {
    await send(w, n, `JOIN ${code}`);
    await send(w, n, 'START');
    await postWebhook(app, metaPayload(w.phoneNumberId, [replyMsg(waIdOf(n), answerIdFor(w.questions[0], 0))]));
    await postWebhook(app, metaPayload(w.phoneNumberId, [replyMsg(waIdOf(n), answerIdFor(w.questions[1], 0), 'list_reply')]));
    await postWebhook(app, metaPayload(w.phoneNumberId, [textMsg(waIdOf(n), 'fine')]));
    await postWebhook(app, metaPayload(w.phoneNumberId, [textMsg(waIdOf(n), 'ok')])); // any further free-text question
  }
  const gifts = () => prisma.giftDelivery.count();

  it('people who joined get NO gift by default, however much the survey offers', async () => {
    const w = await growth();
    const code = (await joinOn(w)).body.code;
    await finish(w, 1, code);
    expect((await prisma.surveyRecipient.findFirstOrThrow({ where: { via: 'join' } })).status).toBe('completed');
    expect(await gifts()).toBe(0);
    expect(textsOf(await chatFor(1))).not.toMatch(/gift|cadeau/i);
  });

  it('with the switch on, they get one, and the owner is asked to confirm it is them', async () => {
    const w = await growth();
    await joinOn(w);
    const noStepUp = await w.owner.put(`/api/surveys/${w.surveyId}/join`, { gifts: true });
    expect(noStepUp.status).toBe(403); // money: a fresh "confirm it is you"
    await prisma.survey.update({ where: { id: w.surveyId }, data: { joinGifts: true } });
    const code = (await w.owner.get(`/api/surveys/${w.surveyId}/join`)).body.code;
    await finish(w, 1, code);
    expect(await gifts()).toBe(1);
  });

  it('a ceiling on the gifts to joiners holds, and a number gets one gift per survey however often it joins', async () => {
    const w = await growth();
    const code = (await joinOn(w)).body.code as string;
    await prisma.survey.update({ where: { id: w.surveyId }, data: { joinGifts: true, joinGiftMax: 2 } });
    for (const n of [1, 2, 3, 4]) await finish(w, n, code);
    expect(await gifts()).toBe(2);
    await finish(w, 1, code); // the same number again
    expect(await gifts()).toBe(2);
    const detail = (await w.owner.get(`/api/surveys/${w.surveyId}/join`)).body;
    expect(detail).toMatchObject({ joined: 4, giftsGiven: 2, giftMax: 2 });
  });

  it('people the owner imported are not affected by the joiners\' rules', async () => {
    const w = await growth({ contacts: 1, send: true });
    await joinOn(w);
    expect(await prisma.surveyRecipient.count({ where: { via: 'join' } })).toBe(0);
    const r = await prisma.surveyRecipient.findFirstOrThrow({});
    expect(r.via).toBeNull();
  });

  it('refuses to give joiners a gift on a survey that has none', async () => {
    const w = await live();
    await joinOn(w);
    const res = await w.owner.put(`/api/surveys/${w.surveyId}/join`, { gifts: true });
    expect([400, 403]).toContain(res.status);
    expect((await prisma.survey.findUniqueOrThrow({ where: { id: w.surveyId } })).joinGifts).toBe(false);
  });
});

describe('who can change a link', () => {
  it('another owner cannot read or change it', async () => {
    const a = await live(); const b = await live();
    expect((await b.owner.get(`/api/surveys/${a.surveyId}/join`)).status).toBe(404);
    expect((await b.owner.put(`/api/surveys/${a.surveyId}/join`, { enabled: true })).status).toBe(404);
  });

  it('a team member cannot reach the link settings at all', async () => {
    const w = await live();
    const { MEMBER_ROUTES } = await import('../src/services/team/access');
    expect(Object.keys(MEMBER_ROUTES).filter((k) => k.includes('/join'))).toEqual([]);
  });

  it('a plan change does not switch a link on or off by itself', async () => {
    const w = await live();
    await joinOn(w);
    await setPlan(w.owner.userId, 'growth');
    expect((await w.owner.get(`/api/surveys/${w.surveyId}/join`)).body.enabled).toBe(true);
  });
});
