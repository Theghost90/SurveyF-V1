import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBackup, listBackups, pruneBackups, readRestoreLog, restoreInto, verifyBackup } from '../lib/backup.mjs';
import { newKeyLine, open, parseKeyRing, seal } from '../lib/sealed-file.mjs';

/**
 * DAT-02: encrypted backups and the restore test. The first half needs nothing but Node. The second half takes a real dump and restores it into a real scratch
 * database, so it needs the PostgreSQL tools and the local server (`npm test` has just prepared it); without them it says so and skips, it never passes silently.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'sf-backup-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const ringOf = (...lines) => parseKeyRing(lines.join(','));
const k1 = `k1:${randomBytes(32).toString('base64')}`;
const k2 = `k2:${randomBytes(32).toString('hex')}`;
const collect = async (it) => { const parts = []; for await (const p of it) parts.push(Buffer.from(p)); return Buffer.concat(parts); };
const sealed = (data, ring, chunk = 64) => collect(seal([data], ring, { chunk }));
const unsealed = (data, ring) => collect(open([data], ring));
const sample = randomBytes(1000);

describe('a sealed file (AES-256-GCM in authenticated chunks)', () => {
  it('opens to exactly what went in, whatever its size against the chunk: empty, one byte, exact multiples, many chunks', async () => {
    const ring = ringOf(k1);
    for (const n of [0, 1, 63, 64, 65, 128, 1000]) {
      const data = sample.subarray(0, n);
      assert.deepEqual(await unsealed(await sealed(data, ring), ring), data, `${n} bytes`);
    }
  });

  it('hides the content: a recognisable phrase does not appear in what is written', async () => {
    const ring = ringOf(k1);
    const phrase = Buffer.from('a participant called Amina Tchoumi, +237677123456');
    const out = await sealed(Buffer.concat([Buffer.alloc(500), phrase, Buffer.alloc(500)]), ring);
    assert.equal(out.includes(phrase), false);
    assert.equal(out.includes(Buffer.from('Amina')), false);
  });

  it('refuses a changed byte anywhere in the file, in the header, a length, the data or a tag', async () => {
    const ring = ringOf(k1);
    const out = await sealed(sample, ring);
    for (let i = 0; i < out.length; i += 7) {
      const bad = Buffer.from(out);
      bad[i] ^= 0x01;
      await assert.rejects(unsealed(bad, ring), undefined, `byte ${i} of ${out.length} was changed and the file still opened`);
    }
  });

  it('refuses a copy that is cut short, at a chunk boundary or in the middle of one, and one with a byte too many', async () => {
    const ring = ringOf(k1);
    const out = await sealed(sample, ring);
    for (const cut of [out.length - 1, out.length - 40, Math.floor(out.length / 2), 20, 5]) await assert.rejects(unsealed(out.subarray(0, cut), ring), undefined, `cut at ${cut}`);
    // a whole chunk cut off at its boundary: the header is 6+1+2+8 = 17 bytes, each chunk 4 + 64 + 16 = 84 bytes
    await assert.rejects(unsealed(out.subarray(0, 17 + 84 * 3), ring), /truncated/);
    await assert.rejects(unsealed(Buffer.concat([out, Buffer.from([0])]), ring), /extra bytes/);
  });

  it('refuses chunks that are swapped or repeated', async () => {
    const ring = ringOf(k1);
    const out = await sealed(sample, ring);
    const head = out.subarray(0, 17);
    const chunks = [];
    for (let at = 17; at < out.length;) { const len = out.readUInt32BE(at) & 0x7fffffff; chunks.push(out.subarray(at, at + 4 + len)); at += 4 + len; }
    assert.ok(chunks.length > 3);
    await assert.rejects(unsealed(Buffer.concat([head, chunks[1], chunks[0], ...chunks.slice(2)]), ring));
    await assert.rejects(unsealed(Buffer.concat([head, chunks[0], chunks[0], ...chunks.slice(1)]), ring));
  });

  it('refuses the wrong key, and says which key it needs without ever printing a key', async () => {
    const out = await sealed(sample, ringOf(k1));
    await assert.rejects(unsealed(out, ringOf(k2)), (e) => /named "k1"/.test(e.message) && !e.message.includes(k1.split(':')[1]));
    const sameName = ringOf(`k1:${randomBytes(32).toString('base64')}`);
    await assert.rejects(unsealed(out, sameName), /does not authenticate/);
    await assert.rejects(unsealed(Buffer.from('definitely not a backup'), ringOf(k1)), /not a sealed/);
  });

  it('a key can be replaced without losing the old backups: the first key seals, every key opens', async () => {
    const old = await sealed(sample, ringOf(k1));
    const ring = ringOf(k2, k1);
    assert.deepEqual(await unsealed(old, ring), sample);
    const fresh = await sealed(sample, ring);
    assert.equal(fresh.subarray(7, 9).toString(), 'k2');
    assert.deepEqual(await unsealed(fresh, ring), sample);
  });

  it('two files of the same data are different (a fresh nonce prefix each time)', async () => {
    const ring = ringOf(k1);
    assert.notDeepEqual(await sealed(sample, ring), await sealed(sample, ring));
  });
});

describe('the key list', () => {
  it('accepts base64 and hex, makes new keys that parse, and refuses a malformed list with a sentence and no key in it', () => {
    assert.equal(ringOf(k1, k2).keys.size, 2);
    assert.equal(ringOf(k1, k2).active[0], 'k1');
    assert.equal(parseKeyRing(newKeyLine('b9')).active[0], 'b9');
    for (const bad of ['', '   ', 'nokeyname', 'k1:short', ':abc', 'bad name:aaaa', `${k1},${k1}`]) assert.throws(() => parseKeyRing(bad), (e) => !/[A-Za-z0-9+/]{40,}/.test(e.message));
  });
});

describe('the command line, with an environment as a fresh copy of .env.example leaves it', () => {
  it('a blank BACKUP_DIR and BACKUP_KEEP_DAYS mean "not set": the defaults apply, and nothing is written next to where the command was run', () => {
    const cwd = path.join(tmp, 'cwd');
    mkdirSync(cwd);
    const run = (args, env) => spawnSync(process.execPath, [path.join(root, 'scripts/backup.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, BACKUP_DIR: '', BACKUP_KEEP_DAYS: '', DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/none', ...env } });
    const key = run(['--new-key']).stdout.trim();
    const r = run([], { BACKUP_KEYS: key }); // cannot connect: the point is where it looks and what it leaves
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /BACKUP_KEEP_DAYS/, 'a blank BACKUP_KEEP_DAYS was read as 0');
    assert.deepEqual(readdirSync(cwd).filter((n) => /sfbk|json/.test(n)), []);
    const noKey = run([], { BACKUP_KEYS: '' });
    assert.match(noKey.stderr, /BACKUP_KEYS is empty/);
  });
});

describe('pruning old backups', () => {
  it('removes only old files of the exact name this tool writes, never the newest three, and takes the manifest with them', () => {
    const dir = path.join(tmp, 'prune');
    mkdirSync(dir);
    const names = ['20250101-010000', '20250102-010000', '20260101-010000', '20260102-010000', '20260103-010000', '20260601-010000'].map((s) => `surveyflow-${s}.dump.sfbk`);
    for (const n of names) { writeFileSync(path.join(dir, n), 'x'); writeFileSync(path.join(dir, `${n}.json`), '{}'); }
    writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
    writeFileSync(path.join(dir, 'surveyflow-20240101-010000.dump.sfbk.partial'), 'keep me too');
    const removed = pruneBackups({ dir, keepDays: 30, now: new Date('2026-06-02T00:00:00Z') });
    assert.deepEqual(removed.sort(), [names[0], names[1], names[2]].sort());
    assert.equal(listBackups(dir).length, 3);
    assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('surveyflow-2026')).sort(), ['notes.txt', 'surveyflow-20240101-010000.dump.sfbk.partial']);
    // everything is old, but the newest three stay
    assert.deepEqual(pruneBackups({ dir, keepDays: 1, now: new Date('2030-01-01T00:00:00Z') }), []);
    assert.equal(listBackups(dir).length, 3);
  });
});

// ---- against a real PostgreSQL --------------------------------------------------------------------------------------------------

const base = 'postgresql://surveyflow:surveyflow@127.0.0.1:5432';
const { Client } = createRequire(path.join(root, 'apps/api/package.json'))('pg');
let reason = null;
if (spawnSync('pg_dump', ['--version']).error) reason = 'pg_dump is not installed';
const admin = new Client({ connectionString: `${base}/postgres` });
if (!reason) { try { await admin.connect(); } catch (e) { reason = `no PostgreSQL at 127.0.0.1:5432 (${e.message})`; } }

describe('a real dump and a real restore', { skip: reason ?? false }, () => {
  const name = `surveyflow_backup_probe_${randomBytes(3).toString('hex')}`;
  const url = `${base}/${name}`;
  const marker = `MARKER-${randomBytes(6).toString('hex')}`;
  const dir = path.join(tmp, 'real');
  const ring = ringOf(k1);
  let db;

  it('set up: a small database with a recognisable value in it', async () => {
    await admin.query(`CREATE DATABASE ${name}`);
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query('CREATE TABLE "Person" (id serial PRIMARY KEY, label text NOT NULL)');
    await db.query('CREATE TABLE "Empty" (id int)');
    await db.query(`INSERT INTO "Person"(label) SELECT $1 || '-' || g FROM generate_series(1, 1500) g`, [marker]);
  });

  it('writes a sealed file and a manifest, with no plain copy and no partial file, and the manifest counts what is in the database', async () => {
    const { file, manifest } = await createBackup({ databaseUrl: url, dir, ring, chunk: 4096 });
    assert.ok(file.endsWith('.dump.sfbk'));
    assert.deepEqual(manifest.tables, { Person: 1500, Empty: 0 });
    assert.equal(manifest.keyId, 'k1');
    assert.equal(statSync(file).size, manifest.bytes);
    assert.ok(manifest.bytes > 4096 * 2, 'long enough to be several chunks');
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.partial')), []);
    assert.equal(readFileSync(file).includes(Buffer.from(marker)), false, 'the plain value is visible in the backup file');
    assert.equal(JSON.stringify(manifest).includes(url), false);
    assert.equal(JSON.stringify(manifest).includes('surveyflow:'), false, 'no credentials in the manifest');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0, 'readable by its owner only');
  });

  it('the restore test brings it back into a scratch database that it removes afterwards, and records the result', async () => {
    const result = await verifyBackup({ file: listBackups(dir)[0], ring, databaseUrl: url });
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
    assert.equal(result.rows, 1500);
    const left = await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE 'surveyflow\\_restore\\_%'`);
    assert.deepEqual(left.rows, [], 'a scratch database was left behind');
    const log = readRestoreLog(dir);
    assert.equal(log.at(-1).ok, true);
    assert.equal(log.at(-1).file, path.basename(listBackups(dir)[0]));
  });

  it('the restore test fails, and says why, for a file changed after it was written', async () => {
    const original = listBackups(dir)[0]; // (the copy below is dated later, so it would become "the newest")
    const copy = path.join(dir, 'surveyflow-20990101-000000.dump.sfbk');
    copyFileSync(original, copy);
    copyFileSync(`${original}.json`, `${copy}.json`);
    const bytes = readFileSync(copy);
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    writeFileSync(copy, bytes);
    try {
      const result = await verifyBackup({ file: copy, ring, databaseUrl: url });
      assert.equal(result.ok, false);
      assert.match(result.problems.join(), /checksum/);
      assert.equal(readRestoreLog(dir).at(-1).ok, false);
    } finally { rmSync(copy, { force: true }); rmSync(`${copy}.json`, { force: true }); }
  });

  it('the restore test fails for the wrong key, and for a table that comes back with other rows than were backed up', async () => {
    const wrong = await verifyBackup({ file: listBackups(dir)[0], ring: ringOf(k2), databaseUrl: url });
    assert.equal(wrong.ok, false);
    assert.match(wrong.problems.join(), /key/);
    const first = listBackups(dir)[0];
    const manifest = JSON.parse(readFileSync(`${first}.json`, 'utf8'));
    writeFileSync(`${first}.json`, JSON.stringify({ ...manifest, tables: { ...manifest.tables, Person: 1499 } }));
    const off = await verifyBackup({ file: first, ring, databaseUrl: url });
    assert.equal(off.ok, false);
    assert.match(off.problems.join(), /Person: 1500 rows restored, 1499 were backed up/);
    writeFileSync(`${first}.json`, JSON.stringify(manifest));
    const extra = await verifyBackup({ file: first, ring, databaseUrl: url, extraCheck: async () => ['a participant could not be decrypted'] });
    assert.deepEqual(extra.problems, ['a participant could not be decrypted']);
    const left = await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE 'surveyflow\\_restore\\_%'`);
    assert.deepEqual(left.rows, [], 'a failed restore test left its scratch database behind');
  });

  it('the recovery restores into a new empty database and matches the manifest, and REFUSES a database that already has a table (it never overwrites)', async () => {
    const target = `surveyflow_backup_probe_${randomBytes(3).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${target}`);
    try {
      const file = listBackups(dir)[0];
      const ok = await restoreInto({ file, ring, targetUrl: `${base}/${target}` });
      assert.deepEqual(ok.problems, []);
      assert.equal(ok.rows, 1500);
      const check = new Client({ connectionString: `${base}/${target}` });
      await check.connect();
      assert.equal((await check.query('SELECT count(*)::int AS n FROM "Person" WHERE label LIKE $1', [`${marker}%`])).rows[0].n, 1500);
      await check.end();
      // the live probe database has tables: nothing may be restored into it, and nothing in it changes
      await assert.rejects(restoreInto({ file, ring, targetUrl: url }), /already has 2 table/);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM "Person"')).rows[0].n, 1500);
      // a changed file is refused before anything is written
      const bad = path.join(dir, 'surveyflow-20980101-000000.dump.sfbk');
      const bytes = readFileSync(file); bytes[bytes.length - 3] ^= 1;
      writeFileSync(bad, bytes); copyFileSync(`${file}.json`, `${bad}.json`);
      try { const r = await restoreInto({ file: bad, ring, targetUrl: `${base}/${target}` }); assert.equal(r.ok, false); assert.match(r.problems.join(), /checksum/); }
      finally { rmSync(bad, { force: true }); rmSync(`${bad}.json`, { force: true }); }
    } finally { await admin.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`); }
  });

  it('the command line with a blank BACKUP_DIR (as .env.example leaves it) writes to ./backups, not to the folder it was run from', () => {
    const cwd = path.join(tmp, 'cwd-real');
    mkdirSync(cwd);
    const env = { ...process.env, BACKUP_DIR: '', BACKUP_KEEP_DAYS: '', DATABASE_URL: url, BACKUP_KEYS: k1 };
    const r = spawnSync(process.execPath, [path.join(root, 'scripts/backup.mjs')], { cwd, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(cwd), ['backups']);
    assert.equal(readdirSync(path.join(cwd, 'backups')).filter((n) => n.endsWith('.dump.sfbk')).length, 1);
  });

  it('a backup that cannot be taken leaves nothing that looks like one', async () => {
    const failDir = path.join(tmp, 'fail');
    await assert.rejects(createBackup({ databaseUrl: `${base}/surveyflow_no_such_database`, dir: failDir, ring }));
    const saved = process.env.PG_BIN;
    process.env.PG_BIN = path.join(tmp, 'no-tools-here');
    try { await assert.rejects(createBackup({ databaseUrl: url, dir: failDir, ring }), /pg_dump was not found/); }
    finally { if (saved === undefined) delete process.env.PG_BIN; else process.env.PG_BIN = saved; }
    assert.deepEqual(readdirSync(failDir), []);
  });

  it('clean up', async () => {
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
});
