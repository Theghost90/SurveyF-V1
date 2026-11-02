import { createHash } from 'node:crypto';
import { env } from '../config/env';
import { redis } from '../lib/redis';
import { sendMail } from '../services/mail';
import { lastBeat } from './heartbeat';
import { buildJobs } from './scheduler';

/**
 * Is every background job still running? (OPS-05.) The jobs may run inside the API or in a worker of their own; either way a stopped process says nothing. So THIS runs in the API
 * process (the one thing that is certainly up when somebody is using the product) and looks at the heartbeats the jobs leave: a job is late when its last heartbeat is older than
 * three of its own intervals and a minute, and missing when it never left one after the start-up grace. One e-mail a day to the operator while the same jobs stay late.
 *
 * What it cannot see: a job that keeps running and does the wrong thing. It watches that jobs run, not what they decide.
 */
export type JobState = 'ok' | 'late' | 'missing' | 'failing';
export interface JobStatus { name: string; state: JobState; lastAt: string | null; everyMs: number; error?: string }
export interface JobHealth { overall: 'ok' | 'late' | 'starting'; jobs: JobStatus[] }

const quiet = { info: () => undefined, error: () => undefined };

export async function jobHealth(now = new Date(), startedAt = now, graceMs = 5 * 60_000): Promise<JobHealth> {
  const jobs: JobStatus[] = [];
  for (const j of buildJobs(quiet)) {
    const b = await lastBeat(j.name);
    if (!b) { jobs.push({ name: j.name, state: now.getTime() - startedAt.getTime() > graceMs + j.initialDelay ? 'missing' : 'ok', lastAt: null, everyMs: j.ms }); continue; }
    const age = now.getTime() - new Date(b.at).getTime();
    jobs.push({ name: j.name, state: age > 3 * j.ms + 60_000 ? 'late' : b.ok ? 'ok' : 'failing', lastAt: b.at, everyMs: j.ms, ...(b.error ? { error: b.error } : {}) });
  }
  const bad = jobs.some((j) => j.state === 'late' || j.state === 'missing');
  const anyBeat = jobs.some((j) => j.lastAt);
  return { overall: bad ? 'late' : anyBeat ? 'ok' : 'starting', jobs };
}

type WatchLog = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/** One look. Logs the late jobs and, at most once a day for the same set of jobs, tells the operator. Returns the jobs that were late. */
export async function watchOnce(log: WatchLog, startedAt: Date, now = new Date()): Promise<JobStatus[]> {
  const h = await jobHealth(now, startedAt);
  const bad = h.jobs.filter((j) => j.state === 'late' || j.state === 'missing');
  if (!bad.length) return [];
  log.error({ jobs: bad.map((j) => `${j.name}:${j.state}`) }, 'background jobs are not running');
  if (!env.OPERATOR_EMAIL) return bad;
  const sig = createHash('sha256').update(bad.map((j) => j.name).sort().join(',')).digest('hex').slice(0, 16);
  if ((await redis.set(`sf:watchdog:${sig}`, '1', 'EX', 86_400, 'NX')) !== 'OK') return bad; // the same jobs late: one mail a day, from whichever replica saw it first
  await sendMail(env.OPERATOR_EMAIL, 'jobs_late', 'en', { items: bad.map((j) => `${j.name}: ${j.state === 'missing' ? 'has not run since this server started' : `last ran ${j.lastAt}, should run every ${Math.round(j.everyMs / 60_000)} min`}`) });
  return bad;
}

/** Runs from the API process. Returns what stops it. */
export function startWatchdog(log: WatchLog, every = 10 * 60_000): () => void {
  const startedAt = new Date();
  const check = () => watchOnce(log, startedAt).catch((err) => log.error({ err }, 'job watchdog failed'));
  const t = setInterval(() => void check(), every).unref();
  const first = setTimeout(() => void check(), 6 * 60_000).unref();
  return () => { clearInterval(t); clearTimeout(first); };
}
