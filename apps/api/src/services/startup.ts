import { canonicalEmail } from '../lib/email';
import { prisma } from '../lib/prisma';
import { withLock } from '../lib/redis';

interface Log { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void }

/**
 * One-off data fixes that run when the API starts, before it takes a request (and when the seed runs). Each is safe to run again.
 * They exist because `prisma db push` (local development) and `prisma migrate deploy` (production) both change the TABLES, but only the application can
 * compute what goes into the new columns (encryption and keyed hashes need the secret keys).
 */
export async function prepareDatabase(log: Log = console): Promise<void> {
  await withLock('startup-backfills', async () => {
    await markLegacyAccountsVerified(log);
    await fillEmailCanonical(log);
    await encryptContacts(log);
    await guardAuditLog();
  }, { ttlMs: 10 * 60_000, waitMs: 120_000 });
}

/** Accounts that existed before e-mail confirmation was introduced are treated as confirmed, once. Everything created afterwards must confirm. */
async function markLegacyAccountsVerified(log: Log): Promise<void> {
  const name = 'email-verified-legacy-v1';
  if (await prisma.backfill.findUnique({ where: { name } })) return;
  const r = await prisma.$executeRaw`UPDATE "User" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL`;
  await prisma.backfill.create({ data: { name } });
  if (r) log.info({ accounts: r }, 'accounts created before e-mail confirmation were marked as confirmed');
}

/** `emailCanonical` for accounts that predate it. A clash (two old accounts that are one mailbox) keeps the plain address so both keep working. */
async function fillEmailCanonical(log: Log): Promise<void> {
  for (;;) {
    const rows = await prisma.user.findMany({ where: { emailCanonical: null }, select: { id: true, email: true }, take: 500 });
    if (!rows.length) return;
    for (const u of rows) {
      const wanted = canonicalEmail(u.email);
      for (const value of [wanted, u.email.toLowerCase()]) {
        try { await prisma.$executeRaw`UPDATE "User" SET "emailCanonical" = ${value} WHERE "id" = ${u.id} AND "emailCanonical" IS NULL`; break; }
        catch { if (value === u.email.toLowerCase()) log.warn({ userId: u.id }, 'could not set the canonical e-mail of an old account'); }
      }
    }
    if (rows.length < 500) return;
  }
}

/** Contacts written before encryption existed: read them as they are (plain), write them back (encrypted, with the keyed hash of the number). */
async function encryptContacts(log: Log): Promise<void> {
  let done = 0;
  for (;;) {
    const rows = await prisma.contact.findMany({ where: { phoneHash: null }, select: { id: true, name: true, phone: true }, take: 500 });
    if (!rows.length) break;
    await prisma.$transaction(rows.map((c) => prisma.contact.update({ where: { id: c.id }, data: { name: c.name, phone: c.phone } })));
    done += rows.length;
  }
  if (done) log.info({ contacts: done }, 'existing contacts were encrypted');
}

/**
 * The audit trail only ever grows: a trigger refuses any UPDATE, and refuses a DELETE unless the retention job says so for its own transaction
 * (`SET LOCAL sf.audit_purge = 'on'`). Installed here as well as in the migration because `db push` (development) does not run migration SQL.
 */
export async function guardAuditLog(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION sf_audit_log_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'the audit log is append-only'; END IF;
      IF TG_OP = 'DELETE' AND coalesce(current_setting('sf.audit_purge', true), '') <> 'on' THEN RAISE EXCEPTION 'the audit log is append-only'; END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS sf_audit_log_guard ON "AuditLog"`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER sf_audit_log_guard BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION sf_audit_log_guard()`);
}
