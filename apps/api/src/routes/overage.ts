import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { rl } from '../lib/ratelimit';
import { auditContext } from '../services/audit';
import { overageState, setOverageOptIn } from '../services/overage';
import { initiateOveragePayment, txDto } from '../services/payments/service';

/** Responses beyond the plan (PAY-09): the owner's agreement, the invoices, and paying one. Owner only (not in `MEMBER_ROUTES`). */
export default async function overageRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };
  const verified = { preHandler: app.authenticateVerified };

  app.get('/api/subscription/overage', auth, async (req) => overageState(req.userId));

  app.put('/api/subscription/overage', { ...verified, ...rl(20) }, async (req) => {
    const { optIn } = z.object({ optIn: z.boolean() }).parse(req.body);
    return setOverageOptIn(req.userId, optIn, auditContext(req));
  });

  app.post('/api/subscription/overage/:id/pay', { ...verified, ...rl(10) }, async (req) => {
    const body = z.object({ method: z.enum(['mobile_money', 'card', 'bank_transfer']), phone: z.string().max(30).optional() }).parse(req.body);
    return txDto(await initiateOveragePayment(req.userId, (req.params as { id: string }).id, body));
  });
}
