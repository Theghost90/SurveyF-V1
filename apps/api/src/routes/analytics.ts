import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { maskPhone } from '@surveyflow/shared';
import { computeAnalytics, displayAnswer, getParticipantRows } from '../services/analytics';

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
}
