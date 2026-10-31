import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { processDueGifts } from '../src/services/gifts';
import { sweepAbandoned } from '../src/services/survey/abandon';
import { getSession, saveSession } from '../src/services/survey/sessions';
import { runSendWorkerOnce } from '../src/services/whatsapp/sender';
import {
  answerIdFor, buildWorld, chatOf, client, loginRaw, makeApp, metaPayload, postWebhook, registerOwner, replyMsg, resetAll, say, signUp, templateBtn, textMsg, waIdOf,
} from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });

describe('auth', () => {
  it('signs up, confirms the address by e-mail, signs in, starts on Explore, and never reveals whether an address is taken', async () => {
    const up = await signUp(app, { email: 'jp@example.com' });
    expect(up.status).toBe(200);
    const me = await up.client!.get('/api/auth/me');
    expect(me.plan.key).toBe('trial');
    expect(me.subscription.status).toBe('trial');
    expect(me.subscription.daysLeft).toBeGreaterThanOrEqual(13);
    expect(me.user.emailVerified).toBe(true);

    // A second sign-up with the same address (any capitals) gets the SAME answer as a new one: 202, nothing else.
    const dup = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ businessName: 'x', name: 'x', email: 'JP@example.com', phone: '+237677000002', password: 'longenough-1234' }) });
    expect(dup.statusCode).toBe(202);

    expect((await loginRaw(app, 'jp@example.com', 'wrong-password-x')).statusCode).toBe(401);
    const good = await loginRaw(app, 'jp@example.com', 'correct-horse-battery');
    expect(good.statusCode).toBe(200);
    expect(JSON.parse(good.body).accessToken).toBeTruthy();
  });

  it('protects API routes and scopes data per owner', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/surveys' })).statusCode).toBe(401);
    const a = await registerOwner(app);
    const b = await registerOwner(app);
    const s = await a.post('/api/surveys', { title: 'Private', questions: [{ text: 'q', type: 'text', required: true }] });
    expect((await b.get(`/api/surveys/${s.id}`)).status).toBe(404); // not 403: do not even confirm it exists
    expect((await b.get(`/api/surveys/${s.id}/analytics`)).status).toBe(404);
  });
});

describe('survey builder rules', () => {
  it('rejects questions that WhatsApp cannot render', async () => {
    const o = await registerOwner(app);
    const four = Array.from({ length: 4 }, (_, i) => ({ id: `o${i}`, label: `Opt ${i}` }));
    const r = await o.post('/api/surveys', { title: 'T', questions: [{ text: 'q', type: 'button', required: true, options: four }] });
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/at most 3/);
  });

  it('freezes questions after publishing but still allows copy/gift edits, and duplicates for editing', async () => {
    const w = await buildWorld(app, { send: false });
    const cur = await w.owner.get(`/api/surveys/${w.surveyId}`);
    const body = (over: object) => ({ title: cur.title, language: 'en', questions: cur.questions.map((q: any) => ({ text: q.text, type: q.type, required: q.required, options: q.options })), ...over });
    expect((await w.owner.put(`/api/surveys/${w.surveyId}`, body({ title: 'Renamed' }))).status).toBe(200);
    const changed = body({});
    changed.questions[0].text = 'Edited after publishing';
    const locked = await w.owner.put(`/api/surveys/${w.surveyId}`, changed);
    expect(locked.status).toBe(409);
    expect(locked.error).toBe('questions_locked');
    const dup = await w.owner.post(`/api/surveys/${w.surveyId}/duplicate`);
    expect(dup.status).toBe(201);
    expect(dup.status === 201 && dup.questions).toHaveLength(3);
  });

  it('refuses to send to contacts without consent, and CSV import requires the opt-in attestation', async () => {
    const o = await registerOwner(app);
    const form = (consent: boolean) => {
      const boundary = '----sf';
      const csv = 'nom;téléphone;tags\nMarie N.;677 12 34 56;vip\nPaul K.;not-a-number;\nMarie N. bis;677123456;\n';
      const parts = [`--${boundary}\r\nContent-Disposition: form-data; name="consent"\r\n\r\n${consent}\r\n`, `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n`, `--${boundary}--\r\n`];
      return app.inject({ method: 'POST', url: '/api/contacts/import', headers: { authorization: `Bearer ${o.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: parts.join('') });
    };
    expect((await form(false)).statusCode).toBe(400);
    const ok = await form(true);
    expect(ok.statusCode).toBe(200);
    const r = JSON.parse(ok.body);
    expect(r).toMatchObject({ created: 1, skipped: 2 }); // FR-style ";" delimiter and "nom/téléphone" headers understood; bad + duplicate rows reported
    const list = await o.get('/api/contacts');
    expect(list.items[0].phone).toBe('+237 6XX XXX 456'); // masked in every list...
    expect((await o.post(`/api/contacts/${list.items[0].id}/reveal`)).phone).toBe('+237677123456'); // ...the full number is one logged reveal away
  });
});

describe('end-to-end participant flow through the signed webhook', () => {
  it('rejects unsigned and wrongly signed webhooks (forged answers must not be possible)', async () => {
    const w = await buildWorld(app);
    const forged = metaPayload(w.phoneNumberId, [templateBtn(waIdOf(0), `START:${w.surveyId}`)]);
    expect((await postWebhook(app, forged, { sign: false })).statusCode).toBe(401);
    expect((await postWebhook(app, forged, { secret: 'attacker-guess' })).statusCode).toBe(401);
    expect((await prisma.surveyRecipient.findFirst({ where: { status: 'started' } }))).toBeNull();
  });

  it('verifies the Meta handshake', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    expect((await app.inject({ method: 'GET', url: '/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1' })).statusCode).toBe(403);
  });

  it('sends invitations through the queue, tracks delivery, and counts message quota', async () => {
    const w = await buildWorld(app, { contacts: 3 });
    const rows = await prisma.surveyRecipient.findMany({ where: { surveyId: w.surveyId } });
    expect(rows.map((r) => r.status).sort()).toEqual(['sent', 'sent', 'sent']);
    expect(await prisma.messageLog.count()).toBe(3);
    const chat = await chatOf(0);
    expect(chat[0].template.name).toBe('survey_invitation_marketing'); // WA-03: a survey that does not say it follows a transaction goes out as marketing
    expect(chat[0].template.buttonPayloads[0]).toBe(`START:${w.surveyId}`);
    // Meta's delivery receipt moves sent → delivered, never backwards
    const wamid = rows[0]!.waMessageId!;
    await postWebhook(app, metaPayload(w.phoneNumberId, [], [{ id: wamid, status: 'delivered' }]));
    expect((await prisma.surveyRecipient.findUnique({ where: { id: rows[0]!.id } }))!.status).toBe('delivered');
  });

  it('runs a full survey: START → buttons → list → text → thank-you; stores answers; completes once', async () => {
    const w = await buildWorld(app);
    const [q1, q2] = w.questions;

    await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`));
    let chat = await chatOf(0);
    expect(chat.at(-1).message.kind).toBe('buttons');
    expect(chat.at(-1).message.body).toContain('Question 1 of 3');
    expect((await prisma.surveyRecipient.findFirst({ where: { contactId: w.contactIds[0] } }))!.status).toBe('started');

    await say(app, w, 0, (f) => replyMsg(f, answerIdFor(q1!, 0), 'button_reply'));
    chat = await chatOf(0);
    expect(chat.at(-1).message.kind).toBe('list');

    await say(app, w, 0, (f) => replyMsg(f, answerIdFor(q2!, 1), 'list_reply'));
    chat = await chatOf(0);
    expect(chat.at(-1).message.body).toContain('Question 3 of 3');

    await say(app, w, 0, (f) => textMsg(f, 'Faster delivery please'));
    chat = await chatOf(0);
    expect(chat.at(-1).message.body).toContain('Thank you');

    const r = await prisma.surveyRecipient.findFirst({ where: { contactId: w.contactIds[0] } });
    expect(r!.status).toBe('completed');
    expect(r!.completedAt).toBeTruthy();
    const answers = await prisma.response.findMany({ where: { contactId: w.contactIds[0] }, orderBy: { answeredAt: 'asc' } });
    expect(answers.map((a) => a.answer)).toEqual(['Very satisfied', 'Product B', 'Faster delivery please']);
    expect(await getSession(w.phoneNumberId, waIdOf(0))).toBeNull();

    // a completed participant tapping START again must not restart or double-reward
    await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`));
    expect((await chatOf(0)).at(-1).message.body).toMatch(/already completed/i);
    expect(await prisma.response.count({ where: { contactId: w.contactIds[0] } })).toBe(3);
  });

  // Free-text answers are the case that REALLY needs message-id dedupe: a button reply carries its question id
  // (so a replay is detected as "stale"), but a replayed "alpha" would otherwise be taken as the answer to Q2.
  const twoTextQuestions = [
    { text: 'First thing?', type: 'text', required: true },
    { text: 'Second thing?', type: 'text', required: true },
  ];

  it('is idempotent: Meta redelivering the same free-text message id does not answer the NEXT question', async () => {
    const w = await buildWorld(app, { questions: twoTextQuestions });
    await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`));
    const msg = textMsg(waIdOf(0), 'alpha', 'wamid.FIXED-TEXT');
    for (let i = 0; i < 3; i++) expect((await postWebhook(app, metaPayload(w.phoneNumberId, [msg]))).statusCode).toBe(200);
    const rows = await prisma.response.findMany({ where: { contactId: w.contactIds[0] } });
    expect(rows.map((r) => r.answer)).toEqual(['alpha']);
    expect((await getSession(w.phoneNumberId, waIdOf(0)))!.currentIndex).toBe(1);
  });

  it('handles CONCURRENT duplicate deliveries of a free-text answer without double-advancing', async () => {
    const w = await buildWorld(app, { questions: twoTextQuestions });
    await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`));
    const msg = textMsg(waIdOf(0), 'alpha', 'wamid.CONCURRENT-TEXT');
    await Promise.all(Array.from({ length: 6 }, () => postWebhook(app, metaPayload(w.phoneNumberId, [msg]))));
    expect(await prisma.response.count({ where: { contactId: w.contactIds[0] } })).toBe(1);
    expect((await getSession(w.phoneNumberId, waIdOf(0)))!.currentIndex).toBe(1);
  });

  it('two DIFFERENT quick messages in a row are both applied, in order (the lock serialises, it does not drop)', async () => {
    const w = await buildWorld(app, { questions: twoTextQuestions });
    await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`));
    await Promise.all([
      postWebhook(app, metaPayload(w.phoneNumberId, [textMsg(waIdOf(0), 'one', 'wamid.A1')])),
      postWebhook(app, metaPayload(w.phoneNumberId, [textMsg(waIdOf(0), 'two', 'wamid.A2')])),
    ]);
    const rows = await prisma.response.findMany({ where: { contactId: w.contactIds[0] } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.answer))).toEqual(new Set(['one', 'two']));
    expect((await prisma.surveyRecipient.findFirst({ where: { contactId: w.contactIds[0] } }))!.status).toBe('completed');
  });

  it('processes ALL messages in a batched webhook (the spec pseudo-code only read messages[0])', async () => {
    const w = await buildWorld(app);
    const payload = metaPayload(w.phoneNumberId, [templateBtn(waIdOf(0), `START:${w.surveyId}`), templateBtn(waIdOf(1), `START:${w.surveyId}`), templateBtn(waIdOf(2), `DECLINE:${w.surveyId}`)]);
    expect((await postWebhook(app, payload)).statusCode).toBe(200);
    const byContact = Object.fromEntries((await prisma.surveyRecipient.findMany()).map((r) => [r.contactId, r.status]));
    expect(byContact[w.contactIds[0]!]).toBe('started');
    expect(byContact[w.contactIds[1]!]).toBe('started');
    expect(byContact[w.contactIds[2]!]).toBe('declined');
  });

  it('ignores stale buttons, re-asks on garbage input, and ignores strangers and unrelated chatter', async () => {
    const w = await buildWorld(app);
    const [q1, q2] = w.questions;
    await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`));
    await say(app, w, 0, (f) => replyMsg(f, answerIdFor(q1!, 0), 'button_reply'));
    // scrolls up and taps an OLD Q1 button while Q2 is pending
    await say(app, w, 0, (f) => replyMsg(f, answerIdFor(q1!, 2), 'button_reply'));
    expect(await prisma.response.count({ where: { contactId: w.contactIds[0] } })).toBe(1);
    expect((await chatOf(0)).at(-1).message.body).toContain('Question 2 of 3');
    // types nonsense for a list question
    await say(app, w, 0, (f) => textMsg(f, 'banana'));
    expect((await chatOf(0)).at(-2).message.body).toMatch(/pick one/i);
    // typed "3" picks the third option
    await say(app, w, 0, (f) => textMsg(f, '3'));
    expect((await prisma.response.findFirst({ where: { questionId: q2!.id } }))!.answer).toBe('Product C');

    // a stranger (not an imported contact) cannot start anything
    await postWebhook(app, metaPayload(w.phoneNumberId, [templateBtn('237699999999', `START:${w.surveyId}`)]));
    expect((await redis.keys('sf:mock:chat:*:237699999999')).length).toBe(0);
    // unrelated chat from a known contact with no session (owner chatting through Coexistence) is left alone
    const before = (await chatOf(2)).length;
    await say(app, w, 2, (f) => textMsg(f, 'Hello, do you have bread today?'));
    expect((await chatOf(2)).length).toBe(before);
  });

  it('isolates two businesses that survey the SAME phone number (chat + session never cross over)', async () => {
    const a = await buildWorld(app, { contacts: 1 });
    const b = await buildWorld(app, { contacts: 1 }); // identical participant phone, different business + survey
    expect(a.phoneNumberId).not.toBe(b.phoneNumberId);
    await say(app, a, 0, (f) => templateBtn(f, `START:${a.surveyId}`));
    await postWebhook(app, metaPayload(b.phoneNumberId, [templateBtn(waIdOf(0), `START:${b.surveyId}`)]));
    const rA = await prisma.surveyRecipient.findFirst({ where: { surveyId: a.surveyId } });
    const rB = await prisma.surveyRecipient.findFirst({ where: { surveyId: b.surveyId } });
    expect([rA!.status, rB!.status]).toEqual(['started', 'started']);
    // a tap on A's survey arriving at B's number must be ignored (not B's participant)
    const before = await prisma.response.count();
    await postWebhook(app, metaPayload(b.phoneNumberId, [replyMsg(waIdOf(0), answerIdFor(a.questions[0]!, 0), 'button_reply')]));
    expect(await prisma.response.count()).toBe(before);
    expect((await getSession(a.phoneNumberId, waIdOf(0)))!.surveyId).toBe(a.surveyId);
    expect((await getSession(b.phoneNumberId, waIdOf(0)))!.surveyId).toBe(b.surveyId);
  });

  it('abandons after 24h at the right question, then resumes via the reminder button', async () => {
    const w = await buildWorld(app);
    const [q1] = w.questions;
    await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`));
    await say(app, w, 0, (f) => replyMsg(f, answerIdFor(q1!, 1), 'button_reply'));
    const s = (await getSession(w.phoneNumberId, waIdOf(0)))!;
    await saveSession(w.phoneNumberId, waIdOf(0), { ...s, lastInteractionAt: new Date(Date.now() - 25 * 3_600_000).toISOString() });
    expect(await sweepAbandoned()).toBe(1);
    const r = (await prisma.surveyRecipient.findFirst({ where: { contactId: w.contactIds[0] } }))!;
    expect(r.status).toBe('abandoned');
    expect(r.abandonedAtQuestion).toBe(2); // abandoned while looking at Q2
    expect(await getSession(w.phoneNumberId, waIdOf(0))).toBeNull();

    // too early: the manual button follows the automatic window (2 business days after the invitation)
    const early = await w.owner.raw('POST', `/api/surveys/${w.surveyId}/remind`, { target: 'abandoned' });
    expect(early.status).toBe(409);
    expect(early.json.error).toBe('reminder_not_yet');
    await prisma.surveyRecipient.update({ where: { id: r.id }, data: { sentAt: new Date(Date.now() - 10 * 86_400_000), abandonedAt: new Date(Date.now() - 9 * 86_400_000) } });

    // window open: the owner sends the reminder; it is a TEMPLATE (we are outside the 24h window)
    const rem = await w.owner.post(`/api/surveys/${w.surveyId}/remind`, { target: 'abandoned' });
    expect(rem.queued).toBe(1);
    await runSendWorkerOnce();
    const last = (await chatOf(0)).at(-1);
    expect(last.template.name).toBe('survey_reminder');
    // reminder does NOT regress funnel state
    expect((await prisma.surveyRecipient.findUnique({ where: { id: r.id } }))!.status).toBe('abandoned');
    // asking twice is refused: at most one reminder per participant
    expect((await w.owner.post(`/api/surveys/${w.surveyId}/remind`, { target: 'abandoned' })).status).toBe(400);

    await say(app, w, 0, (f) => templateBtn(f, last.template.buttonPayloads[0]));
    const after = (await prisma.surveyRecipient.findUnique({ where: { id: r.id } }))!;
    expect(after.status).toBe('started');
    expect(after.abandonedAtQuestion).toBeNull();
    expect((await chatOf(0)).at(-1).message.body).toContain('Question 2 of 3'); // continues, does not restart
  });

  it('STOP opts the contact out, cancels pending sends, and blocks future invitations', async () => {
    const w = await buildWorld(app, { send: false });
    await w.owner.post(`/api/surveys/${w.surveyId}/send`, { acceptMarketingCost: true, contactIds: [w.contactIds[0]], scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    await say(app, w, 0, (f) => textMsg(f, 'STOP'));
    const c = await prisma.contact.findUnique({ where: { id: w.contactIds[0] } });
    expect(c!.optedOutAt).toBeTruthy();
    expect((await prisma.sendJob.findFirst({ where: { recipient: { contactId: w.contactIds[0] } } }))!.status).toBe('failed');
    expect((await chatOf(0)).at(-1).message.body).toMatch(/unsubscribed/i);
    const again = await w.owner.post(`/api/surveys/${w.surveyId}/send`, { acceptMarketingCost: true, contactIds: [w.contactIds[0]] });
    expect(again.status).toBe(400); // no eligible contacts
  });

  it('audience endpoint counts exactly who a send would reach (not "all contacts")', async () => {
    const w = await buildWorld(app, { contacts: 4, send: false });
    expect((await w.owner.post(`/api/surveys/${w.surveyId}/audience`, { all: true })).eligible).toBe(4);
    await say(app, w, 3, (f) => textMsg(f, 'STOP')); // contact 4 opts out
    expect((await w.owner.post(`/api/surveys/${w.surveyId}/audience`, { all: true })).eligible).toBe(3);
    await w.owner.post(`/api/surveys/${w.surveyId}/send`, { acceptMarketingCost: true, contactIds: [w.contactIds[0]] });
    await runSendWorkerOnce();
    const a = await w.owner.post(`/api/surveys/${w.surveyId}/audience`, { all: true });
    expect(a.eligible).toBe(2); // one already invited, one opted out
    expect(a.optedOut).toBe(1);
    expect((await w.owner.post(`/api/surveys/${w.surveyId}/audience`, { contactIds: [w.contactIds[0]] })).eligible).toBe(0);
  });

  it('lists responses most-recent-first with abandoned participants after finished ones (NULL completedAt sorts last)', async () => {
    const w = await buildWorld(app, { contacts: 3 });
    const [q1, q2] = w.questions;
    await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`)); // contact 0 starts, never finishes
    await say(app, w, 1, (f) => templateBtn(f, `START:${w.surveyId}`));
    await say(app, w, 1, (f) => replyMsg(f, answerIdFor(q1!, 0), 'button_reply'));
    await say(app, w, 1, (f) => replyMsg(f, answerIdFor(q2!, 0), 'list_reply'));
    await say(app, w, 1, (f) => textMsg(f, 'done')); // contact 1 completes
    const r = await w.owner.get(`/api/surveys/${w.surveyId}/responses`);
    expect(r.items.map((x: any) => x.status)).toEqual(['completed', 'started']);
  });

  it('computes analytics from funnel state without the spec formula bug', async () => {
    const w = await buildWorld(app, { contacts: 5 });
    const [q1, q2] = w.questions;
    // c0 completes, c1 abandons at Q2, c2 declines, c3 starts and is still in progress, c4 never replies
    await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`));
    await say(app, w, 0, (f) => replyMsg(f, answerIdFor(q1!, 0), 'button_reply'));
    await say(app, w, 0, (f) => replyMsg(f, answerIdFor(q2!, 0), 'list_reply'));
    await say(app, w, 0, (f) => textMsg(f, 'Great'));
    await say(app, w, 1, (f) => templateBtn(f, `START:${w.surveyId}`));
    await say(app, w, 1, (f) => replyMsg(f, answerIdFor(q1!, 1), 'button_reply'));
    const s = (await getSession(w.phoneNumberId, waIdOf(1)))!;
    await saveSession(w.phoneNumberId, waIdOf(1), { ...s, lastInteractionAt: new Date(Date.now() - 30 * 3_600_000).toISOString() });
    await sweepAbandoned();
    await say(app, w, 2, (f) => templateBtn(f, `DECLINE:${w.surveyId}`));
    await say(app, w, 3, (f) => templateBtn(f, `START:${w.surveyId}`));

    const a = await w.owner.get(`/api/surveys/${w.surveyId}/analytics`);
    expect(a.totals).toMatchObject({ sent: 5, started: 3, completed: 1, abandoned: 1, declined: 1, inProgress: 1, noReply: 1 });
    expect(a.totals.completionRate).toBeCloseTo(33.3, 1); // completed ÷ started, per spec
    // sent stays 5 even though most recipients moved past "sent" — the spec's WHERE status IN (sent, delivered) would say 1
    expect(a.totals.sent).toBe(5);
    expect(a.perQuestion[0].distribution.find((d: any) => d.label === 'Very satisfied')).toMatchObject({ count: 1, pct: 50 });
    expect(a.perQuestion[0].abandonedHere).toBe(0);
    expect(a.perQuestion[1].abandonedHere).toBe(1);
    expect(a.dropOff).toMatchObject({ questionNumber: 2, count: 1 });
    expect(a.nonStarters).toHaveLength(1);
  });
});

describe('gifts', () => {
  const airtime = { giftType: 'airtime', giftValue: '500 FCFA airtime', giftAmount: 500, giftDeliveryMode: 'immediate' };

  async function complete(w: Awaited<ReturnType<typeof buildWorld>>, idx: number) {
    const [q1, q2] = w.questions;
    await say(app, w, idx, (f) => templateBtn(f, `START:${w.surveyId}`));
    await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q1!, 0), 'button_reply'));
    await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q2!, 0), 'list_reply'));
    await say(app, w, idx, (f) => textMsg(f, 'done'));
  }

  it('is blocked on Starter/trial (no gift automation, and a free trial must not be able to pay out)', async () => {
    const o = await registerOwner(app, { plan: 'starter' });
    const r = await o.post('/api/surveys', { title: 'T', questions: [{ text: 'q', type: 'text', required: true }], gift: airtime });
    expect(r.status).toBe(402);
    expect(r.error).toBe('plan_feature');
  });

  it('delivers airtime exactly once and ONLY airtime (the spec switch fell through to discount + draw)', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime, wallet: 10_000 });
    await complete(w, 0);
    const gifts = await prisma.giftDelivery.findMany();
    expect(gifts).toHaveLength(1);
    expect(gifts[0]).toMatchObject({ giftType: 'airtime', status: 'pending', amount: 500 });
    expect(await prisma.prizeDrawEntry.count()).toBe(0);
    expect(gifts[0]!.code).toBeNull();
    const thanks = (await chatOf(0)).at(-1).message.body as string;
    expect(thanks).toContain('500 FCFA airtime');
    expect(thanks).not.toMatch(/code/i);

    expect(await processDueGifts()).toBe(1);
    expect(await processDueGifts()).toBe(0); // nothing left to pay
    const done = (await prisma.giftDelivery.findFirst())!;
    expect(done.status).toBe('sent');
    expect(done.providerRef).toMatch(/^mock-airtime-/);
    expect((await chatOf(0)).at(-1).message.body).toMatch(/has been sent/); // follow-up inside the 24h window (free text)
  });

  it('issues unique discount codes inside the thank-you, and prize-draw entries without any payout', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: { giftType: 'discount', giftValue: '10% off your next order' } });
    await complete(w, 0);
    await complete(w, 1);
    const gifts = await prisma.giftDelivery.findMany();
    expect(new Set(gifts.map((g) => g.code)).size).toBe(2);
    expect((await chatOf(0)).at(-1).message.body).toContain(gifts.find((g) => g.contactId === w.contactIds[0])!.code!);
    expect(await processDueGifts()).toBe(0);

    await resetAll();
    const d = await buildWorld(app, { plan: 'growth', gift: { giftType: 'prize_draw', giftValue: 'a smartphone' } });
    await complete(d, 0);
    await complete(d, 1);
    expect(await prisma.prizeDrawEntry.count()).toBe(2);
    const win = await d.owner.post(`/api/surveys/${d.surveyId}/draw`);
    expect(win.winner.name).toMatch(/Contact/);
  });

  it('respects the gift budget cap: later completers get a plain thank-you, never a promise we cannot keep', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: { ...airtime, giftMaxCount: 1 }, wallet: 10_000 });
    await complete(w, 0);
    await complete(w, 1);
    expect(await prisma.giftDelivery.count()).toBe(1);
    expect(((await chatOf(1)).at(-1).message.body as string)).not.toContain('500 FCFA airtime');
  });

  it('never retries an ambiguous provider failure automatically (could pay twice)', async () => {
    const { setGiftProvider, GiftError } = await import('../src/services/gifts/providers');
    const w = await buildWorld(app, { plan: 'growth', gift: airtime, wallet: 10_000 });
    await complete(w, 0);
    let calls = 0;
    setGiftProvider({ name: 'flaky', sendMoMo: async () => ({ providerRef: 'x' }), sendAirtime: async () => { calls++; throw new GiftError('timeout after send', true); } });
    await processDueGifts();
    const g = (await prisma.giftDelivery.findFirst())!;
    expect(g.status).toBe('failed');
    expect(g.errorMessage).toMatch(/ambiguous/);
    await prisma.giftDelivery.update({ where: { id: g.id }, data: { scheduledFor: new Date() } });
    await processDueGifts();
    expect(calls).toBe(1);
    // the owner's "retry failed gifts" action refuses ambiguous ones too
    expect((await w.owner.post(`/api/surveys/${w.surveyId}/gifts/retry`)).requeued).toBe(0);
    setGiftProvider(null);
  });
});

describe('plan limits (402)', () => {
  it('limits active surveys per plan and returns an upgrade hint', async () => {
    const o = await registerOwner(app); // trial: 1 active survey
    const mk = async (title: string) => (await o.post('/api/surveys', { title, questions: [{ text: 'q', type: 'text', required: true }] })).id as string;
    const a = await mk('A');
    const b = await mk('B');
    expect((await o.post(`/api/surveys/${a}/publish`)).status).toBe(200);
    const blocked = await o.post(`/api/surveys/${b}/publish`);
    expect(blocked.status).toBe(402);
    expect(blocked).toMatchObject({ error: 'plan_limit', details: { limit: 'activeSurveys', max: 1, upgrade: { recommendedPlan: 'starter' } } });
  });

  it('blocks a send that would exceed the monthly message quota, but never blocks participants\' answers', async () => {
    const w = await buildWorld(app, { contacts: 3, send: false, plan: 'starter' }); // starter: 1,000 messages
    const { prisma: db } = await import('../src/lib/prisma');
    await db.messageLog.createMany({ data: Array.from({ length: 999 }, () => ({ userId: w.owner.userId, kind: 'invitation' })) });
    const r = await w.owner.post(`/api/surveys/${w.surveyId}/send`, { acceptMarketingCost: true, all: true });
    expect(r.status).toBe(402);
    expect(r.details).toMatchObject({ limit: 'messagesPerMonth', remaining: 1, requested: 3 });
    // answers are NOT gated by quota: an already-invited participant can still finish
    const one = await w.owner.post(`/api/surveys/${w.surveyId}/send`, { acceptMarketingCost: true, contactIds: [w.contactIds[0]] });
    expect(one.status).toBe(200);
    await runSendWorkerOnce();
    await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`));
    expect((await prisma.surveyRecipient.findFirst({ where: { contactId: w.contactIds[0] } }))!.status).toBe('started');
  });

  it('feature-gates Google Sheets to Growth+', async () => {
    const o = await registerOwner(app, { plan: 'starter' });
    const s = await o.post('/api/surveys', { title: 'T', questions: [{ text: 'q', type: 'text', required: true }] });
    const r = await o.post(`/api/surveys/${s.id}/sync/google-sheets`, { autoSync: true });
    expect(r.status).toBe(402);
    expect(r.error).toBe('plan_feature');
  });
});

describe('client isolation', () => {
  it('another owner cannot read, send, or export someone else\'s survey', async () => {
    const w = await buildWorld(app, { send: false });
    const other = client(app, (await registerOwner(app)).token, 'x');
    for (const path of [`/api/surveys/${w.surveyId}`, `/api/surveys/${w.surveyId}/analytics`, `/api/surveys/${w.surveyId}/export/excel`, `/api/surveys/${w.surveyId}/recipients`]) {
      expect((await other.raw('GET', path)).status).toBe(404);
    }
    expect((await other.raw('POST', `/api/surveys/${w.surveyId}/send`, { acceptMarketingCost: true, all: true })).status).toBe(404);
  });
});
