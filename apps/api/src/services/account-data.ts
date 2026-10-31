import { env } from '../config/env';
import { keyedHash } from '../lib/crypto';
import { prisma } from '../lib/prisma';
import { audit, type AuditContext } from './audit';
import { sendMail } from './mail';
import { revokeAllSessions } from './security/sessions';

/**
 * The owner's rights over their own account (DAT-01; law 2024/017: erasure s.37 and 38, access s.39, portability s.43), and what has to happen so that neither one
 * becomes a way to lose money or to leak data:
 *
 *   download    one file with everything about the account, built on the spot for a session that has just confirmed it is the owner, e-mailed as an alert,
 *               capped per day, never stored and never behind a link that could be forwarded. It holds no password hash, no secret, no token.
 *   erasure     asked for with a recent "confirm it is you"; REFUSED while money is unresolved (wallet balance, a gift or payment still to be settled), so a
 *               deletion can never swallow somebody's money or a payout in flight; carried out DELETION_GRACE_DAYS later, and cancellable until then.
 *               Meanwhile the account only reads (surveys paused, every change refused but cancelling and downloading), so it cannot keep messaging people.
 *   what stays   the record of money received and paid out, copied to FinancialArchive WITHOUT any name, number or e-mail under a keyed pseudonym, for
 *               FINANCIAL_RETENTION_YEARS; the security audit trail, which holds ids, counts and a coarse place only, until its own retention ends.
 */

const DAY = 86_400_000;
const lang = (l: string): 'en' | 'fr' => (l === 'en' ? 'en' : 'fr');

export interface DeletionBlocker { code: 'wallet_balance' | 'gifts_in_flight' | 'payments_in_flight'; count?: number; amount?: number; currency?: string | null }

/** Why the account cannot be erased right now, in the owner's terms. Empty means it can. */
export async function deletionBlockers(userId: string): Promise<DeletionBlocker[]> {
  const [user, gifts, payments] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { giftBalance: true, giftCurrency: true } }),
    // pending = about to be paid out; unfunded = a promise the owner may still release; both are money decisions that belong to the owner.
    prisma.giftDelivery.count({ where: { survey: { userId }, status: { in: ['pending', 'unfunded'] } } }),
    // pending = the customer may still be paying; review = money received that a person has not decided on yet.
    prisma.paymentTransaction.count({ where: { userId, status: { in: ['pending', 'review'] } } }),
  ]);
  const out: DeletionBlocker[] = [];
  if (user.giftBalance > 0) out.push({ code: 'wallet_balance', amount: user.giftBalance, currency: user.giftCurrency });
  if (gifts) out.push({ code: 'gifts_in_flight', count: gifts });
  if (payments) out.push({ code: 'payments_in_flight', count: payments });
  return out;
}

export async function dataStatus(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { deletionRequestedAt: true, deletionScheduledFor: true } });
  return {
    deletionRequestedAt: u.deletionRequestedAt, deletionScheduledFor: u.deletionScheduledFor, graceDays: env.ACCOUNT_DELETION_GRACE_DAYS,
    blockers: u.deletionScheduledFor ? [] : await deletionBlockers(userId),
    retention: { financialYears: env.FINANCIAL_RETENTION_YEARS, auditDays: env.AUDIT_RETENTION_DAYS },
  };
}

/** How many people the download holds: what the daily cap and the alert e-mail count. */
export const exportRows = (userId: string) => prisma.contact.count({ where: { userId } });

/** Everything about the account, as plain JSON. Explicit selections only: a column added to a table later is not exported until somebody decides it should be. */
export async function buildAccountExport(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const [subscription, payments, wallet, surveys, contacts, gifts, activity, whatsapp] = await Promise.all([
    prisma.subscription.findUnique({ where: { userId } }),
    prisma.paymentTransaction.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.walletEntry.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.survey.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, include: { questions: { orderBy: { order: 'asc' } } } }),
    prisma.contact.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.giftDelivery.findMany({ where: { survey: { userId } }, orderBy: { createdAt: 'asc' } }),
    prisma.auditLog.findMany({ where: { userId }, orderBy: { at: 'asc' }, take: 5000 }),
    prisma.whatsAppAccount.findMany({ where: { userId }, select: { id: true, status: true, displayPhone: true, createdAt: true } }),
  ]);
  const responses = await prisma.response.findMany({ where: { survey: { userId } }, orderBy: { answeredAt: 'asc' } });
  return {
    format: 'surveyflow-account-export', version: 1, exportedAt: new Date().toISOString(),
    note: 'Everything SurveyFlow holds about this account. It contains no password, secret key or access token. Keep this file safe: it holds your participants\' personal data.',
    profile: {
      id: user.id, name: user.name, businessName: user.businessName, email: user.email, phone: user.phone, plan: user.plan, country: user.country, locale: user.locale,
      preferredCurrency: user.preferredCurrency, segment: user.segment, createdAt: user.createdAt, emailVerifiedAt: user.emailVerifiedAt, twoFactorEnabled: !!user.totpEnabledAt,
      walletBalance: user.giftBalance, walletCurrency: user.giftCurrency,
    },
    subscription: subscription && { plan: subscription.plan, status: subscription.status, interval: subscription.interval, currentPeriodStart: subscription.currentPeriodStart, currentPeriodEnd: subscription.currentPeriodEnd, amount: subscription.amountFCFA, paymentMethod: subscription.paymentMethod, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd },
    payments: payments.map((p) => ({ reference: p.reference, purpose: p.purpose, plan: p.plan, interval: p.interval, amount: p.amount, currency: p.currency, status: p.status, provider: p.pspProvider, method: p.method, createdAt: p.createdAt, paidAt: p.paidAt })),
    walletLedger: wallet.map((w) => ({ id: w.id, kind: w.kind, delta: w.delta, balanceAfter: w.balanceAfter, at: w.createdAt })),
    whatsappNumbers: whatsapp,
    surveys: surveys.map((s) => ({
      id: s.id, title: s.title, description: s.description, status: s.status, language: s.language, kind: s.kind, createdAt: s.createdAt, publishedAt: s.publishedAt, closedAt: s.closedAt, deadlineAt: s.deadlineAt,
      customThankYou: s.customThankYou, gift: { type: s.giftType, label: s.giftValue, amount: s.giftAmount, maxCount: s.giftMaxCount, delivery: s.giftDeliveryMode },
      autoRemindNonResponders: s.autoRemindNonResponders, autoRemindAbandoners: s.autoRemindAbandoners,
      questions: s.questions,
    })),
    participants: contacts.map((c) => ({ id: c.id, name: c.name, phone: c.phone, tags: c.tags, consentAt: c.consentAt, consentSource: c.consentSource, optedOutAt: c.optedOutAt, createdAt: c.createdAt })),
    responses: responses.map((r) => ({ surveyId: r.surveyId, participantId: r.contactId, questionId: r.questionId, answer: r.answer, at: r.answeredAt })),
    gifts: gifts.map((g) => ({ surveyId: g.surveyId, participantId: g.contactId, type: g.giftType, value: g.giftValue, status: g.status, amount: g.amount, currency: g.currency, sentAt: g.sentAt })),
    activity: activity.map((a) => ({ at: a.at, action: a.action, place: [a.userAgent, a.ipPrefix].filter(Boolean).join(' · ') || null })),
  };
}

const ownerRef = (userId: string) => keyedHash('financial-archive', userId);

/** Asks for the erasure. Throws a plain Error('blocked') with `.blockers` when money is unresolved. Idempotent while a request is open. */
export async function requestDeletion(userId: string, ctx: AuditContext, sessionId?: string): Promise<{ scheduledFor: Date }> {
  const existing = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, name: true, locale: true, deletionScheduledFor: true } });
  if (existing.deletionScheduledFor) return { scheduledFor: existing.deletionScheduledFor };
  const blockers = await deletionBlockers(userId);
  if (blockers.length) throw Object.assign(new Error('blocked'), { blockers });
  const now = new Date();
  const scheduledFor = new Date(now.getTime() + env.ACCOUNT_DELETION_GRACE_DAYS * DAY);
  await prisma.user.update({ where: { id: userId }, data: { deletionRequestedAt: now, deletionScheduledFor: scheduledFor } });
  // The account stops messaging people at once; the owner can resume surveys by hand if they cancel.
  const paused = await prisma.survey.updateMany({ where: { userId, status: 'active' }, data: { status: 'paused' } });
  const ended = await revokeAllSessions(userId, 'account_deletion', sessionId);
  await audit(ctx, { action: 'account_delete_requested', meta: { scheduledFor: scheduledFor.toISOString(), pausedSurveys: paused.count, endedSessions: ended } });
  await sendMail(existing.email, 'deletion_requested', lang(existing.locale), { name: existing.name, when: scheduledFor.toISOString().slice(0, 10), count: env.ACCOUNT_DELETION_GRACE_DAYS });
  return { scheduledFor };
}

export async function cancelDeletion(userId: string, ctx: AuditContext): Promise<boolean> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, name: true, locale: true, deletionScheduledFor: true } });
  if (!u.deletionScheduledFor) return false;
  await prisma.user.update({ where: { id: userId }, data: { deletionRequestedAt: null, deletionScheduledFor: null } });
  await audit(ctx, { action: 'account_delete_cancelled' });
  await sendMail(u.email, 'deletion_cancelled', lang(u.locale), { name: u.name });
  return true;
}

/**
 * Carries out one erasure that is due. Re-checks the blockers first: money that appeared during the grace period (a payment finished late, a gift settled)
 * postpones the deletion a week and says so in the trail, instead of deleting around it. Returns what happened.
 */
export async function purgeAccount(userId: string, now = new Date()): Promise<'deleted' | 'postponed' | 'gone'> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true, locale: true, deletionScheduledFor: true } });
  if (!u || !u.deletionScheduledFor || u.deletionScheduledFor > now) return 'gone';
  const blockers = await deletionBlockers(userId);
  if (blockers.length) {
    await prisma.user.update({ where: { id: userId }, data: { deletionScheduledFor: new Date(now.getTime() + 7 * DAY) } });
    await audit({ userId }, { action: 'account_delete_postponed', meta: { reasons: blockers.map((b) => b.code).join(',') } });
    return 'postponed';
  }
  const ref = ownerRef(userId);
  const keepUntil = new Date(now.getTime() + env.FINANCIAL_RETENTION_YEARS * 365 * DAY);
  const surveyIds = (await prisma.survey.findMany({ where: { userId }, select: { id: true } })).map((s) => s.id);
  const archived = await prisma.$transaction(async (tx) => {
    const [payments, wallet, gifts] = await Promise.all([
      tx.paymentTransaction.findMany({ where: { userId } }),
      tx.walletEntry.findMany({ where: { userId } }),
      tx.giftDelivery.findMany({ where: { survey: { userId }, status: 'sent', amount: { not: null } } }),
    ]);
    const rows = [
      ...payments.map((p) => ({ kind: 'payment', ref: p.reference, amount: p.amount, currency: p.currency, status: p.status, provider: p.pspProvider, purpose: p.purpose, occurredAt: p.paidAt ?? p.createdAt })),
      ...wallet.map((w) => ({ kind: 'wallet_entry', ref: w.id, amount: w.delta, currency: 'wallet', status: w.kind, provider: null, purpose: null, occurredAt: w.createdAt })),
      ...gifts.map((g) => ({ kind: 'gift_payout', ref: g.providerRef ?? g.id, amount: g.amount!, currency: g.currency, status: g.status, provider: null, purpose: g.giftType, occurredAt: g.sentAt ?? g.createdAt })),
    ].map((r) => ({ ...r, ownerRef: ref, keepUntil }));
    if (rows.length) await tx.financialArchive.createMany({ data: rows });
    if (surveyIds.length) await tx.sheetRow.deleteMany({ where: { surveyId: { in: surveyIds } } });
    await tx.user.delete({ where: { id: userId } }); // every table that holds the owner's data cascades from here
    return rows.length;
  });
  await audit({ userId: null }, { action: 'account_deleted', meta: { ownerRef: ref.slice(0, 16), archivedRows: archived } });
  await sendMail(u.email, 'account_deleted', lang(u.locale), { name: u.name });
  return 'deleted';
}

/** Deletions whose grace period is over, and archive rows past their retention. Called by the hourly retention job. */
export async function runAccountRetention(now = new Date()) {
  const due = await prisma.user.findMany({ where: { deletionScheduledFor: { lte: now } }, select: { id: true }, take: 50 });
  const result = { deleted: 0, postponed: 0 };
  for (const { id } of due) {
    try {
      const r = await purgeAccount(id, now);
      if (r === 'deleted') result.deleted++;
      else if (r === 'postponed') result.postponed++;
    } catch (err) {
      console.error('account purge failed', { userId: id, err: (err as Error).message });
    }
  }
  const archive = await prisma.financialArchive.deleteMany({ where: { keepUntil: { lt: now } } });
  return { ...result, archiveRows: archive.count };
}
