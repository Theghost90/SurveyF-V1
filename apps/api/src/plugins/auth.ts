import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { assertFeature, loadAccount } from '../services/subscription/limits';
import type { PlanFeatures } from '@surveyflow/shared';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    rawBody?: Buffer;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireFeature: (feature: keyof PlanFeatures, label: string) => (req: FastifyRequest) => Promise<void>;
  }
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    try {
      req.userId = await verifyAccessToken(header.slice(7));
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    // A deleted account must not keep working until its token expires.
    const exists = await prisma.user.count({ where: { id: req.userId } });
    if (!exists) throw unauthorized('Account no longer exists');
  });

  /** Plan-feature gate used as a route preHandler: `preHandler: [app.authenticate, app.requireFeature('googleSheets', 'Google Sheets sync')]` */
  app.decorate('requireFeature', (feature: keyof PlanFeatures, label: string) => async (req: FastifyRequest) => {
    assertFeature(await loadAccount(req.userId), feature, label);
  });
});
