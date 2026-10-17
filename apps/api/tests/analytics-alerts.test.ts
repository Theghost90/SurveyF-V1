import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { outboxKey } from '../src/services/whatsapp/mock';
import { sendOwnerAlert, sweepSlowdowns, ALERT_CAPS } from '../src/services/analytics-alerts';
import { answerIdFor, buildWorld, makeApp, metaPayload, postWebhook, replyMsg, resetAll, say, setPlan, templateBtn, textMsg, type World } from './helpers';

/** RESULTS and the push alerts, through the same webhook path as the rest of the bot (platform-mock = SurveyFlow's own number). */

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });

const PLATFORM = 'platform-mock';
const OWNER = '237699000111';
let n = 0;
const ownerSays = async (text: string) => { expect((await postWebhook(app, metaPayload(PLATFORM, [textMsg(OWNER, text, `wamid.AL${++n}`)]))).statusCode).toBe(200); };
const ownerTapsTemplate = async (payload: string) => { expect((await postWebhook(app, metaPayload(PLATFORM, [{ ...templateBtn(OWNER, payload, `wamid.ALB${++n}`) }]))).statusCode).toBe(200); };
type Out = { kind?: string; body?: string; buttons?: Array<{ id: string; title: string }> };
const chat = async () => (await redis.lrange(outboxKey(PLATFORM, OWNER), 0, -1)).map((r) => JSON.parse(r) as { direction: string; message?: Out; template?: { name: string; language: string; bodyParams: string[]; buttonPayloads: string[] } });
const botOut = async () => (await chat()).filter((c) => c.direction === 'out');
const clear = () => redis.del(outboxKey(PLATFORM, OWNER));

async function worldWithOwnerLinked(plan: 'starter' | 'growth' | 'business' = 'growth', contacts = 4): Promise<World> {
  const w = await buildWorld(app, { plan, contacts });
  const code = await w.owner.post('/api/analytics-bot/link-code');
  await ownerSays(`LINK ${code.code}`);
  expect(await prisma.ownerPhone.count({ where: { userId: w.owner.userId } })).toBe(1);
  await clear();
  return w;
}
/** `count` extra people who completed the survey long ago (or just now), without going through WhatsApp. */
async function addCompleted(w: World, count: number, completedAt = new Date()) {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: w.owner.userId } });
  const first = await prisma.contact.count({ where: { userId: owner.id } });
  await prisma.contact.createMany({ data: Array.from({ length: count }, (_, i) => ({ userId: owner.id, name: `Bulk ${first + i}`, phone: `+2375${String(first + i).padStart(8, '0')}`, consentAt: new Date() })) });
  const contacts = await prisma.contact.findMany({ where: { userId: owner.id, name: { startsWith: 'Bulk' } }, select: { id: true } });
  await prisma.surveyRecipient.createMany({ data: contacts.slice(-count).map((c) => ({ surveyId: w.surveyId, contactId: c.id, status: 'completed' as const, sentAt: completedAt, startedAt: completedAt, completedAt })) });
}
const setInbound = (userId: string, at: Date | null) => prisma.ownerPhone.updateMany({ where: { userId }, data: { lastInboundAt: at } });

describe('RESULTS: one line per question, with the split', () => {
  it('top choice with its share and count, rating average, comment count; numbers equal the dashboard\'s; FR works', async () => {
    const w = await worldWithOwnerLinked('growth', 6);
    const [q1, q2] = w.questions;
    // 3 people answer: Q1 Very satisfied ×2 / Neutral ×1; Q2 Product A ×3; Q3 a comment from one
    const finish = async (idx: number, o1: number, comment?: string) => {
      await say(app, w, idx, (f) => templateBtn(f, `START:${w.surveyId}`));
      await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q1!, o1), 'button_reply'));
      await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q2!, 0), 'list_reply'));
      await say(app, w, idx, (f) => textMsg(f, comment ?? 'skip'));
    };
    await finish(0, 0, 'Great service'); await finish(1, 0); await finish(2, 1);
    const dash = await w.owner.get(`/api/surveys/${w.surveyId}/analytics`);
    expect(dash.totals.completed).toBe(3);
    await ownerSays('RESULTS');
    const [card, link] = await botOut();
    const body = card!.message!.body!;
    expect(body).toContain('Results · 3 completed');
    expect(body).toContain('Top: Very satisfied · 67% (2/3)'); // the dashboard says 66.7 // the share, never the name alone
    expect(body).toContain('Top: Product A · 100% (3/3)');
    expect(body).toMatch(/Q3 .*\(Free text\)\n→ \d comments?/);
    expect(body).toContain('Percentages are of the people who answered that question.');
    const d1 = dash.perQuestion[0].distribution.find((d: { label: string }) => d.label === 'Very satisfied');
    expect(d1).toMatchObject({ count: 2 });
    expect(Math.round(d1.pct)).toBe(67);
    expect(link!.message).toMatchObject({ kind: 'link' });
    await clear();
    await prisma.user.update({ where: { id: w.owner.userId }, data: { locale: 'fr' } });
    await ownerSays('Résultats');
    expect((await botOut())[0]!.message!.body).toMatch(/Résultats · 3 terminé/);
  });

  it('a rating question shows its average and number of answers', async () => {
    const w = await buildWorld(app, { plan: 'growth', contacts: 2, questions: [{ text: 'Recommend us?', type: 'rating', required: true, options: null }] });
    const code = await w.owner.post('/api/analytics-bot/link-code');
    await ownerSays(`LINK ${code.code}`);
    const rid = (await prisma.surveyRecipient.findMany({ where: { surveyId: w.surveyId } }))[0]!;
    await prisma.response.createMany({ data: [
      { surveyId: w.surveyId, contactId: rid.contactId, questionId: w.questions[0]!.id, answer: '5' },
    ] });
    await prisma.surveyRecipient.update({ where: { id: rid.id }, data: { status: 'completed', startedAt: new Date(), completedAt: new Date() } });
    await clear();
    await ownerSays('RESULTS');
    expect((await botOut())[0]!.message!.body).toContain('Average 5 (1 answer)');
  });
});

describe('push alerts', () => {
  it('a real completion that reaches 100 sends the milestone, once, as a free reply inside the 24 h window', async () => {
    const w = await worldWithOwnerLinked('growth', 3);
    await addCompleted(w, 99);
    await setInbound(w.owner.userId, new Date()); // the owner wrote a minute ago
    const [q1, q2] = w.questions;
    await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`));
    await say(app, w, 0, (f) => replyMsg(f, answerIdFor(q1!, 0), 'button_reply'));
    await say(app, w, 0, (f) => replyMsg(f, answerIdFor(q2!, 0), 'list_reply'));
    await say(app, w, 0, (f) => textMsg(f, 'done'));
    await new Promise((r) => setTimeout(r, 300)); // the alert is sent after the participant's last reply, without holding it
    const out = await botOut();
    expect(out).toHaveLength(1);
    expect(out[0]!.message!.body).toContain('100 responses reached');
    expect(out[0]!.message!.body).toContain('Customer Satisfaction');
    expect(out[0]!.message!.buttons!.map((b) => b.id)).toEqual(['ab:STATS', 'ab:MUTE']);
    expect(await prisma.botAlert.findMany({ where: { surveyId: w.surveyId } })).toMatchObject([{ kind: 'milestone', key: '100', channel: 'window' }]);
    // 101 completed: no second alert for the same milestone
    expect(await sendOwnerAlert(w.owner.userId, w.surveyId, 'milestone', '100', { title: 'x', n: 100, rate: 1 })).toBe('duplicate');
    expect(await botOut()).toHaveLength(1);
  });

  it('outside the window the alert is the approved template (billed to SurveyFlow), with STATS and Mute as quick replies', async () => {
    const w = await worldWithOwnerLinked();
    await setInbound(w.owner.userId, new Date(Date.now() - 30 * 3_600_000));
    expect(await sendOwnerAlert(w.owner.userId, w.surveyId, 'milestone', '100', { title: 'Customer Satisfaction', n: 100, rate: 68.8 })).toBe('template');
    const [t] = await botOut();
    expect(t!.template).toMatchObject({ name: 'owner_alert', language: 'en', buttonPayloads: ['ab:STATS', 'ab:MUTE'] });
    expect(t!.template!.bodyParams[0]).toBe('🎉 100 responses reached · Customer Satisfaction · Completion rate so far: 68.8%'.replace('🎉 ', '🎉 '));
    expect(t!.template!.bodyParams[0]).not.toContain('\n'); // a template variable cannot hold a line break
    // the owner taps STATS on it: the answer comes back (that tap also opens the window for later alerts)
    await clear();
    await ownerTapsTemplate('ab:STATS');
    expect((await botOut())[0]!.message!.body).toContain('Invitations sent');
    expect((await prisma.ownerPhone.findFirstOrThrow({ where: { userId: w.owner.userId } })).lastInboundAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('template spend is capped per owner: 3 a day, then nothing is sent (the window still is free)', async () => {
    const w = await worldWithOwnerLinked();
    await setInbound(w.owner.userId, null);
    const res: string[] = [];
    for (let i = 0; i < ALERT_CAPS.templatesPerDay + 2; i++) res.push(await sendOwnerAlert(w.owner.userId, w.surveyId, 'slowdown', `k${i}`, { title: 'T', hours: 48 }));
    expect(res).toEqual(['template', 'template', 'template', 'skipped', 'skipped']);
    expect((await botOut()).filter((c) => c.template)).toHaveLength(3);
    await setInbound(w.owner.userId, new Date());
    expect(await sendOwnerAlert(w.owner.userId, w.surveyId, 'slowdown', 'free', { title: 'T', hours: 48 })).toBe('window');
  });

  it('MUTE (typed, or the template\'s button) stops alerts on that phone; ALERTS ON brings them back; commands still work', async () => {
    const w = await worldWithOwnerLinked();
    await ownerSays('MUTE');
    expect((await botOut())[0]!.message!.body ?? (await botOut())[0]).toBeTruthy();
    expect((await prisma.ownerPhone.findFirstOrThrow({ where: { userId: w.owner.userId } })).alerts).toBe(false);
    await clear();
    expect(await sendOwnerAlert(w.owner.userId, w.surveyId, 'milestone', '100', { title: 'T', n: 100, rate: 1 })).toBe('skipped');
    expect(await botOut()).toHaveLength(0);
    await ownerSays('STATS');
    expect((await botOut()).length).toBeGreaterThan(0);
    await ownerSays('alerts on');
    expect((await prisma.ownerPhone.findFirstOrThrow({ where: { userId: w.owner.userId } })).alerts).toBe(true);
    await ownerTapsTemplate('ab:MUTE');
    expect((await prisma.ownerPhone.findFirstOrThrow({ where: { userId: w.owner.userId } })).alerts).toBe(false);
    // the Settings switch is the same thing
    const phone = (await w.owner.get('/api/analytics-bot')).phones[0];
    expect(phone.alerts).toBe(false);
    expect((await w.owner.raw('PATCH', `/api/analytics-bot/phones/${phone.id}`, { alerts: true })).status).toBe(200);
    expect((await prisma.ownerPhone.findFirstOrThrow({ where: { userId: w.owner.userId } })).alerts).toBe(true);
    const other = await buildWorld(app, { plan: 'growth', contacts: 1 });
    expect((await other.owner.raw('PATCH', `/api/analytics-bot/phones/${phone.id}`, { alerts: false })).status).toBe(404); // not someone else's phone
  });

  it('no alert for an account whose plan has no bot, or with no linked phone', async () => {
    const w = await worldWithOwnerLinked();
    await setPlan(w.owner.userId, 'trial');
    expect(await sendOwnerAlert(w.owner.userId, w.surveyId, 'milestone', '100', { title: 'T', n: 100, rate: 1 })).toBe('skipped');
    const lone = await buildWorld(app, { plan: 'growth', contacts: 1 });
    expect(await sendOwnerAlert(lone.owner.userId, lone.surveyId, 'milestone', '100', { title: 'T', n: 100, rate: 1 })).toBe('skipped');
    expect(await botOut()).toHaveLength(0);
  });

  it('slowdown: an active survey with 10+ answers and none for 48 h is flagged once a week; a recent answer or a small survey is not', async () => {
    const w = await worldWithOwnerLinked();
    await setInbound(w.owner.userId, new Date());
    await addCompleted(w, 12, new Date(Date.now() - 3 * 86_400_000));
    expect(await sweepSlowdowns()).toBe(1);
    const [a] = await botOut();
    expect(a!.message!.body).toContain('Responses are slowing down');
    expect(a!.message!.body).toContain('48 hours');
    expect(a!.message!.buttons![0]!.id).toBe('ab:NONRESP');
    expect(await sweepSlowdowns()).toBe(0); // same week: no second alert
    // fresh answer → no alert (new week simulated by removing the dedupe row)
    await prisma.botAlert.deleteMany({});
    await addCompleted(w, 1, new Date());
    expect(await sweepSlowdowns()).toBe(0);
    // small survey
    const small = await buildWorld(app, { plan: 'growth', contacts: 3 });
    await addCompleted(small, 5, new Date(Date.now() - 5 * 86_400_000));
    expect(await sweepSlowdowns()).toBe(0);
  });
});

describe('funnel', () => {
  it('the first completed response is recorded once for the owner', async () => {
    const w = await buildWorld(app, { plan: 'growth', contacts: 2 });
    const [q1, q2] = w.questions;
    for (const idx of [0, 1]) {
      await say(app, w, idx, (f) => templateBtn(f, `START:${w.surveyId}`));
      await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q1!, 0), 'button_reply'));
      await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q2!, 0), 'list_reply'));
      await say(app, w, idx, (f) => textMsg(f, 'done'));
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.funnelEvent.count({ where: { userId: w.owner.userId, name: 'first_response' } })).toBe(1);
  });
});
