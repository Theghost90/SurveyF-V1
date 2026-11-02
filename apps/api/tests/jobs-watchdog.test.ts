import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { beat } from '../src/jobs/heartbeat';
import { buildJobs, startJobs } from '../src/jobs/scheduler';
import { jobHealth, watchOnce } from '../src/jobs/watchdog';
import { prisma } from '../src/lib/prisma';
import { redis, tryLeader } from '../src/lib/redis';
import { readMockMailbox } from '../src/services/mail';
import { resetAll } from './helpers';

afterAll(async () => { await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });

/**
 * OPS-05: the jobs can run on their own, and somebody notices when they stop. Containment under test (docs/BACKLOG.md): a lease that another process takes over when the holder dies ·
 * a watchdog that does not depend on the jobs being up · one message a day, not one per check.
 */
const quiet = { info: () => undefined, error: () => undefined };
const jobs = buildJobs(quiet);
const T0 = new Date('2026-11-03T10:00:00Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe('the list of jobs', () => {
  it('has every job once, with a name, an interval and who may run it', () => {
    expect(jobs.length).toBeGreaterThanOrEqual(15);
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length);
    for (const j of jobs) { expect(j.ms).toBeGreaterThan(0); expect(typeof j.fn).toBe('function'); }
    expect(jobs.find((j) => j.name === 'reconcile')).toMatchObject({ leader: true });
    expect(jobs.find((j) => j.name === 'overage-billing')).toMatchObject({ leader: true });
    expect(jobs.find((j) => j.name === 'send-queue')).toMatchObject({ leader: false });
  });
});

describe('heartbeats and the watchdog', () => {
  it('says "starting" before any job has run, and does not call a job missing during the start-up grace', async () => {
    const h = await jobHealth(minutes(1), T0);
    expect(h.overall).toBe('starting');
    expect(h.jobs.every((j) => j.state === 'ok')).toBe(true);
  });

  it('a job that never ran once the grace has passed is missing', async () => {
    const h = await jobHealth(minutes(30), T0);
    expect(h.overall).toBe('late');
    expect(h.jobs.every((j) => j.state === 'missing')).toBe(true);
  });

  it('is fine while every job beats on time, and names the one that stopped', async () => {
    for (const j of jobs) await beat(j.name, j.ms, true, 5);
    expect((await jobHealth(new Date(), new Date(Date.now() - 3_600_000))).overall).toBe('ok');
    // one job's last heartbeat is old: more than three of its own intervals and a minute
    const stale = jobs.find((j) => j.name === 'reconcile')!;
    await redis.set(`sf:job:hb:${stale.name}`, JSON.stringify({ at: new Date(Date.now() - (3 * stale.ms + 120_000)).toISOString(), ms: stale.ms, ok: true, tookMs: 1 }));
    const h = await jobHealth(new Date(), new Date(Date.now() - 3_600_000));
    expect(h.overall).toBe('late');
    expect(h.jobs.filter((j) => j.state === 'late').map((j) => j.name)).toEqual(['reconcile']);
  });

  it('a job that keeps failing is shown as failing, not as healthy', async () => {
    for (const j of jobs) await beat(j.name, j.ms, true, 5);
    await beat('gifts', 5_000, false, 3, 'connection refused');
    const h = await jobHealth(new Date(), new Date(Date.now() - 3_600_000));
    expect(h.jobs.find((j) => j.name === 'gifts')).toMatchObject({ state: 'failing', error: 'connection refused' });
  });

  it('startJobs leaves a heartbeat for a job that ran, and a failed run is recorded with its error', async () => {
    vi.useFakeTimers();
    const stop = startJobs(quiet);
    await vi.advanceTimersByTimeAsync(1000); // the jobs with no start-up delay run once
    stop();
    vi.useRealTimers();
    const sendQueue = JSON.parse((await redis.get('sf:job:hb:send-queue'))!);
    expect(sendQueue).toMatchObject({ ms: 2000, ok: true });
  });
});

describe('the lease a leader job holds', () => {
  it('only one process holds it at a time, and another takes over once it has lapsed', async () => {
    expect(await tryLeader('test-job', 400)).toBe(true);
    expect(await tryLeader('test-job', 400)).toBe(false); // a second replica does not run it
    await new Promise((r) => setTimeout(r, 500)); // the holder died: nobody renews
    expect(await tryLeader('test-job', 400)).toBe(true); // the other one takes over
  });
});

describe('what the operator is told', () => {
  const mailsOf = async () => (await readMockMailbox('ops@example.test')).filter((m) => m.kind === 'jobs_late');
  const withOperator = async (fn: () => Promise<void>) => {
    const saved = env.OPERATOR_EMAIL;
    (env as { OPERATOR_EMAIL?: string }).OPERATOR_EMAIL = 'ops@example.test';
    try { await fn(); } finally { (env as { OPERATOR_EMAIL?: string }).OPERATOR_EMAIL = saved; }
  };

  it('one message a day for the same late jobs, however often the watchdog looks', async () => {
    await withOperator(async () => {
      const started = new Date(Date.now() - 3_600_000); // an hour ago: no job has ever run
      for (let i = 0; i < 4; i++) await watchOnce(quiet, started);
      const mails = await mailsOf();
      expect(mails).toHaveLength(1);
      expect(mails[0]!.text).toMatch(/has not run since this server started/);
    });
  });

  it('a different set of late jobs is a new message', async () => {
    await withOperator(async () => {
      const started = new Date(Date.now() - 3_600_000);
      await watchOnce(quiet, started);
      for (const j of jobs.filter((x) => x.name !== 'gifts')) await beat(j.name, j.ms, true, 1);
      await watchOnce(quiet, started); // now only `gifts` is missing
      expect(await mailsOf()).toHaveLength(2);
    });
  });

  it('says nothing, to anybody, while every job is beating', async () => {
    await withOperator(async () => {
      for (const j of jobs) await beat(j.name, j.ms, true, 1);
      expect(await watchOnce(quiet, new Date(Date.now() - 3_600_000))).toEqual([]);
      expect(await mailsOf()).toHaveLength(0);
    });
  });

  it('without an operator address it still logs, and sends nothing', async () => {
    const seen: unknown[] = [];
    await watchOnce({ info: () => undefined, error: (o) => seen.push(o) }, new Date(Date.now() - 3_600_000));
    expect(seen).toHaveLength(1);
  });
});
