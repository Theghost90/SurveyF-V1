import { dropSuggestion, maskPhone } from '@surveyflow/shared';
import { prisma } from '../lib/prisma';
import { notFound } from '../lib/errors';
import { manualReminderState } from './reminders';

/**
 * Analytics (spec §7 + "ANALYTICS CALCULATIONS"), with these corrections to the spec's formulas:
 *
 *  1. totalSent = COUNT WHERE status IN (sent, delivered) is wrong: `status` is funnel progress, so
 *     everyone who has since started/completed no longer matches, "sent" would shrink as people
 *     reply and "noReply = sent − started" would go negative. Here `sent` is every recipient whose
 *     invitation actually went out, whatever they did afterwards.
 *  2. noReply = people still in sent/delivered (spec: sent − started, which double-counts
 *     participants who tapped "Not now" as non-responders).
 *  3. Percentages of a question's answers are relative to the answers to THAT question
 *     (the spec's mockup percentages do not add up).
 *  4. A contact who replied STOP is never "no reply": they are counted apart (`optedOut`) and left out of every list, so the owner
 *     is not shown (or reminded about) someone who asked not to be contacted. Every row adds up:
 *       started = completed + in progress + abandoned      sent = started + no reply + declined + opted out
 *  5. The advice at the worst drop-off question follows one rule (shared/dropSuggestion), here and in the Analytics Bot.
 */

const SENT = ['sent', 'delivered', 'started', 'completed', 'abandoned', 'declined'] as const;
const STARTED = ['started', 'completed', 'abandoned'] as const;

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

export interface DistributionEntry { label: string; count: number; pct: number }

/**
 * `people: false` is the version for a team viewer (BIZ-04): every count, distribution and free-text answer, but no name and no number next to any of them, and not the
 * list of people who never replied. The shape is the same, so the page works; the fields that would name somebody are empty.
 */
export async function computeAnalytics(surveyId: string, userId: string, opts: { people?: boolean } = {}) {
  const people = opts.people !== false;
  const survey = await prisma.survey.findFirst({
    where: { id: surveyId, userId },
    include: { questions: { orderBy: { order: 'asc' } } },
  });
  if (!survey) throw notFound('Survey');

  const [statusGroups, abandonGroups, responseGroups, giftGroups, avgRow, daily] = await Promise.all([
    prisma.surveyRecipient.groupBy({ by: ['status'], where: { surveyId }, _count: { _all: true } }),
    prisma.surveyRecipient.groupBy({ by: ['abandonedAtQuestion'], where: { surveyId, status: 'abandoned' }, _count: { _all: true } }),
    prisma.response.groupBy({ by: ['questionId', 'answer'], where: { surveyId }, _count: { _all: true } }),
    prisma.giftDelivery.groupBy({ by: ['status'], where: { surveyId }, _count: { _all: true } }),
    prisma.$queryRaw<Array<{ avg: number | null }>>`
      SELECT AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")))::float AS avg
      FROM "SurveyRecipient" WHERE "surveyId" = ${surveyId} AND "status" = 'completed' AND "startedAt" IS NOT NULL`,
    prisma.$queryRaw<Array<{ day: Date; n: bigint }>>`
      SELECT date_trunc('day', "completedAt") AS day, COUNT(*)::bigint AS n
      FROM "SurveyRecipient"
      WHERE "surveyId" = ${surveyId} AND "status" = 'completed' AND "completedAt" > now() - interval '14 days'
      GROUP BY 1 ORDER BY 1`,
  ]);

  const byStatus: Record<string, number> = {};
  for (const g of statusGroups) byStatus[g.status] = g._count._all;
  const sum = (keys: readonly string[]) => keys.reduce((a, k) => a + (byStatus[k] ?? 0), 0);

  const totalSent = sum(SENT);
  const totalStarted = sum(STARTED);
  const totalCompleted = byStatus.completed ?? 0;
  const totalAbandoned = byStatus.abandoned ?? 0;
  const totalDeclined = byStatus.declined ?? 0;
  const waiting = (byStatus.sent ?? 0) + (byStatus.delivered ?? 0);
  const optedOut = waiting === 0 ? 0 : await prisma.surveyRecipient.count({ where: { surveyId, status: { in: ['sent', 'delivered'] }, contact: { optedOutAt: { not: null } } } });
  const noReply = waiting - optedOut;
  const inProgress = byStatus.started ?? 0;

  // ---- per question -------------------------------------------------------------------------
  const answersByQuestion = new Map<string, Array<{ answer: string; count: number }>>();
  for (const g of responseGroups) {
    const list = answersByQuestion.get(g.questionId) ?? [];
    list.push({ answer: g.answer, count: g._count._all });
    answersByQuestion.set(g.questionId, list);
  }
  const abandonedAt = new Map<number, number>();
  for (const g of abandonGroups) if (g.abandonedAtQuestion) abandonedAt.set(g.abandonedAtQuestion, g._count._all);

  const perQuestion = await Promise.all(
    survey.questions.map(async (q, i) => {
      const rows = answersByQuestion.get(q.id) ?? [];
      const skipped = rows.filter((r) => r.answer === '').reduce((a, r) => a + r.count, 0);
      const answered = rows.filter((r) => r.answer !== '').reduce((a, r) => a + r.count, 0);
      const options = (q.options as Array<{ id: string; label: string }> | null) ?? [];

      let distribution: DistributionEntry[] = [];
      let average: number | null = null;
      let texts: Array<{ answer: string; answeredAt: Date; name: string; phone: string }> = [];

      if (q.type === 'text') {
        const latest = await prisma.response.findMany({
          where: { questionId: q.id, NOT: { answer: '' } }, orderBy: { answeredAt: 'desc' }, take: 20,
          include: { contact: { select: { name: true, phone: true } } },
        });
        texts = latest.map((r) => ({ answer: r.answer, answeredAt: r.answeredAt, name: people ? r.contact.name : '', phone: people ? maskPhone(r.contact.phone) : '' }));
      } else if (q.type === 'multi') {
        const counts = new Map<string, number>();
        for (const r of rows) {
          if (!r.answer) continue;
          try {
            for (const label of JSON.parse(r.answer) as string[]) counts.set(label, (counts.get(label) ?? 0) + r.count);
          } catch { /* malformed legacy value */ }
        }
        // For multi-select the denominator is respondents, so percentages may add to more than 100.
        distribution = options.map((o) => ({ label: o.label, count: counts.get(o.label) ?? 0, pct: pct(counts.get(o.label) ?? 0, answered) }));
      } else {
        const counts = new Map(rows.filter((r) => r.answer !== '').map((r) => [r.answer, r.count]));
        distribution = options.map((o) => ({ label: o.label, count: counts.get(o.label) ?? 0, pct: pct(counts.get(o.label) ?? 0, answered) }));
        if (q.type === 'rating' && answered > 0) {
          average = Math.round((distribution.reduce((a, d) => a + Number(d.label) * d.count, 0) / answered) * 100) / 100;
        }
      }

      return {
        id: q.id, number: i + 1, text: q.text, type: q.type, required: q.required, optionCount: options.length,
        answered, skipped, abandonedHere: abandonedAt.get(i + 1) ?? 0, distribution, average, texts,
      };
    }),
  );

  // ---- funnel ---------------------------------------------------------------------------------
  const funnel = [
    { key: 'sent', label: 'Invitation sent', count: totalSent },
    { key: 'started', label: 'Started survey', count: totalStarted },
    ...perQuestion.map((q) => ({ key: `q${q.number}`, label: `Answered Q${q.number}`, count: q.answered + q.skipped })),
    { key: 'completed', label: 'Completed all', count: totalCompleted },
  ];

  // ---- drop-off alert ----------------------------------------------------------------------------
  const worst = [...perQuestion].sort((a, b) => b.abandonedHere - a.abandonedHere)[0];
  const dropOff =
    worst && worst.abandonedHere > 0
      ? {
          questionNumber: worst.number, questionText: worst.text, count: worst.abandonedHere,
          suggestion: dropSuggestion(worst),
        }
      : null;

  const nonStarters = !people ? [] : await prisma.surveyRecipient.findMany({
    where: { surveyId, status: { in: ['sent', 'delivered'] }, contact: { optedOutAt: null } },
    include: { contact: { select: { name: true, phone: true } } },
    orderBy: { sentAt: 'desc' }, take: 50,
  });

  // Manual "Remind" buttons only work once the automatic window has opened: tell the page who is ready and when the rest will be.
  const [rn, ra] = await Promise.all([manualReminderState(surveyId, 'no_reply'), manualReminderState(surveyId, 'abandoned')]);
  const remind = {
    noReply: { eligibleNow: rn.ready.length, waiting: rn.waiting, nextAt: rn.nextAt },
    abandoned: { eligibleNow: ra.ready.length, waiting: ra.waiting, nextAt: ra.nextAt },
  };

  const gifts = { pending: 0, sent: 0, failed: 0, unfunded: 0 } as Record<string, number>;
  for (const g of giftGroups) gifts[g.status] = g._count._all;

  return {
    survey: { id: survey.id, title: survey.title, status: survey.status, giftType: survey.giftType, language: survey.language },
    totals: {
      sent: totalSent, started: totalStarted, completed: totalCompleted, abandoned: totalAbandoned, declined: totalDeclined,
      noReply, optedOut, inProgress, failed: byStatus.failed ?? 0, queued: byStatus.queued ?? 0,
      completionRate: pct(totalCompleted, totalStarted), // spec: completed / started × 100
      responseRate: pct(totalStarted, totalSent),
      avgCompletionSeconds: avgRow[0]?.avg ? Math.round(avgRow[0].avg) : null,
    },
    funnel, perQuestion, dropOff,
    nonStarters: nonStarters.map((r) => ({ recipientId: r.id, name: r.contact.name, phone: maskPhone(r.contact.phone), status: r.status, sentAt: r.sentAt })),
    gifts, remind,
    timeline: daily.map((d) => ({ day: d.day.toISOString().slice(0, 10), completed: Number(d.n) })),
    generatedAt: new Date().toISOString(),
  };
}

export type AnalyticsResult = Awaited<ReturnType<typeof computeAnalytics>>;

// ---- raw participants (table + exports) --------------------------------------------------------

export interface ParticipantRow {
  contactId: string;
  name: string;
  phone: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  abandonedAtQuestion: number | null;
  /** Answer per question id; '' = skipped; undefined = not reached. */
  answers: Record<string, string | undefined>;
}

export async function getParticipantRows(surveyId: string, userId: string, opts: { skip?: number; take?: number; onlyEngaged?: boolean } = {}) {
  const survey = await prisma.survey.findFirst({ where: { id: surveyId, userId }, include: { questions: { orderBy: { order: 'asc' } } } });
  if (!survey) throw notFound('Survey');
  const where = { surveyId, ...(opts.onlyEngaged === false ? {} : { status: { in: ['started', 'completed', 'abandoned'] as never[] } }) };
  const [recipients, total] = await Promise.all([
    prisma.surveyRecipient.findMany({ where, include: { contact: true }, orderBy: [{ completedAt: { sort: 'desc', nulls: 'last' } }, { startedAt: { sort: 'desc', nulls: 'last' } }], skip: opts.skip, take: opts.take }),
    prisma.surveyRecipient.count({ where }),
  ]);
  const responses = await prisma.response.findMany({ where: { surveyId, contactId: { in: recipients.map((r) => r.contactId) } }, select: { contactId: true, questionId: true, answer: true } });
  const byContact = new Map<string, Record<string, string>>();
  for (const r of responses) {
    const m = byContact.get(r.contactId) ?? {};
    m[r.questionId] = r.answer;
    byContact.set(r.contactId, m);
  }
  const rows: ParticipantRow[] = recipients.map((r) => ({
    contactId: r.contactId, name: r.contact.name, phone: r.contact.phone, status: r.status,
    startedAt: r.startedAt, completedAt: r.completedAt, abandonedAtQuestion: r.abandonedAtQuestion, answers: byContact.get(r.contactId) ?? {},
  }));
  return { survey, rows, total };
}

/** Human-readable answer (multi-select stored as JSON array → "A, B"). */
export function displayAnswer(type: string, answer: string | undefined): string {
  if (answer === undefined) return '';
  if (type === 'multi' && answer) {
    try { return (JSON.parse(answer) as string[]).join(', '); } catch { return answer; }
  }
  return answer;
}


// ---- who is in each group (the Analytics Bot's lists and the SaaS "haven't started" list) -------------------------------------------

export type RecipientListKind = 'nonresp' | 'started' | 'completed';
export interface RecipientListRow { recipientId: string; contactId: string; name: string; phone: string; status: string; sentAt: Date | null; completedAt: Date | null; /** started/abandoned: the question they are at or stopped at */ atQuestion: number | null }

/**
 * The people behind a number on the card, newest first. `nonresp` = invited, never replied, not opted out (the same people as the
 * dashboard's "No reply"); `started` = started but not finished; `completed` = finished. Opted-out contacts are never listed.
 * Phones are returned in full: whoever shows them to a participant-facing channel (WhatsApp) must mask them (maskPhone).
 */
export async function listRecipientsByKind(surveyId: string, userId: string, kind: RecipientListKind, opts: { skip?: number; take?: number } = {}) {
  const survey = await prisma.survey.findFirst({ where: { id: surveyId, userId }, include: { questions: { select: { id: true } } } });
  if (!survey) throw notFound('Survey');
  const where = {
    surveyId,
    ...(kind === 'nonresp' ? { status: { in: ['sent', 'delivered'] as never[] }, contact: { optedOutAt: null } }
      : kind === 'started' ? { status: { in: ['started', 'abandoned'] as never[] } }
      : { status: 'completed' as never }),
  };
  const orderBy = kind === 'nonresp' ? [{ sentAt: { sort: 'desc' as const, nulls: 'last' as const } }, { createdAt: 'desc' as const }]
    : kind === 'started' ? [{ startedAt: { sort: 'desc' as const, nulls: 'last' as const } }]
    : [{ completedAt: { sort: 'desc' as const, nulls: 'last' as const } }];
  const [total, recipients] = await Promise.all([
    prisma.surveyRecipient.count({ where }),
    prisma.surveyRecipient.findMany({ where, include: { contact: { select: { name: true, phone: true } } }, orderBy, skip: opts.skip, take: opts.take }),
  ]);
  let answered = new Map<string, number>();
  if (kind === 'started' && recipients.length) {
    const counts = await prisma.response.groupBy({ by: ['contactId'], where: { surveyId, contactId: { in: recipients.map((r) => r.contactId) } }, _count: { _all: true } });
    answered = new Map(counts.map((c) => [c.contactId, c._count._all]));
  }
  const rows: RecipientListRow[] = recipients.map((r) => ({
    recipientId: r.id, contactId: r.contactId, name: r.contact.name, phone: r.contact.phone, status: r.status, sentAt: r.sentAt, completedAt: r.completedAt,
    atQuestion: kind !== 'started' ? null : r.status === 'abandoned' ? r.abandonedAtQuestion : Math.min(survey.questions.length, (answered.get(r.contactId) ?? 0) + 1),
  }));
  return { survey, total, rows };
}
