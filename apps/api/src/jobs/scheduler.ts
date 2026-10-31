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

/** In-process workers. Each guards against overlapping runs; multi-replica safety comes from SQL row locks / Redis locks. */
export function startJobs(log: Log): () => void {
  const timers: NodeJS.Timeout[] = [];
  const every = (name: string, ms: number, fn: () => Promise<unknown>, opts: { leader?: boolean; initialDelay?: number } = {}) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        if (opts.leader && !(await tryLeader(name, Math.max(ms - 1000, 1000)))) return;
        const r = await fn();
        if (r && typeof r === 'object' && Object.values(r as object).some((v) => typeof v === 'number' && v > 0)) log.info({ job: name, result: r }, 'job ran');
      } catch (err) {
        log.error({ err, job: name }, 'job failed');
      } finally {
        running = false;
      }
    };
    timers.push(setTimeout(() => void tick(), opts.initialDelay ?? 0).unref());
    timers.push(setInterval(() => void tick(), ms).unref());
  };

  every('send-queue', 2_000, () => runSendWorkerOnce(40));
  every('gifts', 5_000, () => processDueGifts(20));
  every('abandon-sweeper', 60_000, async () => ({ abandoned: await sweepAbandoned() }));
  every('auto-reminders', 5 * 60_000, () => runAutoReminders(), { leader: true, initialDelay: 20_000 });
  every('owner-alert-templates', 6 * 3_600_000, async () => ({ created: await ensureOwnerAlertTemplates({ warn: (o, m) => log.info(o, m) }) }), { leader: true, initialDelay: 45_000 });
  every('bot-slowdown-alerts', 60 * 60_000, async () => ({ alerted: await sweepSlowdowns(new Date(), { warn: (o, m) => log.info(o, m) }) }), { leader: true, initialDelay: 50_000 });
  // Gifts that a payout limit held (a young account, a daily cap): let them go, oldest first, once the limit allows (PAY-13). Leader-only.
  every('held-gifts', 10 * 60_000, () => releaseHeldGifts(), { leader: true, initialDelay: 35_000 });
  // Every day: do the wallets add up, and do the providers hold what customers are owed (PAY-02). Checked hourly, runs once a day. Leader-only.
  every('reconcile', 3_600_000, () => runDailyReconciliation(), { leader: true, initialDelay: 90_000 });
  every('wallet-alerts', 10 * 60_000, () => notifyEmptyWallets(), { leader: true, initialDelay: 30_000 });
  every('fx-refresh', 3 * 3_600_000, async () => ({ refreshed: !!(await refreshRates()) }), { leader: true, initialDelay: 5_000 });
  every('billing-lifecycle', 15 * 60_000, () => runBillingLifecycle(), { leader: true, initialDelay: 10_000 });
  // Asks the payment providers about payments whose webhook never came (and expires an abandoned one only after a last look). Leader-only: one replica asks.
  every('payment-reconcile', 60_000, () => reconcilePayments(new Date(), pspRouter, { warn: (o, m) => log.info(o, m), error: (o, m) => log.error(o, m) }), { leader: true, initialDelay: 15_000 });
  every('renewal-notices', 6 * 3_600_000, () => runRenewalNotices(), { leader: true, initialDelay: 40_000 });
  // Unconfirmed accounts, spent e-mail links, ended sessions and old audit rows (jobs/retention.ts).
  every('retention', 3_600_000, () => runRetention(), { leader: true, initialDelay: 60_000 });
  return () => timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
}
