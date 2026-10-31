import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../lib/errors';
import { rl } from '../lib/ratelimit';
import { prisma } from '../lib/prisma';
import { auditContext } from '../services/audit';
import { assertStepUp } from '../services/security/step-up';
import { TEAM_ROLES } from '../services/team/access';
import { acceptInvite, changeRole, inviteMember, leaveWorkspace, listTeam, removeMember, revokeInvite, teamActivity, workspacesOf } from '../services/team';

/**
 * Team members (BIZ-04). Two kinds of route, and a member can reach neither kind from inside a workspace (they are not in `MEMBER_ROUTES`, which is deny by default):
 *   - the owner's: see the team, invite, change a role, remove, see what members did. Granting or widening access needs "confirm it is you".
 *   - the person's own, called WITHOUT naming a workspace: which workspaces am I in, accept an invitation, leave one.
 */
export default async function teamRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };
  const verified = { preHandler: app.authenticateVerified };
  const role = z.enum(TEAM_ROLES as unknown as [string, ...string[]]);

  app.get('/api/team', auth, async (req) => listTeam(req.userId));
  app.get('/api/team/activity', auth, async (req) => ({ items: await teamActivity(req.userId) }));

  app.post('/api/team/invites', { ...verified, ...rl(10) }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().toLowerCase().email().max(200), role }).parse(req.body);
    await assertStepUp(req); // inviting somebody gives them a way into the participants: it needs a fresh "confirm it is you"
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { id: true, name: true, businessName: true, email: true, locale: true } });
    reply.code(201);
    return inviteMember(owner, body.email, body.role as 'viewer' | 'editor', auditContext(req));
  });
  app.delete('/api/team/invites/:id', { ...verified, ...rl(20) }, async (req, reply) => { await revokeInvite(req.userId, (req.params as { id: string }).id, auditContext(req)); return reply.code(204).send(); });

  app.patch('/api/team/members/:id', { ...verified, ...rl(20) }, async (req) => {
    const body = z.object({ role }).parse(req.body);
    const { id } = req.params as { id: string };
    // whose member this is comes first: somebody else's id is a plain "not found", whatever they have or have not confirmed
    if (!(await prisma.teamMember.findFirst({ where: { id, workspaceId: req.userId }, select: { id: true } }))) throw notFound('Team member');
    await assertStepUp(req);
    await changeRole(req.userId, id, body.role as 'viewer' | 'editor', auditContext(req));
    return { ok: true };
  });
  app.delete('/api/team/members/:id', { ...verified, ...rl(20) }, async (req, reply) => { await removeMember(req.userId, (req.params as { id: string }).id, auditContext(req)); return reply.code(204).send(); });

  app.get('/api/team/workspaces', auth, async (req) => ({ items: await workspacesOf(req.userId) }));
  app.post('/api/team/accept', { ...verified, ...rl(10) }, async (req) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
    return acceptInvite(req.userId, token, auditContext(req));
  });
  app.post('/api/team/leave', { ...auth, ...rl(10) }, async (req, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().min(5).max(60) }).parse(req.body);
    await leaveWorkspace(req.userId, workspaceId, auditContext(req));
    return reply.code(204).send();
  });
}
