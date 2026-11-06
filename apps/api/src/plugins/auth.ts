import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { audit, auditContext } from '../services/audit';
import { redis } from '../lib/redis';
import { activeSession } from '../services/security/sessions';
import { memberRoleFor, roleAllows, type TeamRole } from '../services/team/access';
import { assertFeature, loadAccount } from '../services/subscription/limits';
import type { PlanFeatures } from '@surveyflow/shared';

/** What a frozen account may still do: everything about signing in and proving who you are, the download, and cancelling the deletion. */
const FROZEN_OK = /^\/api\/(auth\/|account\/(export|delete\/cancel)$)/;

/**
 * BIZ-04. A team member works on an owner's workspace with their OWN login. They say which workspace in a header; the header is only a request, and the
 * membership, the role, the route and the member's own second factor are checked here on EVERY request, before any handler runs. Without the header (or naming
 * oneself) nothing changes: the signed-in user is their own workspace, as before. Once inside, `userId` is the OWNER (so every query in every handler is already
 * scoped to the owner's data), and `actorId` is the member (so the trail says who).
 */
const WORKSPACE_HEADER = 'x-workspace';
const WORKSPACE_ID = /^[A-Za-z0-9_-]{10,40}$/;

declare module 'fastify' {
  interface FastifyRequest {
    /** Whose data this request works on: the signed-in user, or the owner of the workspace they entered. */
    userId: string;
    /** Who is signed in. Equal to `userId` unless a team member entered an owner's workspace. */
    actorId: string;
    /** `owner` unless a team member entered an owner's workspace. */
    role: 'owner' | TeamRole;
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
    req.actorId = who.userId;
    req.role = 'owner';
    req.sessionId = who.sessionId;
    const wanted = (Array.isArray(req.headers[WORKSPACE_HEADER]) ? req.headers[WORKSPACE_HEADER]![0] : (req.headers[WORKSPACE_HEADER] as string | undefined))?.trim();
    if (wanted && wanted !== who.userId) await enterWorkspace(req, wanted);
    // DAT-01: an account that asked to be erased only reads (the owner can still download, cancel, confirm it is them and sign out). One indexed read, and only for changes.
    // (In a workspace it is the OWNER's account that counts: a workspace being erased only reads for everybody in it.)
    if (req.method !== 'GET' && req.method !== 'HEAD' && !FROZEN_OK.test(req.url.split('?')[0]!)) {
      const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { deletionScheduledFor: true } });
      if (u?.deletionScheduledFor) throw new AppError(423, 'account_pending_deletion', 'This account is scheduled for deletion, so it can only be read. Cancel the deletion in Settings, Your data, to change things again.', { scheduledFor: u.deletionScheduledFor });
    }
  });

  /** What a request into somebody else's workspace has to pass. Every refusal is a 403 that says as little as it can. */
  async function enterWorkspace(req: FastifyRequest, workspaceId: string): Promise<void> {
    if (!WORKSPACE_ID.test(workspaceId)) throw new AppError(403, 'not_a_member', 'You are not a member of that workspace');
    const member = await prisma.teamMember.findUnique({ where: { workspaceId_memberId: { workspaceId, memberId: req.actorId } }, select: { role: true } });
    if (!member) throw new AppError(403, 'not_a_member', 'You are not a member of that workspace');
    const role = member.role as TeamRole;
    const route = req.routeOptions?.url ?? '';
    const needed = memberRoleFor(req.method, route);
    if (!needed || !roleAllows(role, needed)) {
      // A real member reaching for something that is not theirs is worth a line in the owner's team trail, at most one a minute for the same thing.
      const key = `sf:member-denied:${req.actorId}:${req.method}:${route}`;
      if ((await redis.set(key, '1', 'EX', 60, 'NX').catch(() => null)) === 'OK') {
        await audit({ ...auditContext(req, workspaceId), actorId: req.actorId }, { action: 'member_denied', meta: { method: req.method, route, role } });
      }
      throw new AppError(403, 'forbidden_role', 'Your role in this workspace does not allow this');
    }
    const me = await prisma.user.findUnique({ where: { id: req.actorId }, select: { totpEnabledAt: true } });
    if (!me?.totpEnabledAt) throw new AppError(403, 'two_factor_required', 'Turn on two-factor authentication on your own account (Settings, Security) to work on a team workspace', { setup: true });
    req.userId = workspaceId;
    req.role = role;
  }

  // The per-member audit (BIZ-04): every change a member makes in a workspace is recorded against them, whatever the route, without each route having to remember.
  app.addHook('onResponse', async (req, reply) => {
    if (!req.role || req.role === 'owner' || req.method === 'GET' || req.method === 'HEAD') return;
    await audit(auditContext(req), { action: 'member_request', meta: { method: req.method, route: req.routeOptions?.url ?? '', status: reply.statusCode, role: req.role } });
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
