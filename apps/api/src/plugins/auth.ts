import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { activeSession } from '../services/security/sessions';
import { assertFeature, loadAccount } from '../services/subscription/limits';
import type { PlanFeatures } from '@surveyflow/shared';

/** What a frozen account may still do: everything about signing in and proving who you are, the download, and cancelling the deletion. */
const FROZEN_OK = /^\/api\/(auth\/|account\/(export|delete\/cancel)$)/;

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    /** The sign-in session this request's token belongs to. */
    sessionId: string;
    rawBody?: Buffer;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** `authenticate`, and the owner has confirmed their e-mail address: for everything that sends, pays, exports or connects something. */
    authenticateVerified: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireFeature: (feature: keyof PlanFeatures, label: string) => (req: FastifyRequest) => Promise<void>;
  }
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    let who: { userId: string; sessionId: string };
    try {
      who = await verifyAccessToken(header.slice(7));
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    // The token alone is not enough: its session must still be open (signed out, revoked, expired or deleted account all end it).
    if (!(await activeSession(who.sessionId, who.userId))) throw unauthorized('Session ended');
    req.userId = who.userId;
    req.sessionId = who.sessionId;
    // DAT-01: an account that asked to be erased only reads (the owner can still download, cancel, confirm it is them and sign out). One indexed read, and only for changes.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !FROZEN_OK.test(req.url.split('?')[0]!)) {
      const u = await prisma.user.findUnique({ where: { id: who.userId }, select: { deletionScheduledFor: true } });
      if (u?.deletionScheduledFor) throw new AppError(423, 'account_pending_deletion', 'This account is scheduled for deletion, so it can only be read. Cancel the deletion in Settings, Your data, to change things again.', { scheduledFor: u.deletionScheduledFor });
    }
  });

  app.decorate('authenticateVerified', async (req: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(req, reply);
    const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { emailVerifiedAt: true } });
    if (!u) throw unauthorized('Account no longer exists');
    if (!u.emailVerifiedAt) throw new AppError(403, 'email_not_verified', 'Confirm your e-mail address first: we sent you a link when you signed up', { resend: true });
  });

  /** Plan-feature gate used as a route preHandler: `preHandler: [app.authenticate, app.requireFeature('googleSheets', 'Google Sheets sync')]` */
  app.decorate('requireFeature', (feature: keyof PlanFeatures, label: string) => async (req: FastifyRequest) => {
    assertFeature(await loadAccount(req.userId), feature, label);
  });
});
