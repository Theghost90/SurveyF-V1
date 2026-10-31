/**
 * Proves that a backup can be brought back (DAT-02). Opens the newest backup (or `--file`) with BACKUP_KEYS, restores it into a scratch database that it creates
 * and drops, and checks: the file matches its checksum, every table came back with exactly the rows that were backed up, and participants' names and numbers decrypt
 * with the application's own ENCRYPTION_KEYS (a restored database whose keys are gone is data nobody can read). Your real database is not touched.
 *
 *   npx tsx --env-file=.env scripts/restore-test.mts [--file backups/surveyflow-....dump.sfbk] [--dir backups]
 *
 * The result is appended to `restore-tests.jsonl` next to the backups; `scripts/preflight.mts --only backup` reads it. Exit code 0 only when everything checked out.
 * Needs the PostgreSQL client tools (pg_restore) and a role that may CREATE DATABASE; on a host where it may not, run this against a scratch server (DATABASE_URL pointing there).
 */
import path from 'node:path';
import { listBackups, verifyBackup } from './lib/backup.mjs';
import { parseKeyRing } from './lib/sealed-file.mjs';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const die = (m: string): never => { console.error(`restore-test: ${m}`); process.exit(1); };

const databaseUrl = process.env.DATABASE_URL ?? die('DATABASE_URL is not set');
let ring;
try { ring = parseKeyRing(process.env.BACKUP_KEYS); } catch (e) { die((e as Error).message); }
const dir = path.resolve(opt('dir') || process.env.BACKUP_DIR || 'backups');
const file = opt('file') ? path.resolve(opt('file')!) : listBackups(dir)[0];
if (!file) die(`no backup found in ${dir}. Run: node --env-file=.env scripts/backup.mjs`);

const { decryptSecret, isCiphertext } = await import('../apps/api/src/lib/crypto');

/** Names and numbers are stored encrypted: read some from the restored copy and decrypt them with the application's key ring. */
async function participantsDecrypt(db: { query: (sql: string) => Promise<{ rows: Array<{ name: string; phone: string }> }> }): Promise<string[]> {
  const { rows } = await db.query('SELECT name, phone FROM "Contact" ORDER BY "createdAt" DESC LIMIT 50');
  if (!rows.length) { console.log('restore-test: the database holds no participants, so the decryption check had nothing to read'); return []; }
  let plain = 0;
  for (const row of rows) {
    for (const value of [row.name, row.phone]) {
      if (!isCiphertext(value)) { plain++; continue; }
      try { decryptSecret(value); } catch { return ['participants came back, but ENCRYPTION_KEYS cannot decrypt them: the application keys are not the ones that protected this data']; }
    }
  }
  if (plain) console.log(`restore-test: ${plain} of ${rows.length * 2} values were not encrypted at rest (older rows are encrypted on their next write, scripts/rotate-keys.mts --apply does it now)`);
  return [];
}

console.log(`restore-test: restoring ${path.relative(process.cwd(), file)} into a scratch database…`);
const result = await verifyBackup({ file, ring: ring!, databaseUrl, extraCheck: participantsDecrypt });
if (result.ok) {
  console.log(`restore-test: PASS in ${result.seconds}s, ${result.rows} rows came back and match the manifest. Recorded in ${path.join(path.relative(process.cwd(), dir), 'restore-tests.jsonl')}`);
  process.exit(0);
}
console.error(`restore-test: FAIL\n  - ${result.problems.join('\n  - ')}`);
process.exit(1);
