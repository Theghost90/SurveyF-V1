import type { Contact, Prisma, SurveyRecipient, WhatsAppAccount } from '@prisma/client';
import { START_WORDS, STOP_WORDS, fromWaId, parseAnswerId, parseTemplatePayload, sys, type OutboundMessage, type SurveyLang } from '@surveyflow/shared';
import { prisma } from '../../lib/prisma';
import { redis, withLock } from '../../lib/redis';
import { autoSyncCompleted } from '../exports/sheets';
import { planGift, thankYouText } from '../gifts';
import { sendInConversation, applyDeliveryStatus } from '../whatsapp/sender';
import { step, type Inbound, type RuntimeSurvey, type SessionState } from './engine';
import { deleteSession, getSession, saveSession } from './sessions';

/** Subset of Meta's webhook message object that we read. */
export interface WaInboundMessage {
  id: string;
  from: string;
  type: string;
  text?: { body?: string };
  button?: { payload?: string; text?: string };
  interactive?: { type?: string; button_reply?: { id: string; title?: string }; list_reply?: { id: string; title?: string } };
}

interface Logger {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}

// ---- payload fan-out ---------------------------------------------------------------------

/**
 * Handles a full Meta webhook body. Unlike the spec's pseudo-code (which reads only
 * entry[0].changes[0].messages[0]), Meta batches: every entry, change, message and status is processed.
 * Throws if a message could not be processed so the route can answer 500 and Meta retries it.
 */
export async function processWebhookPayload(body: unknown, log: Logger): Promise<void> {
  const entries = (body as { entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: any }> }> })?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      if (change.field === 'message_template_status_update') {
        await onTemplateStatus(entry.id, value);
        continue;
      }
      if (change.field !== 'messages') continue;
      const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      for (const st of (value.statuses ?? []) as Array<{ id: string; status: string; errors?: Array<{ title?: string; message?: string }> }>) {
        await applyDeliveryStatus(st.id, st.status, st.errors?.[0]?.title ?? st.errors?.[0]?.message);
      }
      for (const msg of (value.messages ?? []) as WaInboundMessage[]) {
        await handleMessage(phoneNumberId, msg, log);
      }
    }
  }
}

async function onTemplateStatus(wabaId: string | undefined, v: { event?: string; message_template_name?: string; message_template_language?: string; reason?: string }) {
  if (!wabaId || !v.message_template_name || !v.event) return;
  await prisma.messageTemplate.updateMany({
    where: { account: { wabaId }, name: v.message_template_name, language: (v.message_template_language ?? '').slice(0, 2) },
    data: { status: v.event.toUpperCase(), reason: v.reason && v.reason !== 'NONE' ? v.reason : null },
  });
}

// ---- idempotency ---------------------------------------------------------------------------

const dedupeKey = (id: string) => `sf:wamid:${id}`;
async function claim(id: string) {
  return (await redis.set(dedupeKey(id), 'processing', 'EX', 120, 'NX')) === 'OK';
}
const markDone = (id: string) => redis.set(dedupeKey(id), 'done', 'EX', 7 * 86_400);
const release = (id: string) => redis.del(dedupeKey(id));

// ---- one inbound message -----------------------------------------------------------------

export function normalizeInbound(msg: WaInboundMessage): { inbound: Inbound; surveyId?: string; stop?: boolean } | null {
  if (msg.type === 'button') {
    // Quick-reply button of a TEMPLATE message (invitation / reminder).
    const p = parseTemplatePayload(msg.button?.payload ?? '');
    if (!p) return null; // some other template of the same WABA: not ours
    const kind = p.action === 'START' ? 'start' : p.action === 'DECLINE' ? 'decline' : 'continue';
    return { inbound: { kind }, surveyId: p.surveyId };
  }
  if (msg.type === 'interactive') {
    // NOTE: the spec's pseudo-code reads `interactive.list_reply.id` unconditionally, which throws
    // for reply buttons (`interactive.button_reply`). Both are handled here.
    const id = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id;
    const a = id ? parseAnswerId(id) : null;
    return a ? { inbound: { kind: 'choice', questionId: a.questionId, optionId: a.optionId } } : null;
  }
  if (msg.type === 'text') {
    const body = msg.text?.body ?? '';
    const w = body.trim().toLowerCase();
    return { inbound: { kind: 'text', body }, stop: STOP_WORDS.includes(w) };
  }
  return { inbound: { kind: 'unsupported' } };
}

async function handleMessage(phoneNumberId: string, msg: WaInboundMessage, log: Logger) {
  if (!msg.id || !msg.from) return;
  if (!(await claim(msg.id))) return; // duplicate delivery (Meta retries) — already handled or in flight
  try {
    await withLock(`${phoneNumberId}:${msg.from}`, () => turn(phoneNumberId, msg, log));
    await markDone(msg.id);
  } catch (err) {
    await release(msg.id); // let Meta's retry reprocess it
    throw err;
  }
}

type RecipientWithSurvey = SurveyRecipient & {
  survey: NonNullable<Awaited<ReturnType<typeof loadSurvey>>>;
};

async function loadSurvey(id: string) {
  return prisma.survey.findUnique({
    where: { id },
    include: { questions: { orderBy: { order: 'asc' } }, user: { select: { plan: true, locale: true } } },
  });
}

async function findRecipient(where: Prisma.SurveyRecipientWhereInput, orderBy?: Prisma.SurveyRecipientOrderByWithRelationInput): Promise<RecipientWithSurvey | null> {
  const r = await prisma.surveyRecipient.findFirst({ where, orderBy });
  if (!r) return null;
  const survey = await loadSurvey(r.surveyId);
  return survey ? { ...r, survey } : null;
}

async function turn(phoneNumberId: string, msg: WaInboundMessage, log: Logger) {
  const account = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId }, include: { user: { select: { locale: true } } } });
  if (!account) {
    log.warn({ phoneNumberId }, 'webhook for unknown phone_number_id');
    return;
  }
  // Only people the owner actually imported can interact: no walk-in sessions, no gift farming.
  const contact = await prisma.contact.findUnique({ where: { userId_phone: { userId: account.userId, phone: fromWaId(msg.from) } } });
  if (!contact) return;

  const parsed = normalizeInbound(msg);
  if (!parsed) return;
  const now = new Date();
  let session = await getSession(phoneNumberId, msg.from);

  // ---- opt-out (STOP) ------------------------------------------------------------------------
  if (parsed.stop) {
    await optOut(account, contact, session, msg.from);
    return;
  }

  let inbound = parsed.inbound;
  let recipient: RecipientWithSurvey | null = null;

  // ---- find which survey this message is about -------------------------------------------------
  if (parsed.surveyId) {
    recipient = await findRecipient({ surveyId: parsed.surveyId, contactId: contact.id, survey: { userId: account.userId } });
  } else if (session) {
    recipient = await findRecipient({ id: session.recipientId });
  } else if (inbound.kind === 'text' && START_WORDS.includes(inbound.body.trim().toLowerCase())) {
    inbound = { kind: 'start' };
    recipient = await findRecipient(
      { contactId: contact.id, survey: { userId: account.userId, status: 'active' }, status: { in: ['sent', 'delivered', 'declined', 'abandoned', 'started'] } },
      { sentAt: 'desc' },
    );
  } else if (inbound.kind === 'choice' || inbound.kind === 'text') {
    // Redis was wiped but the participant is mid-survey in SQL: pick the thread back up.
    recipient = await findRecipient({ contactId: contact.id, survey: { userId: account.userId }, status: 'started' }, { startedAt: 'desc' });
  }
  if (!recipient || recipient.survey.userId !== account.userId) return; // not about any survey of this business

  const survey = recipient.survey;
  const lang = (survey.language === 'en' ? 'en' : 'fr') as SurveyLang;

  // An explicit START on another survey replaces an in-progress one (it becomes "abandoned").
  if (session && session.surveyId !== survey.id) {
    await prisma.surveyRecipient.updateMany({
      where: { id: session.recipientId, status: 'started' },
      data: { status: 'abandoned', abandonedAtQuestion: session.currentIndex + 1, abandonedAt: now },
    });
    await deleteSession(phoneNumberId, msg.from);
    session = null;
  }

  const answered = await prisma.response.findMany({ where: { surveyId: survey.id, contactId: contact.id }, select: { questionId: true } });
  const answeredIds = new Set(answered.map((a) => a.questionId));
  const runtime: RuntimeSurvey = {
    id: survey.id, language: lang, status: survey.status,
    questions: survey.questions.map((q) => ({ id: q.id, order: q.order, text: q.text, type: q.type, options: q.options as never, required: q.required })),
  };

  if (!session && recipient.status === 'started' && (inbound.kind === 'choice' || inbound.kind === 'text')) {
    const idx = Math.max(0, runtime.questions.findIndex((q) => !answeredIds.has(q.id)));
    session = {
      surveyId: survey.id, contactId: contact.id, recipientId: recipient.id, phoneNumberId,
      currentIndex: idx, startedAt: (recipient.startedAt ?? now).toISOString(), lastInteractionAt: now.toISOString(),
    };
  }

  const result = step({ survey: runtime, session, recipientStatus: recipient.status, answeredIds, inbound, now });
  const messages: OutboundMessage[] = [...result.messages];
  let nextSession: SessionState | null = result.session
    ? { ...result.session, contactId: contact.id, recipientId: recipient.id, phoneNumberId }
    : null;

  // ---- persist (answer + funnel status + gift) atomically ---------------------------------------
  let completed = false;
  let completedRecipientId: string | null = null;
  await prisma.$transaction(async (tx) => {
    if (result.saveAnswer) {
      await tx.response.upsert({
        where: { surveyId_contactId_questionId: { surveyId: survey.id, contactId: contact.id, questionId: result.saveAnswer.questionId } },
        create: { surveyId: survey.id, contactId: contact.id, questionId: result.saveAnswer.questionId, answer: result.saveAnswer.answer, answeredAt: now },
        update: { answer: result.saveAnswer.answer, answeredAt: now },
      });
    }
    switch (result.event) {
      case 'started':
      case 'resumed':
      case 'repeated':
        await tx.surveyRecipient.updateMany({
          where: { id: recipient!.id, status: { not: 'completed' } },
          data: { status: 'started', startedAt: recipient!.startedAt ?? now, abandonedAtQuestion: null },
        });
        if (contact.optedOutAt) await tx.contact.update({ where: { id: contact.id }, data: { optedOutAt: null, consentAt: now, consentSource: 'whatsapp_start' } });
        break;
      case 'declined':
        await tx.surveyRecipient.updateMany({ where: { id: recipient!.id, status: { in: ['queued', 'sent', 'delivered'] } }, data: { status: 'declined' } });
        break;
      case 'completed': {
        const done = await tx.surveyRecipient.updateMany({
          where: { id: recipient!.id, status: { not: 'completed' } },
          data: { status: 'completed', completedAt: now, startedAt: recipient!.startedAt ?? now, abandonedAtQuestion: null },
        });
        if (done.count === 0) break; // completed by a concurrent delivery: no second gift
        completed = true;
        completedRecipientId = recipient!.id;
        const gift = await planGift(tx, survey, contact);
        messages.push({ kind: 'text', body: thankYouText(survey, gift) });
        break;
      }
    }
  });

  // ---- session (Redis) + reply ------------------------------------------------------------------
  if (nextSession) await saveSession(phoneNumberId, msg.from, nextSession);
  else await deleteSession(phoneNumberId, msg.from);

  if (messages.length) await sendInConversation(account, msg.from, messages, log);
  if (completed && completedRecipientId) {
    autoSyncCompleted(survey.id, contact.id).catch((err) => log.warn({ err: (err as Error).message }, 'sheets auto-sync failed'));
  }
}

async function optOut(account: WhatsAppAccount & { user: { locale: string } }, contact: Contact, session: SessionState | null, waId: string) {
  await prisma.$transaction([
    prisma.contact.update({ where: { id: contact.id }, data: { optedOutAt: new Date() } }),
    prisma.sendJob.updateMany({ where: { status: 'queued', recipient: { contactId: contact.id } }, data: { status: 'failed', lastError: 'opted_out' } }),
    prisma.surveyRecipient.updateMany({ where: { contactId: contact.id, status: 'queued' }, data: { status: 'failed', lastError: 'opted_out' } }),
    ...(session ? [prisma.surveyRecipient.updateMany({ where: { id: session.recipientId, status: 'started' }, data: { status: 'abandoned', abandonedAtQuestion: session.currentIndex + 1 } })] : []),
  ]);
  if (session) await deleteSession(account.phoneNumberId, waId);
  const lang = (account.user.locale === 'en' ? 'en' : 'fr') as SurveyLang;
  await sendInConversation(account, waId, [{ kind: 'text', body: sys(lang).optedOut }]);
}

