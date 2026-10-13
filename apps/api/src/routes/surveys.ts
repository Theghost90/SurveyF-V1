import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { normalizeQuestion, publishProblems, surveyInputSchema, TEMPLATE_NAMES, type SurveyInput } from '@surveyflow/shared';
import { badRequest, conflict, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { assertCanActivateSurvey, assertCanSendMessages, assertFeature, assertNotSuspended, loadAccount, messagesRemaining } from '../services/subscription/limits';
import { enqueueInvitations, enqueueReminders } from '../services/whatsapp/sender';
import { isTemplateApproved } from '../services/whatsapp/accounts';
import { retryFailedGifts } from '../services/gifts';
import { randomInt } from 'node:crypto';

const GIFT_AUTOMATION = new Set(['airtime', 'momo', 'discount', 'prize_draw']);


type SendSelection = { all?: boolean; contactIds?: string[]; tags?: string[] };

/** Who a send would actually reach: opted-in, not STOPped, and not already invited to this survey. */
async function eligibleContacts(userId: string, surveyId: string, sel: SendSelection) {
  return prisma.contact.findMany({
    where: {
      userId,
      optedOutAt: null,
      consentAt: { not: null }, // WhatsApp policy: only contacts who opted in
      ...(sel.all ? {} : { OR: [...(sel.contactIds?.length ? [{ id: { in: sel.contactIds } }] : []), ...(sel.tags ?? []).map((t) => ({ tags: { array_contains: t } }))] }),
      // Never invite the same person twice.
      NOT: { recipients: { some: { surveyId, status: { notIn: ['queued', 'failed'] } } } },
    },
    select: { id: true },
  });
}

async function owned(userId: string, id: string) {
  const s = await prisma.survey.findFirst({ where: { id, userId }, include: { questions: { orderBy: { order: 'asc' } } } });
  if (!s) throw notFound('Survey');
  return s;
}

function surveyData(input: SurveyInput) {
  return {
    title: input.title,
    description: input.description ?? null,
    language: input.language,
    customThankYou: input.customThankYou ?? null,
    scheduledAt: input.scheduledAt ?? null,
    giftType: input.gift.giftType,
    giftValue: input.gift.giftType === 'none' || input.gift.giftType === 'custom' ? null : (input.gift.giftValue ?? null),
    giftAmountFCFA: input.gift.giftType === 'airtime' || input.gift.giftType === 'momo' ? (input.gift.giftAmountFCFA ?? null) : null,
    giftDeliveryMode: input.gift.giftDeliveryMode,
    giftMaxCount: input.gift.giftMaxCount ?? null,
  };
}

function questionRows(surveyId: string, input: SurveyInput) {
  return input.questions.map((raw, order) => {
    const q = normalizeQuestion(raw);
    return { surveyId, order, text: q.text, type: q.type, options: (q.options ?? undefined) as Prisma.InputJsonValue | undefined, required: q.required };
  });
}

function dto(s: Awaited<ReturnType<typeof owned>>) {
  return {
    id: s.id, title: s.title, description: s.description, status: s.status, language: s.language,
    giftType: s.giftType, giftValue: s.giftValue, giftAmountFCFA: s.giftAmountFCFA, giftDeliveryMode: s.giftDeliveryMode, giftMaxCount: s.giftMaxCount,
    customThankYou: s.customThankYou, scheduledAt: s.scheduledAt, whatsappAccountId: s.whatsappAccountId,
    createdAt: s.createdAt, publishedAt: s.publishedAt, closedAt: s.closedAt,
    questions: s.questions.map((q) => ({ id: q.id, order: q.order, text: q.text, type: q.type, options: q.options, required: q.required })),
  };
}

export default async function surveyRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  app.get('/api/surveys', auth, async (req) => {
    const surveys = await prisma.survey.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { questions: true } } } });
    const groups = await prisma.surveyRecipient.groupBy({ by: ['surveyId', 'status'], where: { survey: { userId: req.userId } }, _count: { _all: true } });
    const stats = new Map<string, { sent: number; started: number; completed: number }>();
    for (const g of groups) {
      const s = stats.get(g.surveyId) ?? { sent: 0, started: 0, completed: 0 };
      if (['sent', 'delivered', 'started', 'completed', 'abandoned', 'declined'].includes(g.status)) s.sent += g._count._all;
      if (['started', 'completed', 'abandoned'].includes(g.status)) s.started += g._count._all;
      if (g.status === 'completed') s.completed += g._count._all;
      stats.set(g.surveyId, s);
    }
    return {
      items: surveys.map((s) => ({
        id: s.id, title: s.title, status: s.status, language: s.language, giftType: s.giftType,
        createdAt: s.createdAt, publishedAt: s.publishedAt, questionCount: s._count.questions,
        ...(stats.get(s.id) ?? { sent: 0, started: 0, completed: 0 }),
      })),
    };
  });

  app.post('/api/surveys', auth, async (req, reply) => {
    const input = surveyInputSchema.parse(req.body);
    await assertGiftAllowed(req.userId, input.gift.giftType);
    const account = await prisma.whatsAppAccount.findFirst({ where: { userId: req.userId, status: 'active' }, orderBy: { createdAt: 'asc' } });
    const survey = await prisma.$transaction(async (tx) => {
      const s = await tx.survey.create({ data: { userId: req.userId, whatsappAccountId: account?.id ?? null, ...surveyData(input) } });
      if (input.questions.length) await tx.question.createMany({ data: questionRows(s.id, input) });
      return s;
    });
    reply.code(201);
    return dto(await owned(req.userId, survey.id));
  });

  app.get('/api/surveys/:id', auth, async (req) => dto(await owned(req.userId, (req.params as { id: string }).id)));

  app.put('/api/surveys/:id', auth, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await owned(req.userId, id);
    const input = surveyInputSchema.parse(req.body);
    await assertGiftAllowed(req.userId, input.gift.giftType);

    // Once a survey has been published, its questions are frozen. Editing them would silently
    // change what already-collected answers mean (labels, option sets, question order).
    const locked = existing.status !== 'draft';
    if (locked) {
      const same =
        input.questions.length === existing.questions.length &&
        input.questions.every((q, i) => {
          const e = existing.questions[i]!;
          return q.text === e.text && q.type === e.type && q.required === e.required && JSON.stringify(normalizeQuestion(q).options ?? null) === JSON.stringify(e.options ?? null);
        });
      if (!same) throw conflict('questions_locked', 'Questions cannot be changed after a survey is published. Duplicate the survey to edit them.');
    }
    await prisma.$transaction(async (tx) => {
      await tx.survey.update({ where: { id }, data: surveyData(input) });
      if (!locked) {
        await tx.question.deleteMany({ where: { surveyId: id } });
        if (input.questions.length) await tx.question.createMany({ data: questionRows(id, input) });
      }
    });
    return dto(await owned(req.userId, id));
  });

  app.delete('/api/surveys/:id', auth, async (req, reply) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    if (s.status === 'active') throw conflict('survey_active', 'Pause or close the survey before deleting it');
    await prisma.survey.delete({ where: { id: s.id } });
    return reply.code(204).send();
  });

  /** Duplicate = the way to "edit" a published survey's questions. */
  app.post('/api/surveys/:id/duplicate', auth, async (req, reply) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    const copy = await prisma.$transaction(async (tx) => {
      const c = await tx.survey.create({
        data: {
          userId: req.userId, title: `${s.title} (copy)`, description: s.description, language: s.language, customThankYou: s.customThankYou,
          giftType: s.giftType, giftValue: s.giftValue, giftAmountFCFA: s.giftAmountFCFA, giftDeliveryMode: s.giftDeliveryMode, giftMaxCount: s.giftMaxCount,
          whatsappAccountId: s.whatsappAccountId,
        },
      });
      await tx.question.createMany({ data: s.questions.map((q) => ({ surveyId: c.id, order: q.order, text: q.text, type: q.type, options: (q.options ?? undefined) as Prisma.InputJsonValue | undefined, required: q.required })) });
      return c;
    });
    reply.code(201);
    return dto(await owned(req.userId, copy.id));
  });

  // ---- lifecycle -------------------------------------------------------------------------------

  app.post('/api/surveys/:id/publish', auth, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    if (s.status !== 'draft') throw conflict('not_a_draft', 'Only drafts can be published');
    const problems = publishProblems(s);
    if (problems.length) throw badRequest('cannot_publish', problems[0], { problems });
    const ctx = await loadAccount(req.userId);
    assertCanActivateSurvey(ctx);
    if (GIFT_AUTOMATION.has(s.giftType)) assertFeature(ctx, 'giftAutomation', 'Gift automation');
    await prisma.survey.update({ where: { id: s.id }, data: { status: 'active', publishedAt: new Date() } });
    return dto(await owned(req.userId, s.id));
  });

  for (const [action, from, to] of [
    ['pause', ['active'], 'paused'],
    ['resume', ['paused'], 'active'],
    ['close', ['active', 'paused'], 'closed'],
  ] as const) {
    app.post(`/api/surveys/:id/${action}`, auth, async (req) => {
      const s = await owned(req.userId, (req.params as { id: string }).id);
      if (!(from as readonly string[]).includes(s.status)) throw conflict('invalid_transition', `A ${s.status} survey cannot be ${action}d`);
      if (action === 'resume') assertCanActivateSurvey(await loadAccount(req.userId));
      await prisma.survey.update({ where: { id: s.id }, data: { status: to, ...(to === 'closed' ? { closedAt: new Date() } : {}) } });
      return dto(await owned(req.userId, s.id));
    });
  }

  // ---- sending -----------------------------------------------------------------------------------

  const sendSchema = z.object({
    all: z.boolean().optional(),
    contactIds: z.array(z.string()).max(20_000).optional(),
    tags: z.array(z.string()).optional(),
    scheduledAt: z.coerce.date().optional(),
  });

  app.post('/api/surveys/:id/send', auth, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    const body = sendSchema.parse(req.body ?? {});
    if (s.status !== 'active') throw conflict('not_active', 'Publish the survey before sending it');
    if (!s.whatsappAccountId) throw conflict('no_whatsapp', 'Connect a WhatsApp number first (Settings → WhatsApp)');
    const account = await prisma.whatsAppAccount.findUnique({ where: { id: s.whatsappAccountId } });
    if (!account || account.status !== 'active') throw conflict('whatsapp_unavailable', 'Your WhatsApp connection needs attention (Settings → WhatsApp)');
    if (!(await isTemplateApproved(account.id, TEMPLATE_NAMES.invitation, s.language))) {
      throw conflict('template_not_approved', 'Your WhatsApp invitation template is still awaiting Meta approval. Try again once it is approved.');
    }
    if (!body.all && !body.contactIds?.length && !body.tags?.length) throw badRequest('no_recipients', 'Choose who to send the survey to');

    const contacts = await eligibleContacts(req.userId, s.id, body);
    if (!contacts.length) throw badRequest('no_eligible_contacts', 'No eligible contacts: they may be opted out, lack consent, or were already invited');

    const ctx = await loadAccount(req.userId);
    assertCanSendMessages(ctx, contacts.length); // 402 with the upgrade hint when over the plan's message quota
    const when = body.scheduledAt && body.scheduledAt > new Date() ? body.scheduledAt : new Date();
    const queued = await enqueueInvitations(s, contacts.map((c) => c.id), when);
    return { queued, scheduledFor: when, messagesRemaining: messagesRemaining(ctx) - queued };
  });

  /** Exact audience for the send panel: how many invitations this selection would queue, and what it costs in quota. */
  app.post('/api/surveys/:id/audience', auth, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    const body = sendSchema.parse(req.body ?? {});
    const eligible = await eligibleContacts(req.userId, s.id, body);
    const ctx = await loadAccount(req.userId);
    const total = await prisma.contact.count({ where: { userId: req.userId } });
    const optedOut = await prisma.contact.count({ where: { userId: req.userId, optedOutAt: { not: null } } });
    return { eligible: eligible.length, totalContacts: total, optedOut, messagesRemaining: messagesRemaining(ctx) };
  });

  app.post('/api/surveys/:id/remind', auth, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    const { target } = z.object({ target: z.enum(['abandoned', 'no_reply']) }).parse(req.body);
    if (s.status !== 'active') throw conflict('not_active', 'The survey must be active to send reminders');
    const ctx = await loadAccount(req.userId);
    assertNotSuspended(ctx);
    const eligible = await prisma.surveyRecipient.count({
      where: { surveyId: s.id, status: { in: target === 'abandoned' ? ['abandoned'] : ['sent', 'delivered'] }, remindedAt: null, contact: { optedOutAt: null } },
    });
    if (!eligible) throw badRequest('nobody_to_remind', 'Nobody is eligible: each participant is reminded at most once');
    assertCanSendMessages(ctx, eligible);
    return { queued: await enqueueReminders(s, target) };
  });

  // ---- gifts -----------------------------------------------------------------------------------------

  app.get('/api/surveys/:id/gifts', auth, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    const items = await prisma.giftDelivery.findMany({ where: { surveyId: s.id }, orderBy: { createdAt: 'desc' }, take: 200, include: { contact: { select: { name: true, phone: true } } } });
    const draw = await prisma.prizeDrawEntry.count({ where: { surveyId: s.id } });
    return {
      drawEntries: draw,
      items: items.map((g) => ({ id: g.id, type: g.giftType, value: g.giftValue, status: g.status, sentAt: g.sentAt, error: g.errorMessage, contact: g.contact.name, code: g.code })),
    };
  });

  app.post('/api/surveys/:id/gifts/retry', auth, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    return { requeued: await retryFailedGifts(s.id) };
  });

  /** Prize draw: cryptographically random pick among entries that have not won yet. */
  app.post('/api/surveys/:id/draw', auth, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    if (s.giftType !== 'prize_draw') throw conflict('not_a_draw', 'This survey has no prize draw');
    const entries = await prisma.prizeDrawEntry.findMany({ where: { surveyId: s.id, isWinner: false }, include: { contact: { select: { name: true, phone: true } } } });
    if (!entries.length) throw badRequest('no_entries', 'No eligible entries');
    const winner = entries[randomInt(entries.length)]!;
    await prisma.prizeDrawEntry.update({ where: { id: winner.id }, data: { isWinner: true } });
    return { winner: { name: winner.contact.name, phone: winner.contact.phone } };
  });

  // ---- recipients --------------------------------------------------------------------------------------

  app.get('/api/surveys/:id/recipients', auth, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    const q = z.object({ status: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
    const where = { surveyId: s.id, ...(q.status ? { status: q.status as never } : {}) };
    const [items, total] = await Promise.all([
      prisma.surveyRecipient.findMany({ where, include: { contact: { select: { name: true, phone: true } } }, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.surveyRecipient.count({ where }),
    ]);
    return { total, items: items.map((r) => ({ id: r.id, status: r.status, name: r.contact.name, phone: r.contact.phone, sentAt: r.sentAt, completedAt: r.completedAt, abandonedAtQuestion: r.abandonedAtQuestion, lastError: r.lastError })) };
  });
}

async function assertGiftAllowed(userId: string, giftType: string) {
  if (GIFT_AUTOMATION.has(giftType)) assertFeature(await loadAccount(userId), 'giftAutomation', 'Gift automation');
}
