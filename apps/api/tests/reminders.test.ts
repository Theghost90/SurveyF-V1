import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { closeExpiredSurveys, runAutoReminders } from '../src/services/reminders';
import { runSendWorkerOnce } from '../src/services/whatsapp/sender';
import { buildWorld, chatOf, makeApp, resetAll, sampleQuestions, type World } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });

/**
 * Douala wall-clock (UTC+1). The day numbers read like October 2026 (12 = Monday ... 16 = Friday, 19 = next Monday) but the dates are
 * really March 2026 minus 10 days, so they are all in the PAST: the real send worker only picks up messages whose time has come.
 */
const D = (day: number, h: number, m = 0) => new Date(Date.UTC(2026, 2, day - 10, h - 1, m));

async function world(contacts = 1, plan: 'trial' | 'growth' = 'growth') {
  return buildWorld(app, { plan, contacts });
}
const rec = (w: World, i: number) => ({ surveyId_contactId: { surveyId: w.surveyId, contactId: w.contactIds[i]! } });
const setRec = (w: World, i: number, data: Record<string, unknown>) => prisma.surveyRecipient.update({ where: rec(w, i), data: data as never });
const setSurvey = (w: World, data: Record<string, unknown>) => prisma.survey.update({ where: { id: w.surveyId }, data: data as never });
const jobs = (kind?: string) => prisma.sendJob.findMany({ where: { ...(kind ? { kind } : { kind: { not: 'invitation' } }), status: { in: ['queued', 'processing', 'done'] } }, orderBy: { createdAt: 'asc' } });
const lastTemplate = async (i: number) => (await chatOf(i)).filter((c) => c.template).at(-1)?.template;
async function flush() { await runSendWorkerOnce(200); }

describe('automatic reminders are OFF until the owner switches them on', () => {
  it('sends nothing, however long people stay silent', async () => {
    const w = await world();
    await setRec(w, 0, { status: 'sent', sentAt: D(12, 10) });
    expect(await runAutoReminders(D(30, 12))).toMatchObject({ reminders: 0, followups: 0 });
    expect(await jobs()).toHaveLength(0);
  });
});

describe('non-responders — standard rule (3 to 5 business days, one warm reminder)', () => {
  it('waits for the 3rd business day, sends ONE reminder, and never a second', async () => {
    const w = await world();
    await setSurvey(w, { autoRemindNonResponders: true });
    await setRec(w, 0, { status: 'delivered', sentAt: D(12, 10) }); // Monday

    expect(await runAutoReminders(D(14, 12))).toMatchObject({ reminders: 0 }); // Wednesday: day 2
    expect(await runAutoReminders(D(15, 11, 5))).toMatchObject({ reminders: 1 }); // Thursday: day 3
    expect(await runAutoReminders(D(15, 11, 10))).toMatchObject({ reminders: 0 }); // not twice
    expect(await runAutoReminders(D(16, 11))).toMatchObject({ reminders: 0, followups: 0 });
    expect(await runAutoReminders(D(19, 11))).toMatchObject({ reminders: 0, followups: 0 }); // standard non-responders get no closing note

    await flush();
    const t = await lastTemplate(0);
    expect(t).toMatchObject({ name: 'survey_nudge' });
    expect(t.buttonPayloads[0]).toMatch(/^START:/);
    const r = await prisma.surveyRecipient.findUniqueOrThrow({ where: rec(w, 0) });
    expect(r).toMatchObject({ reminderAuto: true, reminderRule: 'standard', status: 'delivered' }); // funnel status untouched
    expect(r.remindedAt?.getTime()).toBe(D(15, 11, 5).getTime());
  });

  it('a reminder that missed its window (after the 5th business day) is dropped, never sent late', async () => {
    const w = await world();
    await setSurvey(w, { autoRemindNonResponders: true });
    await setRec(w, 0, { status: 'sent', sentAt: D(12, 10) });
    expect(await runAutoReminders(D(20, 10))).toMatchObject({ reminders: 0 }); // Tuesday of the following week
    expect(await jobs()).toHaveLength(0);
  });

  it('never sends at night: an invitation sent at 21:00 gets its reminder at 08:00, not 21:00', async () => {
    const w = await world();
    await setSurvey(w, { autoRemindNonResponders: true });
    await setRec(w, 0, { status: 'sent', sentAt: D(12, 21) }); // Monday evening
    expect(await runAutoReminders(D(15, 21, 30))).toMatchObject({ reminders: 0 }); // Thursday 21:30: day 3 but night
    expect(await runAutoReminders(D(16, 8, 5))).toMatchObject({ reminders: 1 });
  });

  it('people who answered, declined or started are never reminded as non-responders', async () => {
    const w = await world(3);
    await setSurvey(w, { autoRemindNonResponders: true });
    await setRec(w, 0, { status: 'declined', sentAt: D(12, 10) });
    await setRec(w, 1, { status: 'started', sentAt: D(12, 10), startedAt: D(12, 12) });
    await setRec(w, 2, { status: 'completed', sentAt: D(12, 10), completedAt: D(12, 12) });
    expect(await runAutoReminders(D(15, 12))).toMatchObject({ reminders: 0 });
  });
});

describe('non-responders — event rule (24 h reminder, then a deadline note)', () => {
  it('reminds 24 h after the invitation, then 24 h later tells them they still have until the deadline — once each', async () => {
    const w = await world();
    await setSurvey(w, { autoRemindNonResponders: true, kind: 'event', deadlineAt: D(16, 23, 59) });
    await setRec(w, 0, { status: 'delivered', sentAt: D(12, 9) });

    expect(await runAutoReminders(D(13, 8, 59))).toMatchObject({ reminders: 0 });
    expect(await runAutoReminders(D(13, 9, 5))).toMatchObject({ reminders: 1 });
    await flush();
    expect((await lastTemplate(0)).name).toBe('survey_nudge');
    expect((await prisma.surveyRecipient.findUniqueOrThrow({ where: rec(w, 0) })).reminderRule).toBe('event');

    expect(await runAutoReminders(D(14, 9, 0))).toMatchObject({ followups: 0 }); // 23h55 after the reminder: too early
    expect(await runAutoReminders(D(14, 9, 10))).toMatchObject({ followups: 1 });
    expect(await runAutoReminders(D(14, 9, 15))).toMatchObject({ followups: 0 });
    await flush();
    const note = await lastTemplate(0);
    expect(note.name).toBe('survey_deadline_note');
    expect(note.bodyParams[2]).toBe('Friday 6 March'); // the deadline, in the owner's calendar
    expect(note.buttonPayloads[0]).toMatch(/^START:/);
  });

  it('an event whose deadline is more than a week away is NOT chased after 24 h (standard rule instead)', async () => {
    const w = await world();
    await setSurvey(w, { autoRemindNonResponders: true, kind: 'event', deadlineAt: D(30, 18) });
    await setRec(w, 0, { status: 'sent', sentAt: D(12, 9) });
    expect(await runAutoReminders(D(13, 10))).toMatchObject({ reminders: 0 });
    expect(await runAutoReminders(D(15, 10))).toMatchObject({ reminders: 1 });
    expect((await prisma.surveyRecipient.findUniqueOrThrow({ where: rec(w, 0) })).reminderRule).toBe('standard');
  });

  it('stops at the deadline: nothing is sent once it has passed, and the survey closes', async () => {
    const w = await world();
    await setSurvey(w, { autoRemindNonResponders: true, kind: 'event', deadlineAt: D(13, 20) });
    await setRec(w, 0, { status: 'sent', sentAt: D(12, 9) });
    expect(await runAutoReminders(D(14, 10))).toMatchObject({ reminders: 0, closed: 1 });
    expect((await prisma.survey.findUniqueOrThrow({ where: { id: w.surveyId } })).status).toBe('closed');
  });
});

describe('abandoners — standard rule (2 to 3 business days, one reminder, then "your progress is saved")', () => {
  it('reminds after 2 business days, thanks them 24 h later if they have not finished — once each', async () => {
    const w = await world();
    await setSurvey(w, { autoRemindAbandoners: true });
    await setRec(w, 0, { status: 'abandoned', abandonedAtQuestion: 2, sentAt: D(12, 10), startedAt: D(12, 11), abandonedAt: D(13, 12) });

    expect(await runAutoReminders(D(14, 9, 30))).toMatchObject({ reminders: 0 });
    expect(await runAutoReminders(D(14, 10, 5))).toMatchObject({ reminders: 1 }); // Mon 10:00 + 2 business days
    await flush();
    const rem = await lastTemplate(0);
    expect(rem.name).toBe('survey_reminder');
    expect(rem.buttonPayloads[0]).toMatch(/^CONTINUE:/);

    expect(await runAutoReminders(D(15, 10, 0))).toMatchObject({ followups: 0 }); // 23h55 after the reminder
    expect(await runAutoReminders(D(15, 10, 10))).toMatchObject({ followups: 1 });
    expect(await runAutoReminders(D(15, 10, 20))).toMatchObject({ followups: 0 });
    await flush();
    expect(await lastTemplate(0)).toMatchObject({ name: 'survey_progress_saved' });
  });

  it('no thank-you note for someone who came back and finished in the meantime', async () => {
    const w = await world();
    await setSurvey(w, { autoRemindAbandoners: true });
    await setRec(w, 0, { status: 'abandoned', sentAt: D(12, 10), abandonedAt: D(13, 12) });
    expect(await runAutoReminders(D(14, 11, 5))).toMatchObject({ reminders: 1 });
    await setRec(w, 0, { status: 'completed', completedAt: D(14, 15) });
    expect(await runAutoReminders(D(15, 11, 10))).toMatchObject({ followups: 0 });
  });

  it('event rule: reminder as soon as they are flagged, note 24 h later that mentions the deadline', async () => {
    const w = await world();
    await setSurvey(w, { autoRemindAbandoners: true, kind: 'event', deadlineAt: D(16, 23, 59) });
    await setRec(w, 0, { status: 'abandoned', sentAt: D(12, 9), abandonedAt: D(13, 10) });
    expect(await runAutoReminders(D(13, 10, 5))).toMatchObject({ reminders: 1 });
    expect(await runAutoReminders(D(14, 10, 10))).toMatchObject({ followups: 1 });
    await flush();
    const note = await lastTemplate(0);
    expect(note).toMatchObject({ name: 'survey_progress_saved_deadline' });
    expect(note.bodyParams[1]).toBe('Friday 6 March');
  });
});

describe('guards', () => {
  it('a stalled worker that claims reminder AND closing note in one batch still sends the reminder first', async () => {
    const w = await world();
    await setSurvey(w, { autoRemindAbandoners: true, kind: 'event', deadlineAt: D(16, 23, 59) });
    await setRec(w, 0, { status: 'abandoned', sentAt: D(12, 9), abandonedAt: D(13, 10) });
    expect(await runAutoReminders(D(13, 10, 5))).toMatchObject({ reminders: 1 });
    expect(await runAutoReminders(D(14, 10, 10))).toMatchObject({ followups: 1 });
    // Rewriting the earlier row moves it AFTER the note in the table's physical order, which is what UPDATE ... RETURNING follows.
    await prisma.sendJob.updateMany({ where: { kind: 'reminder' }, data: { attempts: 0 } });
    await flush();
    const names = (await chatOf(0)).filter((c) => c.template).map((c) => c.template.name);
    expect(names.slice(-2)).toEqual(['survey_reminder', 'survey_progress_saved_deadline']);
  });

  it('the two switches are independent', async () => {
    const w = await world(2);
    await setSurvey(w, { autoRemindAbandoners: true }); // non-responders OFF
    await setRec(w, 0, { status: 'sent', sentAt: D(12, 10) });
    await setRec(w, 1, { status: 'abandoned', sentAt: D(12, 10), abandonedAt: D(13, 12) });
    expect(await runAutoReminders(D(15, 12))).toMatchObject({ reminders: 1 });
    expect((await jobs())[0]).toMatchObject({ kind: 'reminder' });
  });

  it('opted-out contacts, contacts without consent and non-active surveys are never contacted', async () => {
    const w = await world(3);
    await setSurvey(w, { autoRemindNonResponders: true });
    for (const i of [0, 1, 2]) await setRec(w, i, { status: 'sent', sentAt: D(12, 10) });
    await prisma.contact.update({ where: { id: w.contactIds[0]! }, data: { optedOutAt: D(13, 9) } });
    await prisma.contact.update({ where: { id: w.contactIds[1]! }, data: { consentAt: null } });
    await setSurvey(w, { status: 'paused' });
    expect(await runAutoReminders(D(15, 12))).toMatchObject({ reminders: 0 });
    await setSurvey(w, { status: 'active' });
    expect(await runAutoReminders(D(15, 12))).toMatchObject({ reminders: 1 }); // only the third contact
  });

  it('switching a profile off stops its pending closing notes', async () => {
    const w = await world();
    await setSurvey(w, { autoRemindAbandoners: true });
    await setRec(w, 0, { status: 'abandoned', sentAt: D(12, 10), abandonedAt: D(13, 12) });
    expect(await runAutoReminders(D(14, 11, 5))).toMatchObject({ reminders: 1 });
    // The other profile stays ON, so the survey is still swept: only the per-profile check can stop this note.
    await setSurvey(w, { autoRemindAbandoners: false, autoRemindNonResponders: true });
    expect(await runAutoReminders(D(15, 11, 10))).toMatchObject({ followups: 0 });
  });

  it('respects the plan\'s message quota: only as many reminders as there is room for', async () => {
    const w = await world(3, 'trial');
    await setSurvey(w, { autoRemindNonResponders: true });
    for (const i of [0, 1, 2]) await setRec(w, i, { status: 'sent', sentAt: D(12, 10) });
    const me = await w.owner.get('/api/auth/me');
    const room = me.plan.limits.messagesPerMonth - me.usage.messages;
    await prisma.messageLog.createMany({ data: Array.from({ length: room - 2 }, () => ({ userId: w.owner.userId, kind: 'invitation', waMessageId: 'x' })) });
    expect(await runAutoReminders(D(15, 12))).toMatchObject({ reminders: 2 }); // 3 are due, 2 fit
  });

  it('two workers running at once still queue exactly one reminder per person', async () => {
    const w = await world(2);
    await setSurvey(w, { autoRemindNonResponders: true });
    for (const i of [0, 1]) await setRec(w, i, { status: 'sent', sentAt: D(12, 10) });
    await Promise.all([runAutoReminders(D(15, 12)), runAutoReminders(D(15, 12)), runAutoReminders(D(15, 12))]);
    expect(await jobs('nudge')).toHaveLength(2);
  });

  it('deadlines close surveys (and only surveys that have one)', async () => {
    const w = await world();
    expect(await closeExpiredSurveys(D(30, 12))).toBe(0);
    await setSurvey(w, { deadlineAt: D(20, 12) });
    expect(await closeExpiredSurveys(D(20, 11))).toBe(0);
    expect(await closeExpiredSurveys(D(20, 12, 1))).toBe(1);
  });
});

describe('survey type and deadline through the API', () => {
  const base = () => ({ title: 'T', language: 'en', questions: sampleQuestions() });

  it('a live-event survey needs a deadline; a deadline in the past is refused; fields round-trip and a copy keeps the switches', async () => {
    const w = await world(1);
    const noDeadline = await w.owner.post('/api/surveys', { ...base(), kind: 'event' });
    expect(noDeadline.status).toBe(400);
    expect(JSON.stringify(noDeadline.body)).toMatch(/deadlineAt/);
    expect((await w.owner.post('/api/surveys', { ...base(), deadlineAt: new Date(Date.now() - 86_400_000).toISOString() })).error).toBe('deadline_past');

    const deadline = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const made = await w.owner.post('/api/surveys', { ...base(), kind: 'event', deadlineAt: deadline, autoRemindNonResponders: true, autoRemindAbandoners: false });
    expect(made.status).toBe(201);
    expect(made).toMatchObject({ kind: 'event', autoRemindNonResponders: true, autoRemindAbandoners: false });
    expect(new Date(made.deadlineAt).toISOString()).toBe(deadline);

    const copy = await w.owner.post(`/api/surveys/${made.id}/duplicate`);
    expect(copy).toMatchObject({ kind: 'event', autoRemindNonResponders: true, deadlineAt: null }); // a stale deadline is not copied
  });
});
