import { startJobs } from './jobs/scheduler';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { closeBrowser } from './services/exports/pdf';
import { mailIdle } from './services/mail';
import { prepareDatabase } from './services/startup';

/**
 * The background jobs on their own (OPS-05): `npm run worker` (dev) or `node dist/worker.js`. Run the API with RUN_JOBS=false next to it. Why: restarting or deploying the web server
 * no longer stops sends, gifts, reminders, billing and the daily checks; the two scale on their own; and when this process dies it is the platform's job to restart it, while the
 * watchdog in the API tells the operator if the jobs stay silent.
 *
 * Several workers at once are safe (leader jobs take a lease, the rest are row locks and idempotent writes), so a second one is how you remove the single point of failure:
 * if one is lost, a leader job is taken over by the other within one of its own intervals.
 */
// One JSON line per event on stdout, the way the API logs in production. Nothing logged here carries a request, so there is nothing to redact: jobs log names, counts and errors.
const line = (level: string) => (o: unknown, m?: string) => console.log(JSON.stringify({ level, time: new Date().toISOString(), msg: typeof o === 'string' ? o : m, ...(typeof o === 'object' && o ? { data: o instanceof Error ? { message: o.message } : o } : {}) }));
const log = { info: line('info'), warn: line('warn'), error: line('error') };
await prepareDatabase(log);
const stop = startJobs(log);
log.info('SurveyFlow worker: background jobs started');

async function shutdown(signal: string) {
  log.info({ signal }, 'worker shutting down');
  stop();
  await mailIdle();
  await closeBrowser();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
