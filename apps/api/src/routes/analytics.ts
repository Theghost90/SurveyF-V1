import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { rl } from '../lib/ratelimit';
import { maskPhone } from '@surveyflow/shared';
import { computeAnalytics, displayAnswer, getParticipantRows, listRecipientsByKind } from '../services/analytics';
import { guardExport } from '../services/security/data-guard';

export default async function analyticsRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  app.get('/api/surveys/:id/analytics', auth, async (req) => computeAnalytics((req.params as { id: string }).id, req.userId));

  /** "View all responses": one row per participant, answers keyed by question number. */
  app.get('/api/surveys/:id/responses', auth, async (req) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
    const { survey, rows, total } = await getParticipantRows((req.params as { id: string }).id, req.userId, { skip: (q.page - 1) * q.pageSize, take: q.pageSize });
    return {
      total, page: q.page, pageSize: q.pageSize,
      questions: survey.questions.map((qu, i) => ({ id: qu.id, number: i + 1, text: qu.text, type: qu.type })),
      items: rows.map((r) => ({
        contactId: r.contactId, name: r.name, phone: maskPhone(r.phone), status: r.status, completedAt: r.completedAt, abandonedAtQuestion: r.abandonedAtQuestion,
        answers: Object.fromEntries(survey.questions.map((qu) => [qu.id, displayAnswer(qu.type, r.answers[qu.id])])),
      })),
    };
  });

  /**
   * "Haven't started": the people invited who never replied (STOP excluded). Numbers are MASKED here too (a full one is a reveal away, logged and limited);
   * the complete list is the CSV below, which is capped, e-mailed to the owner and, when large, needs a recent "confirm it is you".
   */
  app.get('/api/surveys/:id/not-started', auth, async (req) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
    const { total, rows } = await listRecipientsByKind((req.params as { id: string }).id, req.userId, 'nonresp', { skip: (q.page - 1) * q.pageSize, take: q.pageSize });
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((r) => ({ recipientId: r.recipientId, contactId: r.contactId, name: r.name, phone: maskPhone(r.phone), status: r.status, sentAt: r.sentAt })) };
  });

  app.get('/api/surveys/:id/not-started.csv', { preHandler: app.authenticateVerified, ...rl(20) }, async (req, reply) => {
    const { survey, rows } = await listRecipientsByKind((req.params as { id: string }).id, req.userId, 'nonresp', { take: 50_000 });
    await guardExport(req, { kind: 'csv', rows: rows.length, surveyId: survey.id, surveyTitle: survey.title });
    const lines = [['name', 'phone', 'invited_at', 'status'].join(','), ...rows.map((r) => [csvCell(r.name), csvCell(r.phone), r.sentAt ? r.sentAt.toISOString() : '', r.status].join(','))];
    const file = `not-started-${survey.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'survey'}.csv`;
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${file}"`).send(`\uFEFF${lines.join('\r\n')}\r\n`);
  });
}

/** A CSV cell the owner will open in Excel: quoted, and a leading = + - @ (a formula) is defused so a contact named "=HYPERLINK(…)" stays text. */
export function csvCell(v: string): string {
  // A plain international number ("+237677…") starts with + but is not a formula; everything else that starts like one is defused.
  const safe = /^[=+\-@\t\r]/.test(v) && !/^\+\d[\d ]*$/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}
