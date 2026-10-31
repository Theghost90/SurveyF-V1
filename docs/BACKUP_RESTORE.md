# Backups and restoring (DAT-02)

Law No. 2024/017 asks for "secure back-up copies" (s.27(1)) and for security measures "such as encryption" (s.22(2)). This is the part of that which lives in the repository: an **encrypted copy** of the database, a **restore test** that proves the copy can be brought back, and a **recovery command**. It is a second, independent copy; it does **not** replace the point-in-time backups your database host offers, and it does **not** encrypt the host's disk (that is a setting you check at the host, last section).

**Read first: what a lost key means.** Backups are sealed with `BACKUP_KEYS`. Without that key every backup is noise, for good; nobody, including me, can open them. The key therefore lives in **two places that are not the server** (a password manager, and a printed copy somewhere safe). Never commit it, never paste it into a chat.

## Once

1. Make a key: `node scripts/backup.mjs --new-key`. It prints one line `name:key`. Put it in `.env` as `BACKUP_KEYS=` **and** in your two safe places. Do not reuse a key of `ENCRYPTION_KEYS` (the preflight warns if you do: one leak would then open the live data and every backup).
2. Install the PostgreSQL client tools of the server's major version (16): `pg_dump` and `pg_restore` must be on the PATH, or set `PG_BIN` to their folder (typical on Windows).
3. Decide where backups go: `BACKUP_DIR` (default `./backups`, ignored by git). **Not the database's own disk**: copy the sealed files off the machine (any object storage or another computer). They are safe to copy because they are sealed; their size and dates are not secret.
4. `npm run backup`, then `npm run restore:test`. The second one must say `PASS`.

## Every day

Schedule `npm run backup` once a day (cron `17 3 * * * cd /srv/surveyflow && npm run backup`, or the Windows Task Scheduler). It takes one consistent snapshot, writes `surveyflow-YYYYMMDD-HHMMSS.dump.sfbk` and its `.json` manifest (checksum, and the row count of every table), and deletes backups older than `BACKUP_KEEP_DAYS` (30) **except the newest three**, so a stopped job cannot empty the folder. The plain dump is never written to disk: `pg_dump`'s output goes straight into the encryption.

## Every week

`npm run restore:test`. It restores the newest backup into a scratch database that it creates and drops (it refuses any other name), compares **every table's rows** with the manifest, and decrypts up to 50 participants with the application's own `ENCRYPTION_KEYS`. The result is appended to `backups/restore-tests.jsonl`. The role needs `CREATE DATABASE`; where the host does not allow it, point `DATABASE_URL` at a scratch server for this run.

`npx tsx --env-file=.env scripts/preflight.mts --only backup` reads all of that and says PASS / WARN / FAIL: a key is set (and is its own), the newest backup is under a day old and matches its checksum, a restore test passed within a week (a backup never restored **fails**), the database connection is encrypted, and what you wrote about the disk.

## The day you need it

1. Stop the API. **Do not restore over the live database.**
2. Create a new, empty database on the server (`CREATE DATABASE surveyflow_restored;`).
3. `node --env-file=.env scripts/backup.mjs --restore-into postgresql://USER:PASSWORD@HOST:5432/surveyflow_restored` (or `--restore-into env` with `RESTORE_TARGET_URL` set, so that the password is not on a command line). Add `--file <backup>` to choose one other than the newest. It **refuses a database that already has a table**, and compares every table with the manifest.
4. Keep the keys the data needs: `ENCRYPTION_KEYS` (names and numbers; without it they are unreadable), `BLIND_INDEX_KEY` (without it a participant's number is not recognised), `INTERNAL_API_SECRET`, `JWT_SECRET`. A backup is only as good as these.
5. Point `DATABASE_URL` at the restored database, check `npx prisma migrate status --config apps/api/prisma.config.ts`, start the API, sign in, send yourself a test.
6. **Re-apply the erasures made since that backup.** A restored database brings back accounts that were deleted after it was taken (`docs/SECURITY.md` §20). Nothing does this for you yet: the "account deleted" e-mails are the list.

## Replacing the key

Put the new key **first**: `BACKUP_KEYS=b2027:<new>,b2026:<old>`. New backups use the new key, old ones still open. Remove the old key only when the last backup sealed with it has been deleted.

## What this does not do (read before relying on it)

- **Tested on a local PostgreSQL 16 only**: not on any managed host, not on Windows, not on a large database. Time and memory on a large one are unmeasured (memory is constant: the file is processed in 1 MiB chunks).
- **The snapshot needs a direct connection** to the database, not a connection pooler in transaction mode.
- **The restore test compares row counts and decrypts participants**; it does not compare every value.
- **The file's mode is 0600 on Linux and macOS**; on Windows the mode is ignored and the folder's permissions apply.
- **Erased data stays in backups** until they are pruned: up to `BACKUP_KEEP_DAYS` (30 days) after an account is erased.
- **The host's disk is not encrypted by any of this.** It is the other half of finding 11 (DAT-02's host part). Cloud disks and managed databases usually offer "encryption at rest", often on by default, but **that is for you to read in your provider's own documentation for the exact product you use, and to write down where you read it** (provider, product, setting, date, in `HOST_DISK_ENCRYPTION`). The preflight prints what you wrote and says plainly that it did not check it. A self-managed server needs disk encryption set up at installation (LUKS or the provider's volume encryption); it cannot be added to a running disk by this repository.
