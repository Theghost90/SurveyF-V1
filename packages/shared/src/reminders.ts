/**
 * Automatic reminders — the rules, as pure functions (no DB, no clock) so they can be tested to the minute.
 *
 * Why this exists: owners who are not used to surveying often chase people far too fast ("remind them after 24 hours").
 * SurveyFlow therefore decides WHEN a reminder is allowed, not the owner:
 *
 *   NON-RESPONDERS (invited, never tapped Start)
 *     standard rule : ONE warm reminder, between 3 and 5 business days after the invitation.
 *     event rule    : the survey is about a live event happening now / within 7 days → ONE reminder 24 h after the invitation,
 *                     then, if still no answer 24 h after that reminder, ONE closing note that mentions the deadline.
 *   ABANDONERS (started, then went silent for 24 h)
 *     standard rule : ONE reminder 2–3 business days after the survey reached them (never before they were flagged abandoned),
 *                     then, if they have not finished 24 h after the reminder, ONE closing note: thanks, progress is saved.
 *     event rule    : same logic with the urgent timing (reminder as soon as they are flagged, closing note 24 h later,
 *                     the note mentions the deadline).
 *
 * Everyone gets AT MOST: 1 reminder + 1 closing note. Nothing is sent outside 08:00–19:00 local time; the standard rule
 * only runs Monday–Friday. Public holidays are NOT modelled.
 */

export const EVENT_WINDOW_DAYS = 7;
export const SEND_WINDOW = { startHour: 8, endHour: 19 } as const;
export const REMINDER_RULES = {
  nonResponder: { minBusinessDays: 3, maxBusinessDays: 5 },
  abandoner: { minBusinessDays: 2, maxBusinessDays: 3 },
  eventDelayHours: 24,
  followupDelayHours: 24,
} as const;

export const SURVEY_KINDS = ['general', 'event'] as const;
export type SurveyKind = (typeof SURVEY_KINDS)[number];
export type ReminderRule = 'standard' | 'event';
export type ReminderProfile = 'nonResponder' | 'abandoner';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN_LEAD_BEFORE_DEADLINE = 4 * HOUR;

// ---- local time with a fixed UTC offset (no DST in any supported country) ---------------------------------

/** A Date whose UTC fields read as the local wall-clock time. Only ever use getUTC* on the result. */
const toLocal = (d: Date, offsetMin: number) => new Date(d.getTime() + offsetMin * 60_000);
const fromLocal = (l: Date, offsetMin: number) => new Date(l.getTime() - offsetMin * 60_000);
const isBusinessDay = (local: Date) => {
  const day = local.getUTCDay();
  return day >= 1 && day <= 5;
};

/** Same time of day, `n` business days later (Mon–Fri) in local time. */
export function addBusinessDays(d: Date, n: number, offsetMin: number): Date {
  let l = toLocal(d, offsetMin);
  let left = n;
  while (left > 0) {
    l = new Date(l.getTime() + DAY);
    if (isBusinessDay(l)) left--;
  }
  return fromLocal(l, offsetMin);
}

/** 19:00 local on the same local day as `d`. */
export function endOfSendDay(d: Date, offsetMin: number): Date {
  const l = toLocal(d, offsetMin);
  l.setUTCHours(SEND_WINDOW.endHour, 0, 0, 0);
  return fromLocal(l, offsetMin);
}

/**
 * Moves `d` forward to the next moment a message may be sent: inside 08:00–19:00 local and, when `businessOnly`,
 * on a weekday. Never moves backwards.
 */
export function alignToSendWindow(d: Date, offsetMin: number, businessOnly: boolean): Date {
  let l = toLocal(d, offsetMin);
  const h = l.getUTCHours();
  if (h < SEND_WINDOW.startHour) l.setUTCHours(SEND_WINDOW.startHour, 0, 0, 0);
  else if (h >= SEND_WINDOW.endHour) {
    l = new Date(l.getTime() + DAY);
    l.setUTCHours(SEND_WINDOW.startHour, 0, 0, 0);
  }
  while (businessOnly && !isBusinessDay(l)) {
    l = new Date(l.getTime() + DAY);
    l.setUTCHours(SEND_WINDOW.startHour, 0, 0, 0);
  }
  return fromLocal(l, offsetMin);
}

// ---- rules ----------------------------------------------------------------------------------------------

export interface ScheduledSurvey {
  kind: string;
  deadlineAt: Date | null;
}

export interface Slot {
  rule: ReminderRule;
  /** First moment the message may be sent. */
  earliest: Date;
  /** After this the message is stale and is NOT sent (a reminder that arrives too late is worse than none). */
  latest: Date;
}

/** Event rule applies to a live-event survey whose deadline is within a week of the invitation. */
export function usesEventRule(s: ScheduledSurvey, sentAt: Date): boolean {
  if (s.kind !== 'event' || !s.deadlineAt) return false;
  const gap = s.deadlineAt.getTime() - sentAt.getTime();
  return gap > 0 && gap <= EVENT_WINDOW_DAYS * DAY;
}

/** Clamp a slot to the deadline; null when there is no sensible time left to send. */
function withDeadline(slot: Slot, s: ScheduledSurvey, lead = MIN_LEAD_BEFORE_DEADLINE): Slot | null {
  if (!s.deadlineAt) return slot;
  const dl = s.deadlineAt.getTime();
  if (dl - slot.earliest.getTime() < lead) return null;
  return { ...slot, latest: new Date(Math.min(slot.latest.getTime(), dl - HOUR)) };
}

export function nonResponderSlot(sentAt: Date, s: ScheduledSurvey, offsetMin: number): Slot | null {
  if (usesEventRule(s, sentAt)) {
    const earliest = alignToSendWindow(new Date(sentAt.getTime() + REMINDER_RULES.eventDelayHours * HOUR), offsetMin, false);
    return withDeadline({ rule: 'event', earliest, latest: new Date(earliest.getTime() + DAY) }, s);
  }
  const { minBusinessDays, maxBusinessDays } = REMINDER_RULES.nonResponder;
  const earliest = alignToSendWindow(addBusinessDays(sentAt, minBusinessDays, offsetMin), offsetMin, true);
  const latest = endOfSendDay(addBusinessDays(sentAt, maxBusinessDays, offsetMin), offsetMin);
  return withDeadline({ rule: 'standard', earliest, latest }, s);
}

export function abandonerSlot(sentAt: Date, abandonedAt: Date, s: ScheduledSurvey, offsetMin: number): Slot | null {
  if (usesEventRule(s, sentAt)) {
    const earliest = alignToSendWindow(abandonedAt, offsetMin, false);
    return withDeadline({ rule: 'event', earliest, latest: new Date(earliest.getTime() + DAY) }, s);
  }
  const { minBusinessDays, maxBusinessDays } = REMINDER_RULES.abandoner;
  const reached = addBusinessDays(sentAt, minBusinessDays, offsetMin);
  const base = new Date(Math.max(reached.getTime(), abandonedAt.getTime()));
  const earliest = alignToSendWindow(base, offsetMin, true);
  const latest = endOfSendDay(addBusinessDays(earliest, maxBusinessDays - minBusinessDays, offsetMin), offsetMin);
  return withDeadline({ rule: 'standard', earliest, latest }, s);
}

/** Closing note: only abandoners always get one; non-responders get one only under the event rule. */
export type ClosingNote = 'deadline_note' | 'progress_saved' | 'progress_saved_deadline';

export function closingNoteFor(profile: ReminderProfile, rule: ReminderRule): ClosingNote | null {
  if (profile === 'nonResponder') return rule === 'event' ? 'deadline_note' : null;
  return rule === 'event' ? 'progress_saved_deadline' : 'progress_saved';
}

export function followupSlot(reminderAt: Date, profile: ReminderProfile, rule: ReminderRule, s: ScheduledSurvey, offsetMin: number): Slot | null {
  if (!closingNoteFor(profile, rule)) return null;
  const target = new Date(reminderAt.getTime() + REMINDER_RULES.followupDelayHours * HOUR);
  const earliest = alignToSendWindow(target, offsetMin, rule === 'standard');
  // A note that points at a deadline is pointless if the deadline is about to pass.
  return withDeadline({ rule, earliest, latest: new Date(earliest.getTime() + DAY) }, s, 2 * HOUR);
}

// ---- dates for humans -------------------------------------------------------------------------------------

/** "Friday 24 October" / "vendredi 24 octobre", in the owner's local calendar. */
export function formatDeadline(d: Date, offsetMin: number, lang: 'en' | 'fr'): string {
  return new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(toLocal(d, offsetMin));
}

/** The owner picks a calendar date; the deadline is the END of that day (23:59) in their local time. */
export function endOfLocalDay(yyyyMmDd: string, offsetMin: number): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!m) return null;
  const local = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 0);
  return Number.isNaN(local) ? null : new Date(local - offsetMin * 60_000);
}

/** Inverse of endOfLocalDay for pre-filling the date input. */
export function localDateString(d: Date, offsetMin: number): string {
  return toLocal(d, offsetMin).toISOString().slice(0, 10);
}
