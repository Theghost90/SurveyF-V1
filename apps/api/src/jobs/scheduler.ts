import { refreshRates } from '../services/fx';
import { tryLeader } from '../lib/redis';
import { processDueGifts } from '../services/gifts';
import { sweepAbandoned } from '../services/survey/abandon';
import { runBillingLifecycle } from '../services/subscription/lifecycle';
import { runRenewalNotices } from '../services/subscription/notices';
import { runAutoReminders } from '../services/reminders';
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
  every('wallet-alerts', 10 * 60_000, () => notifyEmptyWallets(), { leader: true, initialDelay: 30_000 });
  every('fx-refresh', 3 * 3_600_000, async () => ({ refreshed: !!(await refreshRates()) }), { leader: true, initialDelay: 5_000 });
  every('billing-lifecycle', 15 * 60_000, () => runBillingLifecycle(), { leader: true, initialDelay: 10_000 });
  every('renewal-notices', 6 * 3_600_000, () => runRenewalNotices(), { leader: true, initialDelay: 40_000 });
  return () => timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
}
