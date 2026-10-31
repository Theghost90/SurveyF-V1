/**
 * An encrypted copy of the whole database (DAT-02). One file per run, sealed with AES-256-GCM as it is written (the plain dump never touches the disk),
 * with a manifest beside it (checksum and the row count of every table). Reads only; it changes nothing in the database.
 *
 *   node --env-file=.env scripts/backup.mjs                 take a backup into ./backups (or BACKUP_DIR) and delete the ones older than BACKUP_KEEP_DAYS
 *   node scripts/backup.mjs --new-key                       print a fresh key line for BACKUP_KEYS, once, and stop. Store it in TWO places that are not this server
 *   node --env-file=.env scripts/backup.mjs --dir <folder>  another folder
 *   node --env-file=.env scripts/backup.mjs --restore-into <postgres url | env> [--file <backup>]   (env: the address is read from RESTORE_TARGET_URL)
 *                                                           THE RECOVERY: restore the newest backup (or --file) into a NEW, EMPTY database and compare it with the
 *                                                           manifest. Refuses a database that has any table in it. Then point DATABASE_URL at it (docs/BACKUP_RESTORE.md)
 *
 * Needs the PostgreSQL client tools (pg_dump) of the server's major version on the PATH, or PG_BIN set to their folder. Run `restore-test` after the first backup and
 * then every week: a backup nobody has restored is a hope, not a backup. Read docs/BACKUP_RESTORE.md before relying on any of this.
 */
import path from 'node:path';
import { createBackup, listBackups, pruneBackups, restoreInto } from './lib/backup.mjs';
import { newKeyLine, parseKeyRing } from './lib/sealed-file.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const die = (m) => { console.error(`backup: ${m}`); process.exit(1); };

if (args.includes('--new-key')) {
  console.log(newKeyLine());
  console.error('\nPut that line in BACKUP_KEYS (add it to the END of an existing list when replacing a key, so old backups still open).\nKeep a second copy somewhere that is not this server: a lost key makes every backup unreadable, for good.');
  process.exit(0);
}

let ring;
try { ring = parseKeyRing(process.env.BACKUP_KEYS); } catch (e) { die(e.message); }
const dir = path.resolve(opt('dir') || process.env.BACKUP_DIR || 'backups'); // (|| not ??: a blank BACKUP_DIR= in .env is "not set", not "here")

if (opt('restore-into')) {
  // `--restore-into env` reads the address from RESTORE_TARGET_URL, so that a password need not be typed on a command line other users of the machine can list
  const targetUrl = opt('restore-into') === 'env' ? process.env.RESTORE_TARGET_URL : opt('restore-into');
  if (!targetUrl) die('RESTORE_TARGET_URL is not set');
  const file = opt('file') ? path.resolve(opt('file')) : listBackups(dir)[0];
  if (!file) die(`no backup found in ${dir}`);
  try {
    const r = await restoreInto({ file, ring, targetUrl });
    if (!r.ok) die(`the restore did not check out:\n  - ${r.problems.join('\n  - ')}`);
    console.log(`backup: restored ${path.basename(file)} into the new database: ${r.tables} tables, ${r.rows} rows, all matching the manifest.\nNext: point DATABASE_URL at it, check migrations (npx prisma migrate status --config apps/api/prisma.config.ts), start the API, sign in.`);
    process.exit(0);
  } catch (e) { die(e.message); }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) die('DATABASE_URL is not set');
const keepDays = Number(process.env.BACKUP_KEEP_DAYS || 30);
if (!Number.isFinite(keepDays) || keepDays < 1) die('BACKUP_KEEP_DAYS must be a number of days, 1 or more');

try {
  const { file, manifest } = await createBackup({ databaseUrl, dir, ring });
  const rows = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
  console.log(`backup: wrote ${path.relative(process.cwd(), file)} (${(manifest.bytes / 1024).toFixed(0)} KiB sealed with key "${manifest.keyId}", ${Object.keys(manifest.tables).length} tables, ${rows} rows)`);
  const removed = pruneBackups({ dir, keepDays });
  if (removed.length) console.log(`backup: removed ${removed.length} older than ${keepDays} days`);
  console.log('backup: now run the restore test (npm run restore:test) if none has been run in the last week');
} catch (e) {
  die(e.message);
}
