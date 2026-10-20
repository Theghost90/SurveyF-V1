import type { FastifyInstance } from 'fastify';
import { rl } from '../lib/ratelimit';
import { z } from 'zod';
import { notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { buildExcel } from '../services/exports/excel';
import { buildPdf } from '../services/exports/pdf';
import { syncSurveyToSheets } from '../services/exports/sheets';

const slug = (s: string) => s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'survey';

export default async function exportRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };
  const nameOf = async (id: string, userId: string) => {
    const s = await prisma.survey.findFirst({ where: { id, userId }, select: { title: true } });
    if (!s) throw notFound('Survey');
    return slug(s.title);
  };
  const stamp = () => new Date().toISOString().slice(0, 10);

  app.get('/api/surveys/:id/export/pdf', { ...auth, ...rl(10) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const name = await nameOf(id, req.userId);
    const pdf = await buildPdf(id, req.userId);
    return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="surveyflow-${name}-${stamp()}.pdf"`).send(pdf);
  });

  app.get('/api/surveys/:id/export/excel', { ...auth, ...rl(20) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const name = await nameOf(id, req.userId);
    const xlsx = await buildExcel(id, req.userId);
    return reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="surveyflow-${name}-${stamp()}.xlsx"`)
      .send(xlsx);
  });

  app.get('/api/surveys/:id/sync', auth, async (req) => {
    await nameOf((req.params as { id: string }).id, req.userId);
    const sync = await prisma.sheetSync.findUnique({ where: { surveyId: (req.params as { id: string }).id } });
    return sync
      ? { enabled: true, autoSync: sync.autoSync, spreadsheetUrl: sync.spreadsheetUrl, lastSyncedAt: sync.lastSyncedAt, rowsSynced: sync.rowsSynced }
      : { enabled: false };
  });

  app.post('/api/surveys/:id/sync/google-sheets', { preHandler: [app.authenticate, app.requireFeature('googleSheets', 'Google Sheets sync')] }, async (req) => {
    const { id } = req.params as { id: string };
    await nameOf(id, req.userId);
    const { autoSync } = z.object({ autoSync: z.boolean().default(false) }).parse(req.body ?? {});
    const s = await syncSurveyToSheets(req.userId, id, autoSync);
    return { enabled: true, autoSync: s.autoSync, spreadsheetUrl: s.spreadsheetUrl, lastSyncedAt: s.lastSyncedAt, rowsSynced: s.rowsSynced };
  });

  app.delete('/api/surveys/:id/sync/google-sheets', auth, async (req, reply) => {
    await nameOf((req.params as { id: string }).id, req.userId);
    // Stop pushing rows; the spreadsheet itself stays in the owner's Drive.
    await prisma.sheetSync.updateMany({ where: { surveyId: (req.params as { id: string }).id }, data: { autoSync: false } });
    return reply.code(204).send();
  });
}
