import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../lib/errors';
import { signState, verifyState } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { buildAuthUrl, connectGoogle, googleConfigured } from '../services/exports/sheets';

export default async function googleRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  app.get('/api/integrations/google', auth, async (req) => {
    const conn = await prisma.googleConnection.findUnique({ where: { userId: req.userId }, select: { email: true, createdAt: true } });
    return { configured: googleConfigured(), connected: !!conn, email: conn?.email ?? null };
  });

  app.get('/api/integrations/google/auth-url', { preHandler: app.authenticateVerified }, async (req) => ({ url: buildAuthUrl(await signState('google', req.userId)) }));

  app.post('/api/integrations/google/connect', { preHandler: app.authenticateVerified }, async (req) => {
    const { code, state } = z.object({ code: z.string().min(5), state: z.string().min(10) }).parse(req.body);
    let stateUser: string;
    try {
      stateUser = await verifyState('google', state);
    } catch {
      throw badRequest('bad_state', 'This Google sign-in link expired. Start again.');
    }
    // The state binds the OAuth round-trip to the user who started it (blocks login-CSRF account mix-ups).
    if (stateUser !== req.userId) throw badRequest('bad_state', 'Google sign-in was started by a different account');
    return { connected: true, ...(await connectGoogle(req.userId, code)) };
  });

  app.delete('/api/integrations/google', auth, async (req, reply) => {
    await prisma.sheetSync.updateMany({ where: { userId: req.userId }, data: { autoSync: false } });
    await prisma.googleConnection.deleteMany({ where: { userId: req.userId } });
    await redis.del(`sf:gtoken:${req.userId}`);
    return reply.code(204).send();
  });
}
