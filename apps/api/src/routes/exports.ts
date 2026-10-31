import type { FastifyInstance } from 'fastify';
import { rl } from '../lib/ratelimit';
import { z } from 'zod';
import { notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { buildExcel } from '../services/exports/excel';
import { buildPdf } from '../services/exports/pdf';
import { audit, auditContext } from '../services/audit';
import { autoSyncActive, autoSyncConfirmedUntil, syncSurveyToSheets } from '../services/exports/sheets';
import { guardExport, type ExportKind } from '../services/security/data-guard';

const slug = (s: string) => s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'survey';

export default async function exportRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };
  // Everything that takes participant data out of the account needs a confirmed address (and is capped, e-mailed and, when large, step-up protected).
  const authVerified = { preHandler: app.authenticateVerified };
  const nameOf = async (id: string, userId: string) => {
    const s = await prisma.survey.findFirst({ where: { id, userId }, select: { title: true } });
    if (!s) throw notFound('Survey');
    return slug(s.title);
  };
  /** Cap, confirm-it-is-you (large exports), audit trail and e-mail to the owner, BEFORE the file is built. The rows are the people on the survey. */
  const guard = async (req: import('fastify').FastifyRequest, id: string, kind: ExportKind, forceStepUp = false) => {
    const s = await prisma.survey.findFirst({ where: { id, userId: req.userId }, select: { id: true, title: true } });
    if (!s) throw notFound('Survey');
    await guardExport(req, { kind, rows: await prisma.surveyRecipient.count({ where: { surveyId: s.id } }), surveyId: s.id, surveyTitle: s.title, forceStepUp });
  };
  const syncDto = (s: { autoSync: boolean; autoSyncConfirmedAt: Date | null; spreadsheetUrl: string; lastSyncedAt: Date | null; rowsSynced: number }) => ({
    enabled: true, autoSync: s.autoSync, autoSyncActive: autoSyncActive(s), autoSyncPaused: s.autoSync && !autoSyncActive(s), autoSyncConfirmedUntil: autoSyncConfirmedUntil(s),
    spreadsheetUrl: s.spreadsheetUrl, lastSyncedAt: s.lastSyncedAt, rowsSynced: s.rowsSynced,
  });
  const stamp = () => new Date().toISOString().slice(0, 10);

  app.get('/api/surveys/:id/export/pdf', { ...authVerified, ...rl(10) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const name = await nameOf(id, req.userId);
    await guard(req, id, 'pdf');
    const pdf = await buildPdf(id, req.userId);
    return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="surveyflow-${name}-${stamp()}.pdf"`).send(pdf);
  });

  app.get('/api/surveys/:id/export/excel', { ...authVerified, ...rl(20) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const name = await nameOf(id, req.userId);
    await guard(req, id, 'excel');
    const xlsx = await buildExcel(id, req.userId);
    return reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="surveyflow-${name}-${stamp()}.xlsx"`)
      .send(xlsx);
  });

  app.get('/api/surveys/:id/sync', auth, async (req) => {
    await nameOf((req.params as { id: string }).id, req.userId);
    const sync = await prisma.sheetSync.findUnique({ where: { surveyId: (req.params as { id: string }).id } });
    return sync ? syncDto(sync) : { enabled: false };
  });

  app.post('/api/surveys/:id/sync/google-sheets', { preHandler: [app.authenticateVerified, app.requireFeature('googleSheets', 'Google Sheets sync')] }, async (req) => {
    const { id } = req.params as { id: string };
    await nameOf(id, req.userId);
    // `autoSync` true = turn auto-sync on or confirm it again, false = turn it off, absent = a one-off sync that leaves the setting as it is.
    const { autoSync } = z.object({ autoSync: z.boolean().optional() }).parse(req.body ?? {});
    // Turning auto-sync on, or confirming it again, always needs "confirm it is you": it keeps copying new participants out of the account after this call (SEC-20).
    await guard(req, id, 'sheets', autoSync === true);
    const s = await syncSurveyToSheets(req.userId, id, autoSync);
    if (autoSync === true) await audit(auditContext(req), { action: 'sheets_autosync_confirmed', targetType: 'survey', targetId: id });
    return syncDto(s);
  });

  app.delete('/api/surveys/:id/sync/google-sheets', auth, async (req, reply) => {
    await nameOf((req.params as { id: string }).id, req.userId);
    // Stop pushing rows; the spreadsheet itself stays in the owner's Drive.
    await prisma.sheetSync.updateMany({ where: { surveyId: (req.params as { id: string }).id }, data: { autoSync: false } });
    return reply.code(204).send();
  });
}
