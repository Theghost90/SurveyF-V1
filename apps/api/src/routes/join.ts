import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { rl } from '../lib/ratelimit';
import { auditContext } from '../services/audit';
import { assertStepUp } from '../services/security/step-up';
import { getJoin, updateJoin } from '../services/survey/join';

/**
 * The join link of a survey (WA-05, WA-06): see it, switch it on or off, set its limits, replace its code. Owner only: a team member cannot reach these (they are not in
 * `MEMBER_ROUTES`, which is deny by default). Letting joiners win gifts is money, so that one change needs a fresh "confirm it is you".
 */
export default async function joinRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };
  const verified = { preHandler: app.authenticateVerified };
  const body = z.object({
    enabled: z.boolean().optional(),
    expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
    max: z.number().int().min(1).max(100_000).nullable().optional(),
    countries: z.array(z.string().length(2).regex(/^[A-Za-z]{2}$/)).max(30).optional(),
    gifts: z.boolean().optional(),
    giftMax: z.number().int().min(1).max(100_000).nullable().optional(),
    rotate: z.boolean().optional(),
  });

  app.get('/api/surveys/:id/join', auth, async (req) => getJoin(req.userId, (req.params as { id: string }).id));

  app.put('/api/surveys/:id/join', { ...verified, ...rl(30) }, async (req) => {
    const input = body.parse(req.body);
    if (input.gifts === true) await assertStepUp(req);
    return updateJoin(req.userId, (req.params as { id: string }).id, input, auditContext(req));
  });
}
