import { buildApp } from './app';
import { env } from './config/env';
import { startJobs } from './jobs/scheduler';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { closeBrowser } from './services/exports/pdf';

const app = await buildApp();
const stopJobs = env.RUN_JOBS ? startJobs(app.log) : () => undefined;

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  stopJobs();
  await app.close();
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
