import { Prisma } from '@prisma/client';
import { COUNTRY_CONFIG, TEMPLATE_NAMES, estimateMinutes, formatDeadline, supportedCountry, toWaId, type OutboundMessage } from '@surveyflow/shared';
import { templatePayload } from '@surveyflow/shared';
import { decryptIfEncrypted, encryptSecret } from '../../lib/crypto';
import { redis } from '../../lib/redis';
import { prisma } from '../../lib/prisma';
import { utilityHasChanged } from '../message-category';
import { credsFor } from './accounts';
import { getGateway, WaError, type TemplateSend } from './gateway';

/**
 * Outbound pipeline.
 *   - Business-initiated messages (invitations, reminders, out-of-window gift notices) are
 *     SendJob rows, claimed with FOR UPDATE SKIP LOCKED, rate-limited per WhatsApp number,
 *     and retried with backoff when the failure is transient.
 *   - Replies inside a live conversation are sent inline; if that fails AFTER we committed the
 *     participant's answer, the reply is parked as a `session_message` job so it is never lost.
 */

const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 6 * 3_600_000];
/** Messages per second per WhatsApp number (Cloud API default throughput is 80/s; stay well below). */
const PER_SECOND_PER_NUMBER = 15;
const LEASE_MS = 5 * 60_000;
/** Messages that go to a participant about a survey and therefore only make sense while it is running. */
const SURVEY_KINDS = new Set(['invitation', 'reminder', 'nudge', 'deadline_note', 'progress_saved', 'progress_saved_deadline']);
/** Closing notes: sent once, after an automatic reminder. */
const FOLLOWUP_KINDS = new Set(['deadline_note', 'progress_saved', 'progress_saved_deadline']);

// ---- enqueue --------------------------------------------------------------------------

/** `category` is what the owner was shown and accepted when sending (WA-03): it is kept on the job and decides the template, whatever happens to the survey or to Meta's classification afterwards. */
export async function enqueueInvitations(survey: { id: string; userId: string }, contactIds: string[], scheduledFor: Date, category: 'utility' | 'marketing') {
  let queued = 0;
  for (let i = 0; i < contactIds.length; i += 500) {
    const chunk = contactIds.slice(i, i + 500);
    await prisma.$transaction(async (tx) => {
      for (const contactId of chunk) {
        const recipient = await tx.surveyRecipient.upsert({
          where: { surveyId_contactId: { surveyId: survey.id, contactId } },
          create: { surveyId: survey.id, contactId, status: 'queued' },
          update: {},
          select: { id: true, status: true },
        });
        // Only brand-new (or previously failed) recipients get an invitation; nobody is invited twice.
        if (recipient.status === 'queued' || recipient.status === 'failed') {
          const pending = await tx.sendJob.count({ where: { recipientId: recipient.id, kind: 'invitation', status: { in: ['queued', 'processing'] } } });
          if (pending === 0) {
            await tx.surveyRecipient.update({ where: { id: recipient.id }, data: { status: 'queued', lastError: null } });
            await tx.sendJob.create({ data: { userId: survey.userId, recipientId: recipient.id, kind: 'invitation', scheduledFor, category } });
            queued++;
          }
        }
      }
    });
  }
  return queued;
}

/**
 * A reply parked for retry. The participant's number is stored ENCRYPTED, like the contact's, and the whole payload is dropped once the job is over
 * (below, and by the retention job): a queue row must not become a second, readable copy of the number the contact table protects.
 */
export async function enqueueSessionMessage(userId: string, phoneNumberId: string, to: string, messages: OutboundMessage[]) {
  await prisma.sendJob.create({ data: { userId, kind: 'session_message', payload: { phoneNumberId, to: encryptSecret(to), messages } as unknown as Prisma.InputJsonValue } });
}

export async function enqueueGiftNotice(userId: string, recipientId: string, giftValue: string, receiptToken?: string) {
  await prisma.sendJob.create({ data: { userId, recipientId, kind: 'gift_notice', payload: { giftValue, ...(receiptToken ? { receiptToken } : {}) } } });
}

// ---- inline delivery for live conversations ----------------------------------------------

export async function sendInConversation(
  account: { id: string; userId: string; phoneNumberId: string; wabaId: string; accessToken: string },
  waId: string,
  messages: OutboundMessage[],
  log: { warn: (o: unknown, m?: string) => void } = console as never,
) {
  const gw = getGateway();
  const creds = credsFor(account);
  for (let i = 0; i < messages.length; i++) {
    try {
      await gw.sendMessage(creds, waId, messages[i]!);
    } catch (err) {
      // The participant's state already advanced; park the unsent remainder so it is retried.
      log.warn({ err: (err as Error).message }, 'inline send failed, queueing for retry');
      await enqueueSessionMessage(account.userId, account.phoneNumberId, waId, messages.slice(i));
      return;
    }
  }
}

// ---- worker --------------------------------------------------------------------------------

interface ClaimedJob { id: string; scheduledFor: Date }

async function claimJobs(limit: number): Promise<ClaimedJob[]> {
  return prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "SendJob" SET "status" = 'processing', "lockedAt" = now()
    WHERE "id" IN (
      SELECT "id" FROM "SendJob"
      WHERE ("status" = 'queued' AND "scheduledFor" <= now())
         OR ("status" = 'processing' AND "lockedAt" < now() - (${LEASE_MS / 1000} * interval '1 second'))
      ORDER BY "scheduledFor" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "scheduledFor"`;
}

async function underRateLimit(phoneNumberId: string): Promise<boolean> {
  const key = `sf:rl:${phoneNumberId}:${Math.floor(Date.now() / 1000)}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 3);
  return n <= PER_SECOND_PER_NUMBER;
}

export async function runSendWorkerOnce(batch = 40): Promise<number> {
  const claimed = await claimJobs(batch);
  // RETURNING does not keep the subquery's ORDER BY. Process oldest-first so an invitation / reminder always goes out
  // before the closing note queued after it, even when a stalled worker claims both in one batch.
  claimed.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
  for (const { id } of claimed) await processJob(id);
  return claimed.length;
}

async function finish(id: string, data: Prisma.SendJobUpdateInput) {
  await prisma.sendJob.update({ where: { id }, data: { lockedAt: null, ...data } });
}

async function failOrRetry(id: string, attempts: number, err: unknown, recipientId: string | null) {
  const wa = err instanceof WaError ? err : null;
  const message = (err as Error).message.slice(0, 300);
  const retry = (wa?.transient ?? false) && attempts + 1 < MAX_ATTEMPTS;
  if (retry) {
    await finish(id, { status: 'queued', attempts: attempts + 1, lastError: message, scheduledFor: new Date(Date.now() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!) });
    return;
  }
  await finish(id, { status: 'failed', attempts: attempts + 1, lastError: message });
  if (recipientId) {
    // Funnel state only moves to `failed` if the invitation never went out.
    await prisma.surveyRecipient.updateMany({ where: { id: recipientId, status: 'queued' }, data: { status: 'failed', lastError: message } });
  }
  if (wa?.accountFault) {
    // Expired / revoked token: surface it on the account instead of failing silently forever.
    const job = await prisma.sendJob.findUnique({ where: { id }, include: { recipient: { include: { survey: true } } } });
    const accountId = job?.recipient?.survey.whatsappAccountId;
    if (accountId) await prisma.whatsAppAccount.update({ where: { id: accountId }, data: { status: 'error' } });
  }
}

async function processJob(id: string) {
  const job = await prisma.sendJob.findUnique({
    where: { id },
    include: { recipient: { include: { contact: true, survey: { include: { account: true, user: true, questions: { select: { id: true } } } } } } },
  });
  if (!job || job.status !== 'processing') return;
  const gw = getGateway();

  try {
    if (job.kind === 'session_message') {
      const p = job.payload as unknown as { phoneNumberId: string; to: string; messages: OutboundMessage[] };
      const acct = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId: p.phoneNumberId } });
      if (!acct) return finish(id, { status: 'failed', lastError: 'account_missing' });
      const to = decryptIfEncrypted(p.to); // jobs parked before the number was encrypted hold it plain: still readable
      for (const m of p.messages) await gw.sendMessage(credsFor(acct), to, m);
      return finish(id, { status: 'done', payload: Prisma.DbNull });
    }

    const r = job.recipient;
    if (!r) return finish(id, { status: 'failed', lastError: 'recipient_missing' });
    const { survey, contact } = r;
    const acct = survey.account;
    if (!acct || acct.status === 'disconnected') {
      await prisma.surveyRecipient.updateMany({ where: { id: r.id, status: 'queued' }, data: { status: 'failed', lastError: 'no_whatsapp_account' } });
      return finish(id, { status: 'failed', lastError: 'no_whatsapp_account' });
    }
    if (contact.optedOutAt) {
      await prisma.surveyRecipient.updateMany({ where: { id: r.id, status: 'queued' }, data: { status: 'failed', lastError: 'opted_out' } });
      return finish(id, { status: 'failed', lastError: 'opted_out' });
    }
    if (SURVEY_KINDS.has(job.kind) && survey.status !== 'active') {
      // Paused: try again later. Closed/draft: drop the invitation.
      if (survey.status === 'paused') return finish(id, { status: 'queued', scheduledFor: new Date(Date.now() + 10 * 60_000) });
      await prisma.surveyRecipient.updateMany({ where: { id: r.id, status: 'queued' }, data: { status: 'failed', lastError: 'survey_not_active' } });
      return finish(id, { status: 'failed', lastError: 'survey_not_active' });
    }

    if (!(await underRateLimit(acct.phoneNumberId))) {
      return finish(id, { status: 'queued', scheduledFor: new Date(Date.now() + 1_000) });
    }

    const lang = survey.language === 'en' ? 'en' : 'fr';
    const firstName = contact.name.trim().split(/\s+/)[0] || contact.name;
    let template: TemplateSend;
    if (job.kind === 'invitation') {
      // The category was decided and accepted when the owner sent. A job without one (queued before WA-03) is treated as marketing: the safe direction.
      const utility = job.category === 'utility';
      if (utility && (await utilityHasChanged(acct.id, lang))) {
        // Meta moved the utility template to marketing after the owner accepted the utility rate: sending would bill more than was accepted. Held, and sendable again once accepted.
        await prisma.surveyRecipient.updateMany({ where: { id: r.id, status: 'queued' }, data: { status: 'failed', lastError: 'category_changed' } });
        return finish(id, { status: 'failed', lastError: 'category_changed' });
      }
      template = {
        name: utility ? TEMPLATE_NAMES.invitation : TEMPLATE_NAMES.invitationMarketing, language: lang,
        bodyParams: [firstName, survey.user.businessName, String(estimateMinutes(survey.questions.length))],
        buttonPayloads: [templatePayload('START', survey.id), templatePayload('DECLINE', survey.id)],
      };
    } else if (job.kind === 'reminder') {
      template = { name: TEMPLATE_NAMES.reminder, language: lang, bodyParams: [firstName, survey.user.businessName], buttonPayloads: [templatePayload('CONTINUE', survey.id)] };
    } else if (job.kind === 'nudge') {
      template = {
        name: TEMPLATE_NAMES.nudge, language: lang,
        bodyParams: [firstName, survey.user.businessName, String(estimateMinutes(survey.questions.length))],
        buttonPayloads: [templatePayload('START', survey.id), templatePayload('DECLINE', survey.id)],
      };
    } else if (FOLLOWUP_KINDS.has(job.kind)) {
      const offset = COUNTRY_CONFIG[supportedCountry(survey.user.country)]!.utcOffsetMinutes;
      const needsDate = job.kind !== 'progress_saved';
      if (needsDate && !survey.deadlineAt) return finish(id, { status: 'failed', lastError: 'no_deadline' });
      const date = survey.deadlineAt ? formatDeadline(survey.deadlineAt, offset, lang) : '';
      template = job.kind === 'deadline_note'
        ? { name: TEMPLATE_NAMES.deadlineNote, language: lang, bodyParams: [firstName, survey.user.businessName, date], buttonPayloads: [templatePayload('START', survey.id)] }
        : job.kind === 'progress_saved_deadline'
          ? { name: TEMPLATE_NAMES.progressSavedDeadline, language: lang, bodyParams: [firstName, date], buttonPayloads: [templatePayload('CONTINUE', survey.id)] }
          : { name: TEMPLATE_NAMES.progressSaved, language: lang, bodyParams: [firstName], buttonPayloads: [templatePayload('CONTINUE', survey.id)] };
    } else if (job.kind === 'gift_notice') {
      const p = (job.payload as { giftValue?: string; receiptToken?: string } | null) ?? {};
      const gv = p.giftValue ?? survey.giftValue ?? '';
      // The receipt link exists only for a gift that was actually delivered (the token is minted at delivery).
      template = { name: TEMPLATE_NAMES.giftNotice, language: lang, bodyParams: [firstName, gv], buttonPayloads: [], urlParams: p.receiptToken ? [p.receiptToken] : [] };
    } else {
      return finish(id, { status: 'failed', lastError: `unknown_kind:${job.kind}` });
    }

    const { messageId } = await gw.sendTemplate(credsFor(acct), toWaId(contact.phone), template);
    const kind = job.kind === 'gift_notice' ? 'gift' : job.kind === 'invitation' ? 'invitation' : 'reminder'; // quota: every non-invitation survey message counts as a reminder
    const firstInvitation = job.kind === 'invitation' && (r.status === 'queued' || r.status === 'failed');
    const reInvitation = job.kind === 'invitation' && !firstInvitation;
    await prisma.$transaction([
      prisma.messageLog.create({ data: { userId: survey.userId, kind, waMessageId: messageId } }),
      ...(firstInvitation
        ? [prisma.surveyRecipient.update({ where: { id: r.id }, data: { status: 'sent', sentAt: new Date(), waMessageId: messageId, lastError: null } })]
        : FOLLOWUP_KINDS.has(job.kind) || job.kind === 'nudge'
          ? [] // automatic messages were already recorded (remindedAt / followupAt) when they were claimed and queued
          : reInvitation || job.kind === 'reminder'
            ? // A second nudge: remember it (one per recipient) but never touch the funnel status. An automatic reminder keeps its claim time.
              [prisma.surveyRecipient.update({ where: { id: r.id }, data: { remindedAt: r.remindedAt ?? new Date(), waMessageId: messageId } })]
            : []),
    ]);
    await finish(id, { status: 'done', lastError: null });

    if (gw.mode === 'mock' && job.kind === 'invitation') {
      // Emulate Meta's delivery receipt so the funnel behaves like production in local demos.
      setTimeout(() => void applyDeliveryStatus(messageId, 'delivered').catch(() => undefined), 800);
    }
  } catch (err) {
    await failOrRetry(id, job.attempts, err, job.recipientId);
  }
}

/** Meta `statuses[]` webhook: sent → delivered/read, or failed. Never regresses funnel progress. */
export async function applyDeliveryStatus(waMessageId: string, status: string, errorText?: string) {
  if (status === 'delivered' || status === 'read') {
    await prisma.surveyRecipient.updateMany({ where: { waMessageId, status: 'sent' }, data: { status: 'delivered' } });
  } else if (status === 'failed') {
    await prisma.surveyRecipient.updateMany({ where: { waMessageId, status: { in: ['queued', 'sent'] } }, data: { status: 'failed', lastError: (errorText ?? 'delivery_failed').slice(0, 300) } });
  }
}
