import { buildApp } from './app';
import { env } from './config/env';
import { startJobs } from './jobs/scheduler';
import { prisma } from './lib/prisma';
import { prepareDatabase } from './services/startup';
import { redis } from './lib/redis';
import { closeBrowser } from './services/exports/pdf';
import { mailIdle } from './services/mail';

const app = await buildApp();
// Before the first request: one-off data fixes (encrypt existing contacts, fill new columns) and the append-only guard on the audit log.
await prepareDatabase(app.log);
const stopJobs = env.RUN_JOBS ? startJobs(app.log) : () => undefined;

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  stopJobs();
  await app.close();
  await mailIdle(); // messages still being handed to the provider (sign-up, password reset) are not dropped
  await closeBrowser();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`SurveyFlow API on :${env.PORT} (whatsapp=${env.waMode}, gifts=${env.giftProvider}, psp-mock=${env.PSP_MOCK})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
