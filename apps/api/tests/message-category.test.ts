import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { readMockMailbox } from '../src/services/mail';
import { runSendWorkerOnce } from '../src/services/whatsapp/sender';
import { buildWorld, chatOf, makeApp, postWebhook, resetAll, type World } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
beforeEach(async () => { await resetAll(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });

/**
 * WA-03: the category an invitation goes out under, the cost warning that cannot be skipped, and what happens when Meta re-categorises a template.
 * Containment under test (docs/BACKLOG.md): default to marketing when unsure · wording rules · a cost warning.
 */
const sendTo = (w: World, body: Record<string, unknown> = {}) => w.owner.post(`/api/surveys/${w.surveyId}/send`, { all: true, ...body });
const audience = (w: World) => w.owner.post(`/api/surveys/${w.surveyId}/audience`, { all: true });
const jobs = () => prisma.sendJob.findMany({ where: { kind: 'invitation' }, orderBy: { createdAt: 'asc' } });
const followUp = { followsTransaction: true, title: 'How was your visit?' };
const mailsOf = async (w: World, kind: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: w.owner.userId } });
  return (await readMockMailbox(u.email)).filter((m) => m.kind === kind);
};
const first = (i = 0) => chatOf(i).then((c) => c.find((m) => m.template));

/** The account's utility invitation template as Meta would have stored it (mock mode does not submit templates). */
async function storeUtilityTemplate(w: World, over: Record<string, unknown> = {}) {
  const account = await prisma.whatsAppAccount.findFirstOrThrow({ where: { userId: w.owner.userId } });
  const language = (over.language as string | undefined) ?? 'en';
  const where = { accountId_name_language: { accountId: account.id, name: 'survey_invitation', language } };
  const data = { accountId: account.id, name: 'survey_invitation', language, category: 'UTILITY', status: 'APPROVED', metaTemplateId: '555001', ...over };
  await prisma.messageTemplate.upsert({ where, create: data as never, update: data as never });
  return { account, where };
}
const categoryNotice = (wabaId: string, value: Record<string, unknown>) => ({ object: 'whatsapp_business_account', entry: [{ id: wabaId, changes: [{ field: 'template_category_update', value }] }] });

describe('the default is marketing, and the owner is told what that costs before anything is queued', () => {
  it('a survey that does not say it follows a transaction is refused without the acknowledgement, and nothing is queued', async () => {
    const w = await buildWorld(app, { contacts: 2, send: false });
    const refused = await sendTo(w);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('marketing_cost_unacknowledged');
    expect(refused.body.details).toMatchObject({ category: 'marketing', recipients: 2, reasons: [{ code: 'not_a_follow_up' }] });
    expect(await jobs()).toHaveLength(0);
    expect(await prisma.surveyRecipient.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'survey_sent' } })).toBe(0);
  });

  it('with the acknowledgement it is queued as marketing, sent with the marketing template, and recorded in the audit trail with the reasons', async () => {
    const w = await buildWorld(app, { contacts: 2, send: false });
    const ok = await sendTo(w, { acceptMarketingCost: true });
    expect(ok.status).toBe(200);
    expect(ok.body.category).toBe('marketing');
    expect((await jobs()).map((j) => j.category)).toEqual(['marketing', 'marketing']);
    await runSendWorkerOnce(100);
    expect((await first())!.template.name).toBe('survey_invitation_marketing');
    const [row] = await prisma.auditLog.findMany({ where: { action: 'survey_sent' } });
    expect(row!.meta).toMatchObject({ surveyId: w.surveyId, category: 'marketing', reasons: 'not_a_follow_up', people: 2, acceptedCost: true });
  });

  it('the audience answer carries the category and the reasons, so that the warning is on screen before the owner presses send', async () => {
    const w = await buildWorld(app, { contacts: 1, send: false });
    expect(await audience(w)).toMatchObject({ category: 'marketing', categoryReasons: [{ code: 'not_a_follow_up' }], invitationTemplate: 'survey_invitation_marketing' });
  });
});

describe('utility is earned, never claimed', () => {
  it('a survey that follows a transaction, carries no reward and reads as no promotion is sent as utility without the warning, with the utility template', async () => {
    const w = await buildWorld(app, { contacts: 2, send: false, survey: followUp });
    expect(await audience(w)).toMatchObject({ category: 'utility', categoryReasons: [], invitationTemplate: 'survey_invitation' });
    const ok = await sendTo(w); // no acknowledgement needed
    expect(ok.status).toBe(200);
    expect(ok.body.category).toBe('utility');
    expect((await jobs()).map((j) => j.category)).toEqual(['utility', 'utility']);
    await runSendWorkerOnce(100);
    expect((await first())!.template.name).toBe('survey_invitation');
    const [row] = await prisma.auditLog.findMany({ where: { action: 'survey_sent' } });
    expect(row!.meta).toMatchObject({ category: 'utility', acceptedCost: false });
  });

  it('the owner cannot force it: declaring a follow-up does not help when a reward is attached, or when the text reads as a promotion', async () => {
    const withGift = await buildWorld(app, { contacts: 1, send: false, survey: followUp, gift: { giftType: 'custom', giftValue: null } });
    expect((await audience(withGift)).categoryReasons).toEqual([{ code: 'gift' }]);
    expect((await sendTo(withGift)).body.error).toBe('marketing_cost_unacknowledged');
    await resetAll();
    const promo = await buildWorld(app, { contacts: 1, send: false, survey: { ...followUp, description: 'Get 20% off your next order, special offer!' } });
    const a = await audience(promo);
    expect(a.category).toBe('marketing');
    expect(a.categoryReasons).toEqual([{ code: 'promo_wording', terms: expect.arrayContaining(['% off', 'offer']) }]);
    expect((await sendTo(promo)).status).toBe(409);
  });

  it('the declaration is stored with the survey, comes back in it, and is kept by a copy', async () => {
    const w = await buildWorld(app, { contacts: 1, send: false, survey: followUp });
    expect((await w.owner.get(`/api/surveys/${w.surveyId}`)).followsTransaction).toBe(true);
    const copy = await w.owner.post(`/api/surveys/${w.surveyId}/duplicate`);
    expect(copy.followsTransaction).toBe(true);
    const off = await w.owner.put(`/api/surveys/${w.surveyId}`, { title: 'How was your visit?', language: 'en', followsTransaction: false, questions: (await w.owner.get(`/api/surveys/${w.surveyId}`)).questions });
    expect(off.followsTransaction).toBe(false);
  });
});

describe('Meta re-categorises a template (template_category_update)', () => {
  it('a completed change to marketing is stored, the owner is told once (a repeated notice says nothing more), and every survey of that account now needs the acknowledgement', async () => {
    const w = await buildWorld(app, { contacts: 1, send: false, survey: followUp });
    const { account, where } = await storeUtilityTemplate(w);
    expect((await audience(w)).category).toBe('utility');
    const notice = categoryNotice(account.wabaId!, { message_template_id: 555001, message_template_name: 'survey_invitation', message_template_language: 'en', previous_category: 'UTILITY', new_category: 'MARKETING' });
    expect((await postWebhook(app, notice)).statusCode).toBe(200);
    expect((await postWebhook(app, notice)).statusCode).toBe(200);
    expect(await prisma.messageTemplate.findUniqueOrThrow({ where })).toMatchObject({ category: 'MARKETING', categoryPending: null });
    const mails = await mailsOf(w, 'template_recategorised');
    expect(mails).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: 'template_recategorised' } })).toBe(1);
    const a = await audience(w);
    expect(a.category).toBe('marketing');
    expect(a.categoryReasons).toEqual([{ code: 'meta_recategorised' }]);
    expect((await sendTo(w)).body.error).toBe('marketing_cost_unacknowledged');
    expect((await sendTo(w, { acceptMarketingCost: true })).status).toBe(200);
  });

  it('an announced change is only a warning until it happens: the survey stays utility, the owner is told in advance, once', async () => {
    const w = await buildWorld(app, { contacts: 1, send: false, survey: followUp });
    const { account, where } = await storeUtilityTemplate(w);
    const at = Math.floor(Date.now() / 1000) + 86_400;
    const notice = categoryNotice(account.wabaId!, { message_template_id: 555001, message_template_name: 'survey_invitation', correct_category: 'MARKETING', new_category: 'UTILITY', category_update_timestamp: at });
    expect((await postWebhook(app, notice)).statusCode).toBe(200);
    expect((await postWebhook(app, notice)).statusCode).toBe(200);
    const row = await prisma.messageTemplate.findUniqueOrThrow({ where });
    expect(row).toMatchObject({ category: 'UTILITY', categoryPending: 'MARKETING' });
    expect(row.categoryPendingAt!.getTime()).toBe(at * 1000);
    expect(await mailsOf(w, 'template_recategorised')).toHaveLength(1);
    const a = await audience(w);
    expect(a.category).toBe('utility');
    expect(a.categoryReasons).toEqual([{ code: 'meta_will_recategorise', at: new Date(at * 1000).toISOString() }]);
    // and when it is done, the pending mark is cleared
    await postWebhook(app, categoryNotice(account.wabaId!, { message_template_id: 555001, previous_category: 'UTILITY', new_category: 'MARKETING' }));
    expect(await prisma.messageTemplate.findUniqueOrThrow({ where })).toMatchObject({ category: 'MARKETING', categoryPending: null, categoryPendingAt: null });
  });

  it('a template moving to utility costs nothing more, so nobody is e-mailed; a notice for another account or an unknown template changes nothing', async () => {
    const w = await buildWorld(app, { contacts: 1, send: false });
    const { account, where } = await storeUtilityTemplate(w, { category: 'MARKETING' });
    await postWebhook(app, categoryNotice(account.wabaId!, { message_template_id: 555001, previous_category: 'MARKETING', new_category: 'UTILITY' }));
    expect((await prisma.messageTemplate.findUniqueOrThrow({ where })).category).toBe('UTILITY');
    expect(await mailsOf(w, 'template_recategorised')).toHaveLength(0);
    // another WhatsApp Business account's notice (same template id) does not touch this one; neither does an unknown id
    await postWebhook(app, categoryNotice('SOMEONE-ELSES-WABA', { message_template_id: 555001, previous_category: 'UTILITY', new_category: 'MARKETING' }));
    await postWebhook(app, categoryNotice(account.wabaId!, { message_template_id: 999999, previous_category: 'UTILITY', new_category: 'MARKETING' }));
    await postWebhook(app, categoryNotice(account.wabaId!, {}));
    expect((await prisma.messageTemplate.findUniqueOrThrow({ where })).category).toBe('UTILITY');
  });

  it('the template is found by name when the notice has no id, and by language when it gives one', async () => {
    const w = await buildWorld(app, { contacts: 1, send: false });
    const { account } = await storeUtilityTemplate(w);
    await storeUtilityTemplate(w, { language: 'fr', metaTemplateId: '555002' });
    await postWebhook(app, categoryNotice(account.wabaId!, { message_template_name: 'survey_invitation', message_template_language: 'fr', previous_category: 'UTILITY', new_category: 'MARKETING' }));
    const rows = await prisma.messageTemplate.findMany({ where: { name: 'survey_invitation' }, orderBy: { language: 'asc' } });
    expect(rows.map((r) => [r.language, r.category])).toEqual([['en', 'UTILITY'], ['fr', 'MARKETING']]);
  });

  it('an invitation queued as utility is NOT sent as marketing if Meta moved the template after the owner sent: it is held as failed, and can be sent again once the cost is accepted', async () => {
    const w = await buildWorld(app, { contacts: 2, send: false, survey: followUp });
    const { account } = await storeUtilityTemplate(w);
    expect((await sendTo(w)).status).toBe(200); // utility, no warning
    await postWebhook(app, categoryNotice(account.wabaId!, { message_template_id: 555001, previous_category: 'UTILITY', new_category: 'MARKETING' }));
    await runSendWorkerOnce(100);
    expect((await chatOf(0)).filter((m) => m.template)).toHaveLength(0); // nothing went out at a rate nobody accepted
    expect((await jobs()).map((j) => [j.status, j.lastError])).toEqual([['failed', 'category_changed'], ['failed', 'category_changed']]);
    expect((await prisma.surveyRecipient.findMany()).map((r) => [r.status, r.lastError])).toEqual([['failed', 'category_changed'], ['failed', 'category_changed']]);
    // sending again needs the acknowledgement, and then goes out as marketing
    expect((await sendTo(w)).body.error).toBe('marketing_cost_unacknowledged');
    expect((await sendTo(w, { acceptMarketingCost: true })).status).toBe(200);
    await runSendWorkerOnce(100);
    expect((await first(0))!.template.name).toBe('survey_invitation_marketing');
  });

  it('a job from before the category existed is treated as marketing, the safe direction', async () => {
    const w = await buildWorld(app, { contacts: 1, send: false });
    expect((await sendTo(w, { acceptMarketingCost: true })).status).toBe(200);
    await prisma.sendJob.updateMany({ where: { kind: 'invitation' }, data: { category: null } });
    await runSendWorkerOnce(100);
    expect((await first())!.template.name).toBe('survey_invitation_marketing');
  });
});
