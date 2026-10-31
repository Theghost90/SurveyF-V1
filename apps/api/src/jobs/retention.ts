import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { runAccountRetention } from '../services/account-data';

/**
 * Housekeeping that keeps old security data from piling up (and, for the audit trail, from being kept longer than needed):
 *   - accounts whose e-mail address was never confirmed are deleted after UNVERIFIED_PURGE_HOURS (they hold nothing: they could not send, pay or export);
 *   - used or expired e-mail links, 7 days after;
 *   - ended sessions, 30 days after;
 *   - audit rows older than AUDIT_RETENTION_DAYS (the one thing allowed to delete from the append-only table);
 *   - the payload of a finished parked reply (it holds a participant's number);
 *   - accounts whose erasure was asked for and whose grace period is over (DAT-01), and the financial archive rows past their retention.
 */
export async function runRetention(now = new Date()) {
  const day = 86_400_000;
  const unverified = await prisma.user.deleteMany({
    where: {
      emailVerifiedAt: null,
      createdAt: { lt: new Date(now.getTime() - env.UNVERIFIED_PURGE_HOURS * 3_600_000) },
      // Belt and braces: never remove an account that somehow holds money or a connected number.
      transactions: { none: {} }, whatsappAccounts: { none: {} }, walletEntries: { none: {} },
    },
  });
  const tokens = await prisma.emailToken.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date(now.getTime() - 7 * day) } }, { usedAt: { lt: new Date(now.getTime() - 7 * day) } }] } });
  const sessions = await prisma.authSession.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date(now.getTime() - 30 * day) } }, { revokedAt: { lt: new Date(now.getTime() - 30 * day) } }] } });
  const audit = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('sf.audit_purge', 'on', true)`;
    return tx.auditLog.deleteMany({ where: { at: { lt: new Date(now.getTime() - env.AUDIT_RETENTION_DAYS * day) } } });
  });
  // A reply that was parked for retry holds the participant's number (encrypted) and the message: once the job is over, neither is needed.
  const parked = await prisma.$executeRaw`UPDATE "SendJob" SET "payload" = NULL WHERE "kind" = 'session_message' AND "status" IN ('done', 'failed') AND "payload" IS NOT NULL`;
  const accounts = await runAccountRetention(now);
  return { accountsDeleted: accounts.deleted, accountDeletionsPostponed: accounts.postponed, financialArchiveRows: accounts.archiveRows, unverifiedAccounts: unverified.count, emailTokens: tokens.count, sessions: sessions.count, auditRows: audit.count, parkedPayloads: parked };
}
