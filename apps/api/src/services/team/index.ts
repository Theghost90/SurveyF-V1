import { env } from '../../config/env';
import { loadAccount } from '../subscription/limits';
import { randomToken, sha256Hex } from '../../lib/crypto';
import { canonicalEmail } from '../../lib/email';
import { AppError, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { audit, type AuditContext } from '../audit';
import { sendMail } from '../mail';
import { TEAM_ROLES, type TeamRole } from './access';

/**
 * Team members (BIZ-04): colleagues who work on an owner's workspace with their OWN login, password and second factor. The rules that contain it:
 *   - only the owner manages the team (there is no admin role): nobody inside can widen access;
 *   - an invitation is a single-use link that expires, and only the signed-in person whose CONFIRMED address it was sent to can accept it (a forwarded link is useless);
 *   - a member needs two-factor authentication on their own account (checked on every request, plugins/auth.ts);
 *   - removing a member ends their access at their next request (the membership row is the only thing that grants it);
 *   - everything a member does is in the team's trail, with who did it.
 */

const DAY = 86_400_000;
const lang = (l: string): 'en' | 'fr' => (l === 'en' ? 'en' : 'fr');
const MAX_PENDING = 10;

/** The plan's seats include the owner (`limits.teamMembers`: 1 on Explore and Starter, 3 on Growth, 10 on Business), so the others are one fewer. */
async function seatsFor(ownerId: string): Promise<{ plan: string; seats: number; others: number }> {
  const { plan } = await loadAccount(ownerId);
  return { plan: plan.key, seats: plan.limits.teamMembers, others: Math.max(0, plan.limits.teamMembers - 1) };
}
const planLimit = (s: { plan: string; seats: number; others: number }) =>
  new AppError(402, 'plan_limit', s.others === 0 ? 'Your plan has no room for team members: upgrade to add colleagues' : `Your plan has room for ${s.seats} people including you: remove a member or an invitation, or upgrade`, { limit: 'teamMembers', max: s.seats, plan: s.plan });
export async function listTeam(ownerId: string) {
  const [members, invites] = await Promise.all([
    prisma.teamMember.findMany({ where: { workspaceId: ownerId }, orderBy: { createdAt: 'asc' }, include: { member: { select: { name: true, email: true, totpEnabledAt: true } } } }),
    prisma.teamInvite.findMany({ where: { workspaceId: ownerId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }),
  ]);
  const { seats } = await seatsFor(ownerId);
  return {
    seats,
    members: members.map((m) => ({ id: m.id, name: m.member.name, email: m.member.email, role: m.role, since: m.createdAt, twoFactor: !!m.member.totpEnabledAt })),
    invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt })),
  };
}

export async function inviteMember(owner: { id: string; name: string; businessName: string; email: string; locale: string }, email: string, role: TeamRole, ctx: AuditContext) {
  if (!TEAM_ROLES.includes(role)) throw new AppError(400, 'invalid_role', 'The role is viewer or editor');
  const canonical = canonicalEmail(email);
  if (canonical === canonicalEmail(owner.email)) throw new AppError(400, 'invite_self', 'You cannot invite yourself');
  const now = new Date();
  const [members, pending, existing] = await Promise.all([
    prisma.teamMember.count({ where: { workspaceId: owner.id } }),
    prisma.teamInvite.count({ where: { workspaceId: owner.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } }),
    prisma.teamInvite.findFirst({ where: { workspaceId: owner.id, emailCanonical: canonical, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } }),
  ]);
  if (existing) throw new AppError(409, 'already_invited', 'This address has a pending invitation: revoke it first to send another');
  const seat = await seatsFor(owner.id);
  if (members + pending >= seat.others) throw planLimit(seat);
  if (pending >= MAX_PENDING) throw new AppError(409, 'too_many_invites', `At most ${MAX_PENDING} invitations can be pending at once`);
  const already = await prisma.user.findFirst({ where: { emailCanonical: canonical, memberships: { some: { workspaceId: owner.id } } }, select: { id: true } });
  if (already) throw new AppError(409, 'already_member', 'This person is already on your team');
  const token = randomToken(32);
  const invite = await prisma.teamInvite.create({
    data: { workspaceId: owner.id, email: email.trim().toLowerCase(), emailCanonical: canonical, role, tokenHash: sha256Hex(token), invitedBy: owner.id, expiresAt: new Date(now.getTime() + env.TEAM_INVITE_DAYS * DAY) },
  });
  await audit(ctx, { action: 'team_invited', targetType: 'invite', targetId: invite.id, meta: { role } });
  await sendMail(invite.email, 'team_invite', lang(owner.locale), { name: owner.name, what: owner.businessName, url: `${env.webBaseUrl}/team/accept?token=${token}`, template: role, count: env.TEAM_INVITE_DAYS });
  return { id: invite.id, email: invite.email, role, expiresAt: invite.expiresAt };
}

export async function revokeInvite(ownerId: string, inviteId: string, ctx: AuditContext) {
  const r = await prisma.teamInvite.updateMany({ where: { id: inviteId, workspaceId: ownerId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!r.count) throw notFound('Invitation');
  await audit(ctx, { action: 'team_invite_revoked', targetType: 'invite', targetId: inviteId });
}

/** The invitee, signed in with the address the invitation was sent to and confirmed, takes it. The same answer for every reason it may not be taken. */
export async function acceptInvite(userId: string, token: string, ctx: AuditContext) {
  const invite = await prisma.teamInvite.findUnique({ where: { tokenHash: sha256Hex(token) } });
  const now = new Date();
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= now) throw new AppError(410, 'invite_invalid', 'This invitation is no longer valid. Ask for a new one.');
  const me = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true, emailVerifiedAt: true, name: true } });
  if (!me.emailVerifiedAt || canonicalEmail(me.email) !== invite.emailCanonical) {
    throw new AppError(403, 'invite_wrong_account', 'This invitation was sent to another address. Sign in with that address (and confirm it) to accept.');
  }
  if (invite.workspaceId === me.id) throw new AppError(400, 'invite_self', 'You cannot join your own workspace');
  // The plan's seats are checked again here: an owner who downgraded after inviting cannot be given more people than the plan has room for. Members already in stay.
  const members = await prisma.teamMember.count({ where: { workspaceId: invite.workspaceId } });
  if (members >= (await seatsFor(invite.workspaceId)).others) throw new AppError(409, 'team_full', 'This team is full: the owner\'s plan has no room for another member');
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: invite.workspaceId }, select: { email: true, name: true, locale: true, businessName: true } });
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.teamInvite.updateMany({ where: { id: invite.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: now } });
    if (!claimed.count) throw new AppError(410, 'invite_invalid', 'This invitation is no longer valid. Ask for a new one.');
    await tx.teamMember.upsert({ where: { workspaceId_memberId: { workspaceId: invite.workspaceId, memberId: me.id } }, create: { workspaceId: invite.workspaceId, memberId: me.id, role: invite.role, invitedBy: invite.invitedBy }, update: { role: invite.role } });
  });
  await audit({ ...ctx, userId: invite.workspaceId, actorId: me.id }, { action: 'team_member_joined', meta: { role: invite.role } });
  await sendMail(owner.email, 'team_joined', lang(owner.locale), { name: owner.name, what: me.name, template: invite.role }).catch(() => undefined);
  return { workspaceId: invite.workspaceId, businessName: owner.businessName, role: invite.role as TeamRole };
}

export async function changeRole(ownerId: string, memberRowId: string, role: TeamRole, ctx: AuditContext) {
  if (!TEAM_ROLES.includes(role)) throw new AppError(400, 'invalid_role', 'The role is viewer or editor');
  const r = await prisma.teamMember.updateMany({ where: { id: memberRowId, workspaceId: ownerId }, data: { role } });
  if (!r.count) throw notFound('Team member');
  await audit(ctx, { action: 'team_role_changed', targetType: 'member', targetId: memberRowId, meta: { role } });
}

export async function removeMember(ownerId: string, memberRowId: string, ctx: AuditContext) {
  const m = await prisma.teamMember.findFirst({ where: { id: memberRowId, workspaceId: ownerId }, include: { member: { select: { email: true, name: true, locale: true } }, workspace: { select: { businessName: true } } } });
  if (!m) throw notFound('Team member');
  await prisma.teamMember.deleteMany({ where: { id: memberRowId, workspaceId: ownerId } });
  await audit(ctx, { action: 'team_member_removed', targetType: 'member', targetId: memberRowId });
  await sendMail(m.member.email, 'team_removed', lang(m.member.locale), { name: m.member.name, what: m.workspace.businessName }).catch(() => undefined);
}

/** A member leaves by themselves. */
export async function leaveWorkspace(userId: string, workspaceId: string, ctx: AuditContext) {
  const r = await prisma.teamMember.deleteMany({ where: { workspaceId, memberId: userId } });
  if (!r.count) throw notFound('Membership');
  await audit({ ...ctx, userId: workspaceId, actorId: userId }, { action: 'team_member_left' });
}

export async function workspacesOf(userId: string) {
  const rows = await prisma.teamMember.findMany({ where: { memberId: userId }, include: { workspace: { select: { id: true, businessName: true } } }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => ({ workspaceId: r.workspace.id, businessName: r.workspace.businessName, role: r.role as TeamRole }));
}

/** What the members did in this workspace, newest first, with who. Names are the members' own, shown to the owner who invited them. */
export async function teamActivity(ownerId: string, take = 100) {
  const rows = await prisma.auditLog.findMany({ where: { userId: ownerId, actorId: { not: null } }, orderBy: { at: 'desc' }, take });
  const people = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId!))] } }, select: { id: true, name: true, email: true } });
  const byId = new Map(people.map((p) => [p.id, p]));
  return rows.map((r) => ({ id: r.id, at: r.at, action: r.action, who: byId.get(r.actorId!)?.name ?? 'a former member', email: byId.get(r.actorId!)?.email ?? null, meta: r.meta }));
}
