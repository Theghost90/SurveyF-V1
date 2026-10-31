/**
 * Encrypted database backups and the restore test (DAT-02). Used by `scripts/backup.mjs`, `scripts/restore-test.mts`, `scripts/preflight.mts` and the tests.
 *
 * Containment, in the order the backlog gives it ("managed encryption, restore tests", and the risk it names: a lost key):
 *   - the dump is encrypted AS IT IS WRITTEN (pg_dump's output goes straight into `seal`): there is never a plain copy on the disk, in a temp folder or in a pipe file;
 *   - a file is only called a backup once it is complete (written as `.partial`, renamed at the end), and its manifest records its SHA-256, so a half-written or damaged
 *     file is found before the day it is needed;
 *   - the manifest holds the exact row count of every table at the moment of the dump (the dump and the counts come from ONE exported snapshot, so they agree), which is
 *     what the restore test compares the restored copy with;
 *   - the restore test restores into a scratch database it creates and drops, refuses to touch any other name, and writes its result next to the backups, where
 *     the preflight reads it: an untested backup is reported as untested;
 *   - the key lives in BACKUP_KEYS, never in the backup folder, and a test proves that the key you hold opens the backups you hold.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { open, seal } from './sealed-file.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { Client } = createRequire(path.join(root, 'apps/api/package.json'))('pg');

export const BACKUP_NAME = /^surveyflow-(\d{8})-(\d{6})\.dump\.sfbk$/;
export const RESTORE_LOG = 'restore-tests.jsonl';
const SCRATCH_NAME = /^surveyflow_restore_[0-9a-f]{8}$/;
const quote = (identifier) => `"${String(identifier).replace(/"/g, '""')}"`;

/** The PG* variables for the PostgreSQL tools, taken from a connection URL, so that the password is never on a command line. */
export function pgEnv(connectionString, database) {
  const u = new URL(connectionString);
  const env = { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGDATABASE: database ?? decodeURIComponent(u.pathname.slice(1)) };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  else delete env.PGPASSWORD;
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}

/** `PG_BIN` is the folder of the PostgreSQL client tools, for a computer where they are not on the PATH (typically Windows). */
export const pgTool = (name) => (process.env.PG_BIN ? path.join(process.env.PG_BIN, name) : name);

const missing = (name) => new Error(`${name} was not found. Install the PostgreSQL client tools (the same major version as the server, 16) or set PG_BIN to their folder`);

/** Starts a PostgreSQL tool; resolves with its exit code and what it said on stderr. */
function start(tool, args, env) {
  const child = spawn(pgTool(tool), args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(e.code === 'ENOENT' ? missing(tool) : e));
    child.on('close', (code) => resolve({ code, stderr: stderr.trim() }));
  });
  return { child, done };
}

/** The exact number of rows of every table of the public schema, through one client (so inside one snapshot when the client is inside a transaction). */
export async function tableCounts(client) {
  const { rows } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`);
  const counts = {};
  for (const { table_name: t } of rows) counts[t] = Number((await client.query(`SELECT count(*)::text AS n FROM ${quote(t)}`)).rows[0].n);
  return counts;
}

async function* hashing(source, hash, tally) {
  for await (const part of source) { hash.update(part); tally.bytes += part.length; yield part; }
}

const stampOf = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * Takes one backup into `dir`. Returns { file, manifest }. Throws (and leaves no file that looks like a backup) when anything fails.
 * `chunk` is only for tests.
 */
export async function createBackup({ databaseUrl, dir, ring, now = new Date(), chunk }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `surveyflow-${stampOf(now)}.dump.sfbk`);
  const partial = `${file}.partial`;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // One snapshot for both: the counts in the manifest are the counts of exactly what pg_dump reads.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const tables = await tableCounts(client);
    const { child, done } = start('pg_dump', ['--format=custom', '--no-owner', '--no-acl', `--snapshot=${snapshot}`], pgEnv(databaseUrl));
    child.stdin.end();
    const hash = createHash('sha256');
    const tally = { bytes: 0 };
    try {
      const written = pipeline(Readable.from(hashing(seal(child.stdout, ring, { chunk }), hash, tally)), createWriteStream(partial, { mode: 0o600 }));
      const [result] = await Promise.all([done, written]);
      if (result.code !== 0) throw new Error(`pg_dump failed (exit ${result.code}): ${result.stderr || 'no message'}`);
    } catch (e) {
      try { unlinkSync(partial); } catch { /* nothing was written */ }
      throw e;
    }
    renameSync(partial, file);
    const version = (await client.query('SHOW server_version')).rows[0].server_version;
    const manifest = {
      format: 'surveyflow-backup', version: 1, createdAt: now.toISOString(), database: new URL(databaseUrl).pathname.slice(1), serverVersion: version,
      file: path.basename(file), bytes: tally.bytes, sha256: hash.digest('hex'), keyId: ring.active[0], tables,
    };
    appendFileSync(`${file}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { file, manifest };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

/** Backups in `dir`, newest first. */
export function listBackups(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).sort().reverse().map((n) => path.join(dir, n));
}

export const readManifest = (file) => JSON.parse(readFileSync(`${file}.json`, 'utf8'));

const dateOfName = (name) => { const m = BACKUP_NAME.exec(name); return m ? new Date(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}Z`) : null; };

/**
 * Deletes backups older than `keepDays`, but never the newest `keepAtLeast` whatever their age (a stopped backup job must not empty the folder), and only files
 * whose name is exactly the one this tool writes.
 */
export function pruneBackups({ dir, keepDays, keepAtLeast = 3, now = new Date() }) {
  const removed = [];
  for (const file of listBackups(dir).slice(keepAtLeast)) {
    const at = dateOfName(path.basename(file));
    if (at && now.getTime() - at.getTime() > keepDays * 86_400_000) {
      unlinkSync(file);
      try { unlinkSync(`${file}.json`); } catch { /* no manifest */ }
      removed.push(path.basename(file));
    }
  }
  return removed;
}

export async function sha256OfFile(file) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}

/** Streams a sealed backup through the key into pg_restore, targeting `database` on the server of `databaseUrl`. Returns the problems found (none: it restored). */
async function restoreSealed({ file, ring, databaseUrl, database }) {
  const { child, done } = start('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--dbname', database], pgEnv(databaseUrl, database)); // host, user and password come from PG*, never the command line
  child.stdin.on('error', () => { /* pg_restore stopped reading: its own message is reported below */ });
  let opened;
  try { await pipeline(Readable.from(open(createReadStream(file), ring)), child.stdin); }
  catch (e) { opened = e; child.stdin.destroy(); }
  const result = await done;
  if (opened) return [opened.message];
  if (result.code !== 0) return [`pg_restore failed (exit ${result.code}): ${result.stderr || 'no message'}`];
  return [];
}

/**
 * The real recovery: restores a backup into a database that already exists and is EMPTY (refuses any database that has a table in it: this never overwrites anything),
 * then compares every table with the manifest. Returns { ok, problems, tables, rows }.
 */
export async function restoreInto({ file, ring, targetUrl }) {
  const manifest = readManifest(file);
  const actual = await sha256OfFile(file);
  if (actual !== manifest.sha256) return { ok: false, problems: ['the file does not match the checksum in its manifest: it was changed or damaged after it was written. Try an older backup'], tables: 0, rows: 0 };
  const target = new Client({ connectionString: targetUrl });
  await target.connect();
  try {
    const existing = Number((await target.query(`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0].n);
    if (existing) throw new Error(`the target database already has ${existing} table(s). Restore into a new, empty database (CREATE DATABASE ...); nothing was changed`);
    const problems = await restoreSealed({ file, ring, databaseUrl: targetUrl, database: new URL(targetUrl).pathname.slice(1) });
    let rows = 0;
    let tables = 0;
    if (!problems.length) {
      const got = await tableCounts(target);
      for (const [table, expected] of Object.entries(manifest.tables)) {
        if (!(table in got)) problems.push(`table ${table} did not come back`);
        else if (got[table] !== expected) problems.push(`table ${table}: ${got[table]} rows restored, ${expected} were backed up`);
        rows += got[table] ?? 0;
        tables++;
      }
    }
    return { ok: problems.length === 0, problems, tables, rows };
  } finally { await target.end().catch(() => {}); }
}

/**
 * The restore test. Opens the backup with the key, restores it into a scratch database, and compares every table's rows with the manifest.
 * `extraCheck(scratchClient)` may return more problems (the restore-test script uses it to decrypt participants with the application's own key).
 * The result is appended to `restore-tests.jsonl` in `dir`. Never touches a database other than the scratch one it creates.
 */
export async function verifyBackup({ file, ring, databaseUrl, extraCheck, now = new Date() }) {
  const started = Date.now();
  const dir = path.dirname(file);
  const problems = [];
  let manifest;
  try { manifest = readManifest(file); } catch { problems.push(`no readable manifest next to ${path.basename(file)}`); }
  if (manifest) {
    const actual = await sha256OfFile(file);
    if (actual !== manifest.sha256) problems.push('the file does not match the checksum in its manifest: it was changed or damaged after it was written');
  }
  let restored = 0;
  if (!problems.length) {
    const scratch = `surveyflow_restore_${randomBytes(4).toString('hex')}`;
    if (!SCRATCH_NAME.test(scratch)) throw new Error('refusing to use that scratch name');
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    let probe;
    try {
      await admin.query(`CREATE DATABASE ${quote(scratch)}`);
      problems.push(...(await restoreSealed({ file, ring, databaseUrl, database: scratch })));
      if (!problems.length) {
        const u = new URL(databaseUrl);
        u.pathname = `/${scratch}`;
        probe = new Client({ connectionString: u.toString() });
        await probe.connect();
        const got = await tableCounts(probe);
        for (const [table, expected] of Object.entries(manifest.tables)) {
          if (!(table in got)) problems.push(`table ${table} did not come back`);
          else if (got[table] !== expected) problems.push(`table ${table}: ${got[table]} rows restored, ${expected} were backed up`);
          restored += got[table] ?? 0;
        }
        for (const table of Object.keys(got)) if (!(table in manifest.tables)) problems.push(`table ${table} is in the restored copy but not in the manifest`);
        if (extraCheck) problems.push(...(await extraCheck(probe)));
      }
    } finally {
      await probe?.end().catch(() => {});
      if (SCRATCH_NAME.test(scratch)) await admin.query(`DROP DATABASE IF EXISTS ${quote(scratch)} WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
  const result = { at: now.toISOString(), file: path.basename(file), ok: problems.length === 0, seconds: Math.round((Date.now() - started) / 100) / 10, rows: restored, problems };
  appendFileSync(path.join(dir, RESTORE_LOG), `${JSON.stringify(result)}\n`);
  return result;
}

/** The restore tests recorded next to the backups, oldest first. */
export function readRestoreLog(dir) {
  const p = path.join(dir, RESTORE_LOG);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export const sizeOf = (file) => statSync(file).size;
