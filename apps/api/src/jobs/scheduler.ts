import { beat } from './heartbeat';
import { runOverageBilling } from '../services/overage';
import { refreshRates } from '../services/fx';
import { tryLeader } from '../lib/redis';
import { processDueGifts, releaseHeldGifts } from '../services/gifts';
import { runDailyReconciliation } from '../services/reconciliation';
import { pspRouter } from '../services/payments/router';
import { reconcilePayments } from '../services/payments/reconcile';
import { sweepAbandoned } from '../services/survey/abandon';
import { ensureOwnerAlertTemplates, sweepSlowdowns } from '../services/analytics-alerts';
import { runBillingLifecycle } from '../services/subscription/lifecycle';
import { runRenewalNotices } from '../services/subscription/notices';
import { runAutoReminders } from '../services/reminders';
import { runRetention } from './retention';
import { notifyEmptyWallets } from '../services/wallet';
import { runSendWorkerOnce } from '../services/whatsapp/sender';

interface Log { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }

export interface JobDef { name: string; ms: number; leader: boolean; initialDelay: number; fn: () => Promise<unknown> }

/**
 * Every background job, as data: what it is called, how often it runs, whether only one replica may run it (the leader), and what it does. Nothing here starts anything.
 * `startJobs` runs them; the watchdog (jobs/watchdog.ts) reads the same list to know which heartbeats it must see, so a job that is added here is watched at once.
 */
export function buildJobs(log: Log): JobDef[] {
  const jobs: JobDef[] = [];
  const def = (name: string, ms: number, fn: () => Promise<unknown>, opts: { leader?: boolean; initialDelay?: number } = {}) => { jobs.push({ name, ms, leader: !!opts.leader, initialDelay: opts.initialDelay ?? 0, fn }); };

  def('send-queue', 2_000, () => runSendWorkerOnce(40));
  def('gifts', 5_000, () => processDueGifts(20));
  def('abandon-sweeper', 60_000, async () => ({ abandoned: await sweepAbandoned() }));
  def('auto-reminders', 5 * 60_000, () => runAutoReminders(), { leader: true, initialDelay: 20_000 });
  def('owner-alert-templates', 6 * 3_600_000, async () => ({ created: await ensureOwnerAlertTemplates({ warn: (o, m) => log.info(o, m) }) }), { leader: true, initialDelay: 45_000 });
  def('bot-slowdown-alerts', 60 * 60_000, async () => ({ alerted: await sweepSlowdowns(new Date(), { warn: (o, m) => log.info(o, m) }) }), { leader: true, initialDelay: 50_000 });
  // Gifts that a payout limit held (a young account, a daily cap): let them go, oldest first, once the limit allows (PAY-13). Leader-only.
  def('held-gifts', 10 * 60_000, () => releaseHeldGifts(), { leader: true, initialDelay: 35_000 });
  // Every day: do the wallets add up, and do the providers hold what customers are owed (PAY-02). Checked hourly, runs once a day. Leader-only.
  def('reconcile', 3_600_000, () => runDailyReconciliation(), { leader: true, initialDelay: 90_000 });
  def('wallet-alerts', 10 * 60_000, () => notifyEmptyWallets(), { leader: true, initialDelay: 30_000 });
  def('fx-refresh', 3 * 3_600_000, async () => ({ refreshed: !!(await refreshRates()) }), { leader: true, initialDelay: 5_000 });
  def('billing-lifecycle', 15 * 60_000, () => runBillingLifecycle(), { leader: true, initialDelay: 10_000 });
  // Asks the payment providers about payments whose webhook never came (and expires an abandoned one only after a last look). Leader-only: one replica asks.
  def('payment-reconcile', 60_000, () => reconcilePayments(new Date(), pspRouter, { warn: (o, m) => log.info(o, m), error: (o, m) => log.error(o, m) }), { leader: true, initialDelay: 15_000 });
  def('renewal-notices', 6 * 3_600_000, () => runRenewalNotices(), { leader: true, initialDelay: 40_000 });
  // Unconfirmed accounts, spent e-mail links, ended sessions and old audit rows (jobs/retention.ts).
  def('retention', 3_600_000, () => runRetention(), { leader: true, initialDelay: 60_000 });
  def('overage-billing', 3_600_000, () => runOverageBilling(new Date(), { warn: (o, m) => log.info(o, m) }), { leader: true, initialDelay: 100_000 });
  return jobs;
}

/**
 * Runs the jobs in THIS process: by default inside the API (RUN_JOBS), or alone in a worker process (`npm run worker`, apps/api/src/worker.ts) so that deploying or restarting the
 * web server does not stop them and a dead worker is noticed. Each job guards against overlapping runs; several processes at once are safe: a leader job takes a lease for one
 * interval (so when the process that held it dies, another takes over at its next tick, never later than one interval), and every other job is made of row locks and idempotent writes.
 * Each run leaves a heartbeat that the watchdog reads.
 */
export function startJobs(log: Log): () => void {
  const timers: NodeJS.Timeout[] = [];
  for (const job of buildJobs(log)) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        if (job.leader && !(await tryLeader(job.name, Math.max(job.ms - 1000, 1000)))) return;
        const started = Date.now();
        try {
          const r = await job.fn();
          if (r && typeof r === 'object' && Object.values(r as object).some((v) => typeof v === 'number' && v > 0)) log.info({ job: job.name, result: r }, 'job ran');
          await beat(job.name, job.ms, true, Date.now() - started);
        } catch (err) {
          log.error({ err, job: job.name }, 'job failed');
          await beat(job.name, job.ms, false, Date.now() - started, (err as Error).message);
        }
      } finally {
        running = false;
      }
    };
    timers.push(setTimeout(() => void tick(), job.initialDelay).unref());
    timers.push(setInterval(() => void tick(), job.ms).unref());
  }
  return () => timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
}
