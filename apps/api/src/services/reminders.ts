import type { Prisma } from '@prisma/client';
import {
  COUNTRY_CONFIG, abandonerSlot, closingNoteFor, followupSlot, nonResponderSlot, supportedCountry,
  type ReminderProfile, type ReminderRule, type Slot,
} from '@surveyflow/shared';
import { prisma } from '../lib/prisma';
import { assertNotSuspended, loadAccount, messagesRemaining } from './subscription/limits';

/**
 * Automatic reminders. The RULES (who, when, how many) live in packages/shared/src/reminders.ts as pure functions; this file
 * only finds candidates, asks the rules whether *now* is allowed, and queues the message exactly once.
 *
 * Guarantees:
 *  - each recipient gets at most ONE automatic reminder and ONE closing note (compare-and-set on remindedAt / followupAt);
 *  - nothing is sent unless the survey is active, the matching switch is still on, the contact has consented and not opted out,
 *    and the plan still has message quota;
 *  - a reminder that missed its window (worker down, quota empty) is dropped, never sent late.
 */

const HOUR = 3_600_000;
const LOOKBACK_MS = 21 * 24 * HOUR;
const MAX_PER_SURVEY = 2_000;

export interface AutoReminderResult { reminders: number; followups: number; closed: number }

/** Surveys whose deadline has passed stop sending and close; the engine then answers late taps with "This survey has ended". */
export async function closeExpiredSurveys(now = new Date()): Promise<number> {
  const r = await prisma.survey.updateMany({ where: { status: { in: ['active', 'paused'] }, deadlineAt: { lte: now } }, data: { status: 'closed', closedAt: now } });
  return r.count;
}

type JobKind = 'nudge' | 'reminder' | 'deadline_note' | 'progress_saved' | 'progress_saved_deadline';

async function queueOnce(
  tx: Prisma.TransactionClient, userId: string, recipientId: string, statuses: Array<'sent' | 'delivered' | 'abandoned'>, kind: JobKind,
  mark: { field: 'remindedAt'; rule: ReminderRule; auto?: boolean } | { field: 'followupAt' }, now: Date,
): Promise<boolean> {
  const claimed = await tx.surveyRecipient.updateMany({
    where: { id: recipientId, status: { in: statuses }, ...(mark.field === 'remindedAt' ? { remindedAt: null } : { followupAt: null }) },
    data: mark.field === 'remindedAt' ? { remindedAt: now, reminderRule: mark.rule, reminderAuto: mark.auto ?? true } : { followupAt: now },
  });
  if (!claimed.count) return false;
  await tx.sendJob.create({ data: { userId, recipientId, kind, scheduledFor: now } });
  return true;
}

const inWindow = (slot: Slot | null, now: Date): slot is Slot => !!slot && now >= slot.earliest && now <= slot.latest;

export async function runAutoReminders(now = new Date()): Promise<AutoReminderResult> {
  const closed = await closeExpiredSurveys(now);
  const surveys = await prisma.survey.findMany({
    where: { status: 'active', whatsappAccountId: { not: null }, OR: [{ autoRemindNonResponders: true }, { autoRemindAbandoners: true }] },
    include: { user: { select: { id: true, country: true } } },
  });

  const budget = new Map<string, number>(); // remaining template messages this period, per owner
  const remaining = async (userId: string): Promise<number> => {
    if (!budget.has(userId)) {
      try {
        const ctx = await loadAccount(userId);
        assertNotSuspended(ctx);
        budget.set(userId, messagesRemaining(ctx));
      } catch {
        budget.set(userId, 0); // suspended accounts send nothing
      }
    }
    return budget.get(userId)!;
  };

  let reminders = 0;
  let followups = 0;
  const lookback = new Date(now.getTime() - LOOKBACK_MS);
  const eligibleContact = { optedOutAt: null, consentAt: { not: null } } as const;

  for (const s of surveys) {
    const offset = COUNTRY_CONFIG[supportedCountry(s.user.country)]!.utcOffsetMinutes;
    const sv = { kind: s.kind, deadlineAt: s.deadlineAt };
    const spend = async (): Promise<boolean> => {
      const left = await remaining(s.userId);
      if (left <= 0) return false;
      budget.set(s.userId, left - 1);
      return true;
    };

    // ---- 1. reminders -------------------------------------------------------------------------------
    if (s.autoRemindNonResponders) {
      const rows = await prisma.surveyRecipient.findMany({
        where: { surveyId: s.id, status: { in: ['sent', 'delivered'] }, remindedAt: null, sentAt: { gte: lookback, lte: new Date(now.getTime() - 20 * HOUR) }, contact: eligibleContact },
        select: { id: true, sentAt: true }, orderBy: { sentAt: 'asc' }, take: MAX_PER_SURVEY,
      });
      for (const r of rows) {
        const slot = nonResponderSlot(r.sentAt!, sv, offset);
        if (!inWindow(slot, now) || !(await spend())) continue;
        if (await prisma.$transaction((tx) => queueOnce(tx, s.userId, r.id, ['sent', 'delivered'], 'nudge', { field: 'remindedAt', rule: slot.rule }, now))) reminders++;
        else budget.set(s.userId, (await remaining(s.userId)) + 1); // lost the race: give the unit back
      }
    }
    if (s.autoRemindAbandoners) {
      const rows = await prisma.surveyRecipient.findMany({
        where: { surveyId: s.id, status: 'abandoned', remindedAt: null, abandonedAt: { gte: lookback }, contact: eligibleContact },
        select: { id: true, sentAt: true, createdAt: true, abandonedAt: true }, orderBy: { abandonedAt: 'asc' }, take: MAX_PER_SURVEY,
      });
      for (const r of rows) {
        const slot = abandonerSlot(r.sentAt ?? r.createdAt, r.abandonedAt!, sv, offset);
        if (!inWindow(slot, now) || !(await spend())) continue;
        if (await prisma.$transaction((tx) => queueOnce(tx, s.userId, r.id, ['abandoned'], 'reminder', { field: 'remindedAt', rule: slot.rule }, now))) reminders++;
        else budget.set(s.userId, (await remaining(s.userId)) + 1);
      }
    }

    // ---- 2. closing notes: 24 h after an AUTOMATIC reminder that nobody acted on -------------------------
    const due = await prisma.surveyRecipient.findMany({
      where: {
        surveyId: s.id, reminderAuto: true, followupAt: null, status: { in: ['sent', 'delivered', 'abandoned'] },
        remindedAt: { not: null, gte: lookback, lte: new Date(now.getTime() - 20 * HOUR) }, contact: eligibleContact,
      },
      select: { id: true, status: true, remindedAt: true, reminderRule: true }, orderBy: { remindedAt: 'asc' }, take: MAX_PER_SURVEY,
    });
    for (const r of due) {
      const profile: ReminderProfile = r.status === 'abandoned' ? 'abandoner' : 'nonResponder';
      if (profile === 'abandoner' ? !s.autoRemindAbandoners : !s.autoRemindNonResponders) continue; // owner switched it off meanwhile
      const rule: ReminderRule = r.reminderRule === 'event' ? 'event' : 'standard';
      const note = closingNoteFor(profile, rule);
      const slot = followupSlot(r.remindedAt!, profile, rule, sv, offset);
      if (!note || !inWindow(slot, now) || !(await spend())) continue;
      const statuses = profile === 'abandoner' ? (['abandoned'] as const) : (['sent', 'delivered'] as const);
      if (await prisma.$transaction((tx) => queueOnce(tx, s.userId, r.id, [...statuses], note, { field: 'followupAt' }, now))) followups++;
      else budget.set(s.userId, (await remaining(s.userId)) + 1);
    }
  }
  return { reminders, followups, closed };
}

// ---- manual reminders (the owner's "Remind" buttons) -----------------------------------------------------------------------

export type ManualTarget = 'abandoned' | 'no_reply';

export interface ManualReminderState {
  /** Recipients whose automatic window has opened: the only ones a manual reminder may reach. */
  ready: Array<{ id: string; rule: ReminderRule }>;
  /** Eligible people whose window has not opened yet (or never will: deadline too close). */
  waiting: number;
  /** When the first waiting person's window opens. */
  nextAt: Date | null;
}

/**
 * The owner's manual buttons follow the SAME clock as the automatic reminders: nobody can be reminded before their window
 * opens (3 business days after the invitation, 2 after an abandonment, 24 h for a live event). Once it has opened a manual
 * reminder may go at any time, but still at most one per person (the claim in queueOnce).
 */
export async function manualReminderState(surveyId: string, target: ManualTarget, now = new Date()): Promise<ManualReminderState> {
  const s = await prisma.survey.findUnique({ where: { id: surveyId }, include: { user: { select: { country: true } } } });
  if (!s) return { ready: [], waiting: 0, nextAt: null };
  const offset = COUNTRY_CONFIG[supportedCountry(s.user.country)]!.utcOffsetMinutes;
  const sv = { kind: s.kind, deadlineAt: s.deadlineAt };
  const rows = await prisma.surveyRecipient.findMany({
    where: { surveyId, status: { in: target === 'abandoned' ? ['abandoned'] : ['sent', 'delivered'] }, remindedAt: null, contact: { optedOutAt: null } },
    select: { id: true, sentAt: true, createdAt: true, abandonedAt: true }, take: MAX_PER_SURVEY,
  });
  const ready: ManualReminderState['ready'] = [];
  let waiting = 0;
  let nextAt: Date | null = null;
  for (const r of rows) {
    const sent = r.sentAt ?? r.createdAt;
    const slot = target === 'abandoned' ? abandonerSlot(sent, r.abandonedAt ?? sent, sv, offset) : nonResponderSlot(sent, sv, offset);
    if (slot && now >= slot.earliest) { ready.push({ id: r.id, rule: slot.rule }); continue; }
    waiting++;
    if (slot && (!nextAt || slot.earliest < nextAt)) nextAt = slot.earliest;
  }
  return { ready, waiting, nextAt };
}

/** Queues a manual reminder for everyone whose window is open. Same once-only claim and the same templates as the automatic ones. */
export async function sendManualReminders(survey: { id: string; userId: string }, target: ManualTarget, now = new Date()): Promise<{ queued: number; waiting: number; nextAt: Date | null }> {
  const state = await manualReminderState(survey.id, target, now);
  let queued = 0;
  for (const r of state.ready) {
    const ok = await prisma.$transaction((tx) => queueOnce(
      tx, survey.userId, r.id, target === 'abandoned' ? ['abandoned'] : ['sent', 'delivered'], target === 'abandoned' ? 'reminder' : 'nudge',
      { field: 'remindedAt', rule: r.rule, auto: false }, now,
    ));
    if (ok) queued++;
  }
  return { queued, waiting: state.waiting, nextAt: state.nextAt };
}
