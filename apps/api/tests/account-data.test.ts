import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { purgeAccount, runAccountRetention } from '../src/services/account-data';
import { runRetention } from '../src/jobs/retention';
import { readMockMailbox } from '../src/services/mail';
import { TEST_PASSWORD, buildWorld, fundWallet, makeApp, registerOwner, resetAll, type Client } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
beforeEach(async () => { await resetAll(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });

const DAY = 86_400_000;
const emailOf = async (c: Client) => (await prisma.user.findUniqueOrThrow({ where: { id: c.userId } })).email;
const mails = async (email: string, kind: string) => (await readMockMailbox(email)).filter((m) => m.kind === kind);
const confirm = (c: Client) => c.post('/api/auth/step-up', { method: 'password', secret: TEST_PASSWORD });
const audits = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { at: 'asc' } });

/**
 * DAT-01 (law 2024/017 s.37 to 43): the owner can take everything out and ask for the account to be erased. These tests hold the containment as much as the right:
 * a stolen session cannot do either without confirming it is the owner; an erasure can never swallow money or a payout in flight; it waits 30 days and can be
 * cancelled; the account only reads meanwhile; what outlives it is the record of money without a name or a number.
 */
describe('the whole-account download', () => {
  it('needs a recent "confirm it is you", then sends one file with the account and the participants, built on the spot', async () => {
    const w = await buildWorld(app, { contacts: 3 });
    const early = await w.owner.raw('POST', '/api/account/export');
    expect(early.status).toBe(403);
    expect(early.json.error).toBe('step_up_required');
    expect((await confirm(w.owner)).status).toBe(200);
    const res = await w.owner.raw('POST', '/api/account/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="surveyflow-account-\d{4}-\d\d-\d\d\.json"/);
    expect(res.headers['cache-control']).toBe('no-store');
    const file = res.json;
    expect(file).toMatchObject({ format: 'surveyflow-account-export', version: 1 });
    expect(file.profile.email).toBe(await emailOf(w.owner));
    expect(file.participants).toHaveLength(3);
    expect(file.participants[0]).toMatchObject({ name: 'Contact 1', phone: '+237677100000' });
    expect(file.surveys).toHaveLength(1);
    expect(file.surveys[0].questions.length).toBeGreaterThan(1);
    expect(file.activity.length).toBeGreaterThan(0);
  });

  it('holds no password hash, no secret, no token and no key: only what an explicit selection lets through', async () => {
    const w = await buildWorld(app, { contacts: 1 });
    await confirm(w.owner);
    const text = (await w.owner.raw('POST', '/api/account/export')).rawBody.toString('utf8');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: w.owner.userId } });
    expect(text).not.toContain(user.passwordHash!);
    expect(text).not.toMatch(/passwordHash|totpSecret|refreshHash|accessToken|phoneHash|emailCanonical|\$argon2/);
    const acct = await prisma.whatsAppAccount.findFirstOrThrow({ where: { userId: w.owner.userId } });
    expect(text).not.toContain(acct.accessToken);
  });

  it('is e-mailed to the owner as an alert, written to the audit trail before it exists, counted, and capped per day', async () => {
    const w = await buildWorld(app, { contacts: 2 });
    await confirm(w.owner);
    expect((await w.owner.raw('POST', '/api/account/export')).status).toBe(200);
    expect(await mails(await emailOf(w.owner), 'export_alert')).toHaveLength(1);
    const rows = await audits('account_export');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ people: 2 });
    for (let i = 1; i < env.ACCOUNT_EXPORT_PER_DAY; i++) expect((await w.owner.raw('POST', '/api/account/export')).status).toBe(200);
    const over = await w.owner.raw('POST', '/api/account/export');
    expect(over.status).toBe(429);
    expect(over.json.error).toBe('export_cap');
  });

  it('is not shut out by the daily rows cap: an owner with more people than the cap can still take their own data (law s.43), and those rows count against today\'s other downloads', async () => {
    const w = await buildWorld(app, { contacts: 3 });
    await confirm(w.owner);
    const saved = env.EXPORT_DAILY_ROWS;
    env.EXPORT_DAILY_ROWS = 2; // fewer than the owner's 3 people
    try {
      expect((await w.owner.raw('POST', '/api/account/export')).status).toBe(200);
      const other = await w.owner.raw('GET', `/api/surveys/${w.surveyId}/export/excel`);
      expect(other.status).toBe(429); // the shared cap now holds every other download of the day
    } finally { env.EXPORT_DAILY_ROWS = saved; }
  });

  it('is refused to an address that is not confirmed, and to somebody who is not signed in', async () => {
    const o = await registerOwner(app, { verified: false });
    expect((await o.raw('POST', '/api/account/export')).status).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/account/export' })).statusCode).toBe(401);
  });
});

describe('asking for the erasure', () => {
  it('needs "confirm it is you" and the word DELETE; then it is scheduled 30 days ahead, surveys are paused, other sessions end, and the owner is told', async () => {
    const w = await buildWorld(app, { contacts: 1 });
    expect((await w.owner.raw('POST', '/api/account/delete', { confirm: 'delete' })).status).toBe(400);
    const early = await w.owner.raw('POST', '/api/account/delete', { confirm: 'DELETE' });
    expect(early.status).toBe(403);
    expect(early.json.error).toBe('step_up_required');
    await confirm(w.owner);
    const before = Date.now();
    const res = await w.owner.raw('POST', '/api/account/delete', { confirm: 'DELETE' });
    expect(res.status).toBe(200);
    const when = new Date(res.json.scheduledFor).getTime();
    expect(when).toBeGreaterThan(before + env.ACCOUNT_DELETION_GRACE_DAYS * DAY - 60_000);
    expect(when).toBeLessThan(Date.now() + env.ACCOUNT_DELETION_GRACE_DAYS * DAY + 60_000);
    expect((await prisma.survey.findMany({ where: { userId: w.owner.userId } })).every((s) => s.status === 'paused')).toBe(true);
    expect(await mails(await emailOf(w.owner), 'deletion_requested')).toHaveLength(1);
    expect(await audits('account_delete_requested')).toHaveLength(1);
    expect(await prisma.user.count({ where: { id: w.owner.userId } })).toBe(1); // nothing is deleted yet
  });

  it('is REFUSED while the wallet holds money, a gift is waiting to be paid or a payment is still open: an erasure never swallows money', async () => {
    const w = await buildWorld(app, { contacts: 1, wallet: 5_000 });
    await confirm(w.owner);
    const a = await w.owner.raw('POST', '/api/account/delete', { confirm: 'DELETE' });
    expect(a.status).toBe(409);
    expect(a.json.error).toBe('account_delete_blocked');
    expect(a.json.details.blockers.map((b: { code: string }) => b.code)).toContain('wallet_balance');
    await prisma.user.update({ where: { id: w.owner.userId }, data: { giftBalance: 0 } });
    await prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[0]!, giftType: 'airtime', status: 'pending', amount: 500 } });
    const b = await w.owner.raw('POST', '/api/account/delete', { confirm: 'DELETE' });
    expect(b.json.details.blockers.map((x: { code: string }) => x.code)).toEqual(['gifts_in_flight']);
    await prisma.giftDelivery.deleteMany({ where: { surveyId: w.surveyId } });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: w.owner.userId } });
    await prisma.paymentTransaction.create({ data: { subscriptionId: sub.id, userId: w.owner.userId, pspProvider: 'mock', amount: 1000, currency: 'XAF', status: 'review', reference: 'sf-review-1', method: 'mobile_money' } });
    const c = await w.owner.raw('POST', '/api/account/delete', { confirm: 'DELETE' });
    expect(c.json.details.blockers.map((x: { code: string }) => x.code)).toEqual(['payments_in_flight']);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: w.owner.userId } }).then((u) => u.deletionScheduledFor)).toBeNull();
  });
});

describe('the grace period', () => {
  async function scheduled() {
    const w = await buildWorld(app, { contacts: 2 });
    await confirm(w.owner);
    expect((await w.owner.raw('POST', '/api/account/delete', { confirm: 'DELETE' })).status).toBe(200);
    return w;
  }

  it('the account only reads: changes are refused (423) except downloading, cancelling and the sign-in endpoints, and reading still works', async () => {
    const w = await scheduled();
    expect((await w.owner.raw('GET', '/api/surveys')).status).toBe(200);
    expect((await w.owner.raw('GET', '/api/account/data')).json.deletionScheduledFor).toBeTruthy();
    for (const [m, u, body] of [['POST', '/api/contacts', { name: 'X', phone: '+237677999999', consent: true }], ['POST', `/api/surveys/${w.surveyId}/send`, { acceptMarketingCost: true, all: true }], ['PUT', `/api/surveys/${w.surveyId}`, {}], ['DELETE', `/api/contacts/${w.contactIds[0]}`, undefined]] as const) {
      const r = await w.owner.raw(m, u, body);
      expect([r.status, r.json?.error], `${m} ${u}`).toEqual([423, 'account_pending_deletion']);
    }
    await confirm(w.owner); // sign-in endpoints stay open
    expect((await w.owner.raw('POST', '/api/account/export')).status).toBe(200);
  });

  it('cancelling keeps everything, lifts the freeze, tells the owner, and leaves the surveys paused for the owner to resume', async () => {
    const w = await scheduled();
    const res = await w.owner.raw('POST', '/api/account/delete/cancel');
    expect(res.json.cancelled).toBe(true);
    expect(await prisma.contact.count({ where: { userId: w.owner.userId } })).toBe(2);
    expect((await w.owner.raw('POST', '/api/contacts', { name: 'Y', phone: '+237677888888', consent: true })).status).toBe(201);
    expect((await prisma.survey.findFirstOrThrow({ where: { userId: w.owner.userId } })).status).toBe('paused');
    expect(await mails(await emailOf(w.owner), 'deletion_cancelled')).toHaveLength(1);
    expect((await w.owner.raw('POST', '/api/account/delete/cancel')).json.cancelled).toBe(false); // nothing left to cancel
  });

  it('nothing is erased before the date, however often the retention job runs', async () => {
    const w = await scheduled();
    await runRetention();
    await runAccountRetention(new Date(Date.now() + (env.ACCOUNT_DELETION_GRACE_DAYS - 1) * DAY));
    expect(await prisma.user.count({ where: { id: w.owner.userId } })).toBe(1);
  });
});

describe('the erasure itself', () => {
  async function due(wallet = 0) {
    const w = await buildWorld(app, { contacts: 2, wallet: wallet || undefined });
    // Some money history, as a long-standing owner would have: a paid plan and a top-up that was spent in full.
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: w.owner.userId } });
    await prisma.paymentTransaction.create({ data: { subscriptionId: sub.id, userId: w.owner.userId, pspProvider: 'mock', amount: 39000, currency: 'XAF', status: 'success', reference: 'sf-paid-1', method: 'mobile_money', phone: '+237677000001', paidAt: new Date() } });
    await prisma.walletEntry.create({ data: { userId: w.owner.userId, delta: 5000, balanceAfter: 5000, kind: 'topup', refId: 'sf-paid-1' } });
    await prisma.walletEntry.create({ data: { userId: w.owner.userId, delta: -5000, balanceAfter: 0, kind: 'gift_debit', refId: 'g1' } });
    await prisma.giftDelivery.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[0]!, giftType: 'airtime', status: 'sent', amount: 5000, providerRef: 'prov-1', sentAt: new Date() } });
    await confirm(w.owner);
    expect((await w.owner.raw('POST', '/api/account/delete', { confirm: 'DELETE' })).status).toBe(200);
    return w;
  }
  const later = () => new Date(Date.now() + (env.ACCOUNT_DELETION_GRACE_DAYS + 1) * DAY);

  it('erases the account and everything it held, and the owner is told it is done', async () => {
    const w = await due();
    const email = await emailOf(w.owner);
    expect(await purgeAccount(w.owner.userId, later())).toBe('deleted');
    expect(await prisma.user.count({ where: { id: w.owner.userId } })).toBe(0);
    for (const n of [prisma.survey.count({ where: { userId: w.owner.userId } }), prisma.contact.count({ where: { userId: w.owner.userId } }), prisma.response.count({ where: { surveyId: w.surveyId } }), prisma.giftDelivery.count({ where: { surveyId: w.surveyId } }), prisma.authSession.count({ where: { userId: w.owner.userId } }), prisma.whatsAppAccount.count({ where: { userId: w.owner.userId } })]) expect(await n).toBe(0);
    expect(await mails(email, 'account_deleted')).toHaveLength(1);
    const rows = await audits('account_deleted');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBeNull();
    expect(JSON.stringify(rows[0]!.meta)).not.toContain(email);
  });

  it('keeps the record of money, and only that: no name, no number, no e-mail, under a pseudonym that is not the account id', async () => {
    const w = await due();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: w.owner.userId } });
    await purgeAccount(w.owner.userId, later());
    const archive = await prisma.financialArchive.findMany();
    expect(archive.map((a) => a.kind).sort()).toEqual(['gift_payout', 'payment', 'wallet_entry', 'wallet_entry']);
    expect(archive.find((a) => a.kind === 'payment')).toMatchObject({ ref: 'sf-paid-1', amount: 39000, currency: 'XAF', status: 'success', provider: 'mock' });
    const text = JSON.stringify(archive);
    for (const secret of [user.email, user.name, user.businessName, user.phone, '+237677000001', 'Contact 1', w.owner.userId]) expect(text, secret).not.toContain(secret);
    expect(new Set(archive.map((a) => a.ownerRef)).size).toBe(1);
    const keep = archive[0]!.keepUntil.getTime();
    expect(keep).toBeGreaterThan(Date.now() + (env.FINANCIAL_RETENTION_YEARS * 365 - 3) * DAY);
  });

  it('postpones, and says so, when money appeared during the grace period: it never deletes around it', async () => {
    const w = await due();
    await prisma.user.update({ where: { id: w.owner.userId }, data: { giftBalance: 700 } });
    expect(await purgeAccount(w.owner.userId, later())).toBe('postponed');
    expect(await prisma.user.count({ where: { id: w.owner.userId } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: w.owner.userId } })).deletionScheduledFor!.getTime()).toBeGreaterThan(later().getTime());
    expect(await audits('account_delete_postponed')).toHaveLength(1);
    expect(await prisma.financialArchive.count()).toBe(0);
  });

  it('is done by the hourly retention job, and the archive rows are removed when their retention is over', async () => {
    const w = await due();
    await prisma.user.update({ where: { id: w.owner.userId }, data: { deletionScheduledFor: new Date(Date.now() - 1000) } });
    const r = await runRetention();
    expect(r.accountsDeleted).toBe(1);
    expect(await prisma.financialArchive.count()).toBeGreaterThan(0);
    const swept = await runAccountRetention(new Date(Date.now() + (env.FINANCIAL_RETENTION_YEARS * 365 + 2) * DAY));
    expect(swept.archiveRows).toBeGreaterThan(0);
    expect(await prisma.financialArchive.count()).toBe(0);
  });

  it('cannot be started by somebody else\'s session, and a deletion request cannot be forged without the word and the confirmation', async () => {
    const a = await registerOwner(app);
    const b = await registerOwner(app);
    await confirm(a);
    expect((await b.raw('POST', '/api/account/delete', { confirm: 'DELETE' })).status).toBe(403); // b never confirmed: a's confirmation is not b's
    expect((await a.raw('POST', '/api/account/delete', {})).status).toBe(400);
    expect(await prisma.user.count({ where: { deletionScheduledFor: { not: null } } })).toBe(0);
    void fundWallet; // the helper stays imported for the money cases above
  });
});
