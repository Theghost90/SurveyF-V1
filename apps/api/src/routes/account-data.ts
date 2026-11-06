import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { rl } from '../lib/ratelimit';
import { auditContext } from '../services/audit';
import { buildAccountExport, cancelDeletion, dataStatus, requestDeletion } from '../services/account-data';
import { guardAccountExport } from '../services/security/data-guard';
import { assertStepUp } from '../services/security/step-up';

/**
 * The owner's rights over their own account (DAT-01, law 2024/017: erasure s.37 and 38, access s.39, portability s.43): see what is held, download all of it, ask for it to be erased, change their mind.
 * Everything that takes data out or starts an erasure needs a recent "confirm it is you" (and, on a plan that requires it, the authenticator app).
 */
export default async function accountDataRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };
  const verified = { preHandler: app.authenticateVerified };

  /** What is scheduled, what stands in the way of an erasure, and how long things are kept. */
  app.get('/api/account/data', auth, async (req) => dataStatus(req.userId));

  /** The whole-account download. Built on the spot and sent to this session only: no stored file, no link to forward. */
  app.post('/api/account/export', { ...verified, ...rl(5) }, async (req, reply) => {
    await guardAccountExport(req);
    const file = await buildAccountExport(req.userId);
    return reply
      .type('application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="surveyflow-account-${new Date().toISOString().slice(0, 10)}.json"`)
      .header('Cache-Control', 'no-store')
      .send(JSON.stringify(file, null, 2));
  });

  /** Asks for the erasure. Refused (409) while money is unresolved; otherwise scheduled, with the date in the answer. */
  app.post('/api/account/delete', { ...verified, ...rl(3) }, async (req) => {
    z.object({ confirm: z.literal('DELETE') }).parse(req.body);
    await assertStepUp(req);
    try {
      const { scheduledFor } = await requestDeletion(req.userId, auditContext(req), req.sessionId);
      return { scheduledFor };
    } catch (err) {
      const blockers = (err as { blockers?: unknown }).blockers;
      if (blockers) throw new AppError(409, 'account_delete_blocked', 'The account cannot be deleted while money is unresolved: spend or settle it first, or contact support', { blockers });
      throw err;
    }
  });

  /** Changes their mind, any time before the date. Needs no confirmation: cancelling can only keep things as they are. */
  app.post('/api/account/delete/cancel', { ...auth, ...rl(10) }, async (req) => ({ cancelled: await cancelDeletion(req.userId, auditContext(req)) }));
}
