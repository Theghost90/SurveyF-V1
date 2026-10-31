import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PAID_GIFT_TYPES, currencyLabel, normalizeQuestion, publishProblems, surveyInputSchema, TEMPLATE_NAMES, walletLimits, type SurveyInput } from '@surveyflow/shared';
import { badRequest, conflict, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { assertCanActivateSurvey, assertCanAddRecipients, assertCanSendMessages, assertFeature, assertNotSuspended, freshRecipientCount, loadAccount, messagesRemaining, recipientsRemaining } from '../services/subscription/limits';
import { enqueueInvitations } from '../services/whatsapp/sender';
import { manualReminderState, sendManualReminders } from '../services/reminders';
import { isTemplateApproved } from '../services/whatsapp/accounts';
import { assertNoGiftsInFlight, releaseUnfundedGifts, retryFailedGifts } from '../services/gifts';
import { walletCurrency, walletQuote } from '../services/billing-currency';
import { giftReadiness } from '../services/wallet';
import { receiptUrl } from '../services/receipts';
import { randomInt } from 'node:crypto';
import { AppError } from '../lib/errors';
import { track } from '../services/funnel';
import { assertWhatsAppConnected } from '../services/whatsapp/require';
import { maskPhone } from '@surveyflow/shared';
import { audit, auditContext, auditStrict } from '../services/audit';
import { invitationPlan } from '../services/message-category';

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
    giftAmount: input.gift.giftType === 'airtime' || input.gift.giftType === 'momo' ? (input.gift.giftAmount ?? null) : null,
    giftDeliveryMode: input.gift.giftDeliveryMode,
    giftMaxCount: input.gift.giftMaxCount ?? null,
    kind: input.kind,
    followsTransaction: input.followsTransaction,
    deadlineAt: input.deadlineAt ?? null,
    autoRemindNonResponders: input.autoRemindNonResponders,
    autoRemindAbandoners: input.autoRemindAbandoners,
  };
}

/** A deadline that is already behind us would close the survey on the next tick: refuse it unless it is the one already stored. */
function assertDeadlineOk(next: Date | null | undefined, previous?: Date | null) {
  if (next && next.getTime() <= Date.now() && next.getTime() !== previous?.getTime()) throw badRequest('deadline_past', 'The deadline must be in the future');
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
    giftType: s.giftType, giftValue: s.giftValue, giftAmount: s.giftAmount, giftDeliveryMode: s.giftDeliveryMode, giftMaxCount: s.giftMaxCount,
    customThankYou: s.customThankYou, scheduledAt: s.scheduledAt, whatsappAccountId: s.whatsappAccountId,
    kind: s.kind, followsTransaction: s.followsTransaction, deadlineAt: s.deadlineAt, autoRemindNonResponders: s.autoRemindNonResponders, autoRemindAbandoners: s.autoRemindAbandoners,
    createdAt: s.createdAt, publishedAt: s.publishedAt, closedAt: s.closedAt,
    questions: s.questions.map((q) => ({ id: q.id, order: q.order, text: q.text, type: q.type, options: q.options, required: q.required })),
  };
}

export default async function surveyRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };
  // Publishing, sending, reminding and paying out gifts act on other people and on money: they need a confirmed e-mail address.
  const authVerified = { preHandler: app.authenticateVerified };

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
        id: s.id, title: s.title, status: s.status, language: s.language, giftType: s.giftType, kind: s.kind, deadlineAt: s.deadlineAt,
        createdAt: s.createdAt, publishedAt: s.publishedAt, questionCount: s._count.questions,
        ...(stats.get(s.id) ?? { sent: 0, started: 0, completed: 0 }),
      })),
    };
  });

  app.post('/api/surveys', auth, async (req, reply) => {
    await assertWhatsAppConnected(req.userId);
    const input = surveyInputSchema.parse(req.body);
    assertDeadlineOk(input.deadlineAt);
    await assertGiftAllowed(req.userId, input.gift);
    const account = await prisma.whatsAppAccount.findFirst({ where: { userId: req.userId, status: 'active' }, orderBy: { createdAt: 'asc' } });
    const survey = await prisma.$transaction(async (tx) => {
      const s = await tx.survey.create({ data: { userId: req.userId, whatsappAccountId: account?.id ?? null, ...surveyData(input) } });
      if (input.questions.length) await tx.question.createMany({ data: questionRows(s.id, input) });
      return s;
    });
    await track(req.userId, 'survey_created');
    reply.code(201);
    return dto(await owned(req.userId, survey.id));
  });

  app.get('/api/surveys/:id', auth, async (req) => dto(await owned(req.userId, (req.params as { id: string }).id)));

  app.put('/api/surveys/:id', auth, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await owned(req.userId, id);
    const input = surveyInputSchema.parse(req.body);
    assertDeadlineOk(input.deadlineAt, existing.deadlineAt);
    await assertGiftAllowed(req.userId, input.gift);

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
    await assertNoGiftsInFlight({ surveyId: s.id });
    await prisma.survey.delete({ where: { id: s.id } });
    return reply.code(204).send();
  });

  /** Duplicate = the way to "edit" a published survey's questions. */
  app.post('/api/surveys/:id/duplicate', auth, async (req, reply) => {
    await assertWhatsAppConnected(req.userId);
    const s = await owned(req.userId, (req.params as { id: string }).id);
    const copy = await prisma.$transaction(async (tx) => {
      const c = await tx.survey.create({
        data: {
          userId: req.userId, title: `${s.title} (copy)`, description: s.description, language: s.language, customThankYou: s.customThankYou,
          giftType: s.giftType, giftValue: s.giftValue, giftAmount: s.giftAmount, giftDeliveryMode: s.giftDeliveryMode, giftMaxCount: s.giftMaxCount,
          whatsappAccountId: s.whatsappAccountId, kind: s.kind, followsTransaction: s.followsTransaction, autoRemindNonResponders: s.autoRemindNonResponders, autoRemindAbandoners: s.autoRemindAbandoners,
        },
      });
      await tx.question.createMany({ data: s.questions.map((q) => ({ surveyId: c.id, order: q.order, text: q.text, type: q.type, options: (q.options ?? undefined) as Prisma.InputJsonValue | undefined, required: q.required })) });
      return c;
    });
    reply.code(201);
    return dto(await owned(req.userId, copy.id));
  });

  // ---- lifecycle -------------------------------------------------------------------------------

  app.post('/api/surveys/:id/publish', authVerified, async (req) => {
    await assertWhatsAppConnected(req.userId);
    const s = await owned(req.userId, (req.params as { id: string }).id);
    if (s.status !== 'draft') throw conflict('not_a_draft', 'Only drafts can be published');
    const problems = publishProblems(s);
    if (problems.length) throw badRequest('cannot_publish', problems[0], { problems });
    const ctx = await loadAccount(req.userId);
    assertCanActivateSurvey(ctx);
    if (GIFT_AUTOMATION.has(s.giftType)) assertFeature(ctx, 'giftAutomation', 'Gift automation');
    await prisma.survey.update({ where: { id: s.id }, data: { status: 'active', publishedAt: new Date() } });
    // Non-blocking: publishing with an empty wallet is legitimate (top up next), but never silently.
    const gift = await giftReadiness(req.userId, s);
    return { ...dto(await owned(req.userId, s.id)), giftWarning: gift?.empty ? { code: 'gift_wallet_empty', ...gift } : null };
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
    /** The owner has seen the marketing-message cost warning and accepts it (WA-03). Required whenever the invitation goes out as marketing. */
    acceptMarketingCost: z.boolean().optional(),
  });

  app.post('/api/surveys/:id/send', authVerified, async (req) => {
    await assertWhatsAppConnected(req.userId);
    const s = await owned(req.userId, (req.params as { id: string }).id);
    const body = sendSchema.parse(req.body ?? {});
    if (s.status !== 'active') throw conflict('not_active', 'Publish the survey before sending it');
    if (!s.whatsappAccountId) throw conflict('whatsapp_not_connected', 'Finish connecting your WhatsApp Business number first.');
    const account = await prisma.whatsAppAccount.findUnique({ where: { id: s.whatsappAccountId } });
    if (!account || account.status !== 'active') throw conflict('whatsapp_unavailable', 'Your WhatsApp connection needs attention (Settings → WhatsApp)');
    const plan = await invitationPlan(s, account.id);
    if (!(await isTemplateApproved(account.id, plan.templateName, s.language))) {
      throw conflict('template_not_approved', 'Your WhatsApp invitation template is still awaiting Meta approval. Try again once it is approved.');
    }
    if (!body.all && !body.contactIds?.length && !body.tags?.length) throw badRequest('no_recipients', 'Choose who to send the survey to');

    const contacts = await eligibleContacts(req.userId, s.id, body);
    if (!contacts.length) throw badRequest('no_eligible_contacts', 'No eligible contacts: they may be opted out, lack consent, or were already invited');
    // Marketing messages cost more, and Meta bills them to the owner: the owner has to have seen that, every time, before anything is queued (WA-03).
    if (plan.category === 'marketing' && !body.acceptMarketingCost) {
      throw new AppError(409, 'marketing_cost_unacknowledged', 'These invitations are sent as marketing messages, which Meta bills at a higher rate than utility messages. Confirm that you accept this cost to send.', { category: plan.category, reasons: plan.reasons, recipients: contacts.length });
    }

    const ctx = await loadAccount(req.userId);
    try {
      await assertCanAddRecipients(ctx, contacts.map((c) => c.id)); // Explore: 5 people in all; the wall is here, at the moment they want to reach everyone
      assertCanSendMessages(ctx, contacts.length); // 402 with the upgrade hint when over the plan's message quota
    } catch (err) {
      if (err instanceof AppError && err.status === 402) await track(req.userId, 'paywall_view', { code: err.code });
      throw err;
    }
    const when = body.scheduledAt && body.scheduledAt > new Date() ? body.scheduledAt : new Date();
    const queued = await enqueueInvitations(s, contacts.map((c) => c.id), when, plan.category);
    await audit(auditContext(req), { action: 'survey_sent', meta: { surveyId: s.id, category: plan.category, reasons: plan.reasons.map((r) => r.code).join(','), people: queued, acceptedCost: plan.category === 'marketing' } });
    await track(req.userId, 'first_send', { plan: ctx.plan.key });
    const gift = await giftReadiness(req.userId, s, queued);
    return { queued, category: plan.category, scheduledFor: when, messagesRemaining: messagesRemaining(ctx) - queued, gift, giftWarning: gift && !gift.sufficient ? { code: gift.empty ? 'gift_wallet_empty' : 'gift_wallet_low', ...gift } : null };
  });

  /** Exact audience for the send panel: how many invitations this selection would queue, and what it costs in quota. */
  app.post('/api/surveys/:id/audience', auth, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    const body = sendSchema.parse(req.body ?? {});
    const eligible = await eligibleContacts(req.userId, s.id, body);
    const ctx = await loadAccount(req.userId);
    const total = await prisma.contact.count({ where: { userId: req.userId } });
    const optedOut = await prisma.contact.count({ where: { userId: req.userId, optedOutAt: { not: null } } });
    // Explore reaches a fixed number of different people: say how many are left and how many of THIS audience are new people.
    const newPeople = ctx.plan.limits.recipients === null ? 0 : await freshRecipientCount(req.userId, eligible.map((c) => c.id));
    // The category the invitation would go out under, and why, so that the cost warning is on screen BEFORE the owner presses send.
    const plan = await invitationPlan(s, s.whatsappAccountId);
    return { eligible: eligible.length, totalContacts: total, optedOut, messagesRemaining: messagesRemaining(ctx), recipientsRemaining: recipientsRemaining(ctx), newPeople, gift: await giftReadiness(req.userId, s, eligible.length), category: plan.category, categoryReasons: plan.reasons, invitationTemplate: plan.templateName };
  });

  app.post('/api/surveys/:id/remind', authVerified, async (req) => {
    await assertWhatsAppConnected(req.userId);
    const s = await owned(req.userId, (req.params as { id: string }).id);
    const { target } = z.object({ target: z.enum(['abandoned', 'no_reply']) }).parse(req.body);
    if (s.status !== 'active') throw conflict('not_active', 'The survey must be active to send reminders');
    const ctx = await loadAccount(req.userId);
    assertNotSuspended(ctx);
    const state = await manualReminderState(s.id, target);
    if (!state.ready.length) {
      // Waiting people exist but their window has not opened: say so (and when), instead of the generic "nobody".
      if (state.waiting > 0) throw conflict('reminder_not_yet', 'It is too early to remind these people: the reminder window has not opened yet', { waiting: state.waiting, availableAt: state.nextAt });
      throw badRequest('nobody_to_remind', 'Nobody is eligible: each participant is reminded at most once');
    }
    assertCanSendMessages(ctx, state.ready.length);
    return sendManualReminders(s, target);
  });

  // ---- gifts -----------------------------------------------------------------------------------------

  app.get('/api/surveys/:id/gifts', auth, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    const paid = { surveyId: s.id, giftType: { in: [...PAID_GIFT_TYPES] } };
    const [items, draw, byStatus, held, owner] = await Promise.all([
      prisma.giftDelivery.findMany({ where: { surveyId: s.id }, orderBy: { createdAt: 'desc' }, take: 200, include: { contact: { select: { name: true, phone: true } } } }),
      prisma.prizeDrawEntry.count({ where: { surveyId: s.id } }),
      prisma.giftDelivery.groupBy({ by: ['status'], where: paid, _count: { _all: true }, _sum: { amount: true, fee: true } }),
      // unknown outcome: debited and deliberately never auto-refunded or retried
      prisma.giftDelivery.aggregate({ where: { ...paid, status: 'failed', refundedAt: null }, _count: { _all: true }, _sum: { amount: true, fee: true } }),
      prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { giftCurrency: true, preferredCurrency: true, country: true } }),
    ]);
    // What this survey has cost the owner so far = delivered + in the provider pipeline + unknown-outcome (debited, not refunded).
    const cost = (statuses: string[]) => byStatus.filter((g) => statuses.includes(g.status)).reduce((a, g) => ({ count: a.count + g._count._all, amount: a.amount + (g._sum.amount ?? 0) + (g._sum.fee ?? 0) }), { count: 0, amount: 0 });
    const failed = cost(['failed']);
    const needsCheck = { count: held._count._all, amount: (held._sum.amount ?? 0) + (held._sum.fee ?? 0) };
    return {
      drawEntries: draw,
      currency: walletCurrency(owner), // every amount below is in the owner's wallet currency
      money: {
        sent: cost(['sent']), inFlight: cost(['pending']), unfunded: cost(['unfunded']),
        failedRefunded: failed.count - needsCheck.count,            // definite failures: money went back to the wallet
        needsCheck,                                                  // unknown outcome: still debited, never auto-retried
      },
      items: items.map((g) => ({
        id: g.id, type: g.giftType, value: g.giftValue, status: g.status, sentAt: g.sentAt, error: g.errorMessage, contact: g.contact.name, code: g.code,
        cost: g.amount ? g.amount + g.fee : null, refunded: !!g.refundedAt,
        // Only for a gift that was really delivered (the endpoint enforces the same rule).
        receiptUrl: g.status === 'sent' && g.amount && (PAID_GIFT_TYPES as readonly string[]).includes(g.giftType) ? receiptUrl(g.id) : null,
      })),
    };
  });

  /** Re-queue definitely-failed gifts (re-debits the wallet; stops being possible when the balance cannot cover them). */
  app.post('/api/surveys/:id/gifts/retry', authVerified, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    return retryFailedGifts(s.id);
  });

  /** After a top-up: pay the backlog of participants who finished while the wallet was empty. Explicit, never automatic. */
  app.post('/api/surveys/:id/gifts/release', authVerified, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    return releaseUnfundedGifts(s.id);
  });

  /** Prize draw: cryptographically random pick among entries that have not won yet. */
  app.post('/api/surveys/:id/draw', auth, async (req) => {
    const s = await owned(req.userId, (req.params as { id: string }).id);
    if (s.giftType !== 'prize_draw') throw conflict('not_a_draw', 'This survey has no prize draw');
    const entries = await prisma.prizeDrawEntry.findMany({ where: { surveyId: s.id, isWinner: false }, include: { contact: { select: { name: true, phone: true } } } });
    if (!entries.length) throw badRequest('no_entries', 'No eligible entries');
    const winner = entries[randomInt(entries.length)]!;
    // The winner's number is the one number shown in full without a reveal (the owner has to contact them): one person, and the trail says so.
    await auditStrict(auditContext(req), { action: 'prize_draw_winner_shown', targetType: 'contact', targetId: winner.contactId });
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
    return { total, items: items.map((r) => ({ id: r.id, contactId: r.contactId, status: r.status, name: r.contact.name, phone: maskPhone(r.contact.phone), sentAt: r.sentAt, completedAt: r.completedAt, abandonedAtQuestion: r.abandonedAtQuestion, lastError: r.lastError })) };
  });
}

/**
 * Gifts need the plan feature, and a paid gift's amount must sit inside the limits of the owner's wallet currency (100–20,000 FCFA
 * converted at the live rate and tidied: e.g. 200–50,000 NGN). The range is currency-aware, so it cannot live in the shared schema.
 */
async function assertGiftAllowed(userId: string, gift: { giftType: string; giftAmount?: number | null }) {
  if (GIFT_AUTOMATION.has(gift.giftType)) assertFeature(await loadAccount(userId), 'giftAutomation', 'Gift automation');
  if ((gift.giftType === 'airtime' || gift.giftType === 'momo') && gift.giftAmount) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { giftCurrency: true, preferredCurrency: true, country: true } });
    const { giftMin, giftMax } = walletLimits(await walletQuote(user));
    if (gift.giftAmount < giftMin || gift.giftAmount > giftMax) {
      throw badRequest('gift_amount_range', `The gift amount must be between ${giftMin.toLocaleString('en')} and ${giftMax.toLocaleString('en')} ${currencyLabel(walletCurrency(user))}`, { min: giftMin, max: giftMax, currency: walletCurrency(user) });
    }
  }
}
