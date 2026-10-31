import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { clientIp, ipPrefix } from '../lib/client-ip';
import { prisma } from '../lib/prisma';
import { describeAgent } from '../lib/user-agent';

/**
 * The audit trail: who did a security-relevant thing, when, from where.
 *
 * Deliberately small. It records ids, counts and a coarse place, NEVER a phone number, a name, a message or an answer, so that the trail itself is not a second
 * copy of the data it protects. Rows are only ever added: nothing in the application updates or deletes them (the retention job in jobs/retention.ts is the
 * one exception, and it deletes only rows older than AUDIT_RETENTION_DAYS).
 */
export type AuditAction =
  | 'register' | 'email_verified' | 'verify_password_failed' | 'verification_resent' | 'login' | 'login_failed' | 'login_blocked' | 'login_new_device' | 'logout' | 'sessions_revoked' | 'session_revoked'
  | 'refresh_reuse' | 'password_reset_requested' | 'password_reset' | 'password_changed' | 'step_up' | 'step_up_failed'
  | 'two_factor_enabled' | 'two_factor_disabled' | 'recovery_codes_regenerated' | 'recovery_code_used'
  | 'google_login' | 'google_linked' | 'google_link_requested' | 'unverified_account_replaced'
  | 'export' | 'export_blocked' | 'bulk_delete' | 'contact_reveal' | 'prize_draw_winner_shown'
  | 'bulk_read' | 'bulk_read_blocked' | 'sheets_autosync_confirmed' | 'sheets_autosync_paused'
  | 'account_export' | 'account_delete_requested' | 'account_delete_cancelled' | 'account_delete_postponed' | 'account_deleted';

export interface AuditContext { userId?: string | null; sessionId?: string | null; ip?: string | null; userAgent?: string | null }

export interface AuditEntry { action: AuditAction; targetType?: string; targetId?: string; meta?: Record<string, string | number | boolean | null> }

/** Where a request came from, in the form the trail keeps it. */
export function auditContext(req: FastifyRequest, userId?: string | null): AuditContext {
  return { userId: userId ?? (req as { userId?: string }).userId ?? null, sessionId: (req as { sessionId?: string }).sessionId ?? null, ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null };
}

const data = (ctx: AuditContext, e: AuditEntry): Prisma.AuditLogUncheckedCreateInput => ({
  userId: ctx.userId ?? null, sessionId: ctx.sessionId ?? null, action: e.action, targetType: e.targetType ?? null, targetId: e.targetId ?? null,
  ipPrefix: ipPrefix(ctx.ip), userAgent: ctx.userAgent ? describeAgent(ctx.userAgent).label : null, meta: (e.meta as Prisma.InputJsonValue | undefined) ?? undefined,
});

/** Writes the entry and PROPAGATES a failure: used where an action must not happen unrecorded (a number reveal, an export). */
export async function auditStrict(ctx: AuditContext, e: AuditEntry): Promise<void> {
  await prisma.auditLog.create({ data: data(ctx, e) });
}

/** Writes the entry; a failure is logged and never blocks the request (sign-in events: the owner must still be able to sign in). */
export async function audit(ctx: AuditContext, e: AuditEntry, log: { warn: (o: unknown, m?: string) => void } = console as never): Promise<void> {
  try { await auditStrict(ctx, e); } catch (err) { log.warn({ action: e.action, err: (err as Error).message }, 'audit write failed'); }
}

export async function recentActivity(userId: string, take = 40) {
  const rows = await prisma.auditLog.findMany({ where: { userId }, orderBy: { at: 'desc' }, take });
  return rows.map((r) => ({ id: r.id, at: r.at, action: r.action, place: [r.userAgent, r.ipPrefix].filter(Boolean).join(' · ') || null, meta: r.meta }));
}
