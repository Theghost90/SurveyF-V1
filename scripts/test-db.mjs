/**
 * Prepares the database the API tests use (`surveyflow_test`, see apps/api/vitest.config.ts): creates it when it is missing and applies every migration to it.
 * Safe to run any number of times (`migrate deploy` only applies what is missing) and it never touches the development database `surveyflow`.
 * `npm test` runs it first: on a new computer the tests used to fail with `relation "AuditLog" does not exist`.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = path.join(root, 'apps/api');
const TEST_DB = 'surveyflow_test';
const base = 'postgresql://surveyflow:surveyflow@127.0.0.1:5432';
const die = (m) => { console.error(`test-db: ${m}`); process.exit(1); };

const { Client } = createRequire(path.join(api, 'package.json'))('pg');
const admin = new Client({ connectionString: `${base}/postgres` });
try { await admin.connect(); } catch (e) { die(`cannot reach Postgres at 127.0.0.1:5432 (${e.message}). Start it first: docker compose up -d`); }
const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
if (!rowCount) { await admin.query(`CREATE DATABASE ${TEST_DB}`); console.log(`test-db: created ${TEST_DB}`); }
await admin.end();

const prisma = createRequire(path.join(api, 'package.json')).resolve('prisma/build/index.js');
const r = spawnSync(process.execPath, [prisma, 'migrate', 'deploy'], { cwd: api, stdio: 'inherit', env: { ...process.env, DATABASE_URL: `${base}/${TEST_DB}` } });
if (r.status !== 0) die('applying the migrations failed (see above)');
console.log(`test-db: ${TEST_DB} is up to date`);
