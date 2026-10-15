import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { env } from './config/env';
import { AppError } from './lib/errors';
import { prisma } from './lib/prisma';
import { registerInternalGate } from './lib/internal-gate';
import { redis } from './lib/redis';
import authPlugin from './plugins/auth';
import authRoutes from './routes/auth';
import surveyRoutes from './routes/surveys';
import contactRoutes from './routes/contacts';
import analyticsRoutes from './routes/analytics';
import exportRoutes from './routes/exports';
import webhookRoutes from './routes/webhook-whatsapp';
import whatsappRoutes from './routes/whatsapp';
import paymentRoutes from './routes/payments';
import subscriptionRoutes from './routes/subscription';
import walletRoutes from './routes/wallet';
import receiptRoutes from './routes/receipts';
import pricingRoutes from './routes/pricing';
import googleRoutes from './routes/google';
import devRoutes from './routes/dev';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'test'
        ? false
        : {
            level: env.isProd ? 'info' : 'info',
            // Never log credentials or participants' phone numbers in clear text.
            redact: ['req.headers.authorization', 'req.headers["x-hub-signature-256"]', 'req.headers["x-internal-secret"]'],
            transport: env.isProd ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
          },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });

  registerInternalGate(app); // before anything else: a call that did not come through the website never reaches a handler
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.webOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: false,
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', allowList: (req) => req.url.startsWith('/api/webhook/') || req.url.startsWith('/api/payments/webhook/') });
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

  // Keep the raw bytes of JSON bodies: Meta's X-Hub-Signature-256 is computed over them.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (err) {
      (err as FastifyError).statusCode = 400;
      done(err as Error, undefined);
    }
  });
  // CinetPay / Campay style form-encoded notifications.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    done(null, Object.fromEntries(new URLSearchParams((body as Buffer).toString('utf8'))));
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_error',
        message: err.issues[0]?.message ?? 'Invalid input',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') return reply.code(409).send({ error: 'conflict', message: 'This record already exists' });
      if (err.code === 'P2025') return reply.code(404).send({ error: 'not_found', message: 'Record not found' });
    }
    const e = err as FastifyError;
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.code(status).send({
      error: status === 429 ? 'rate_limited' : status >= 500 ? 'internal_error' : 'bad_request',
      message: status >= 500 ? 'Something went wrong' : e.message,
    });
  });

  app.get('/healthz', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      await redis.ping();
      return { ok: true, whatsapp: env.waMode, time: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(surveyRoutes);
  await app.register(contactRoutes);
  await app.register(analyticsRoutes);
  await app.register(exportRoutes);
  await app.register(webhookRoutes);
  await app.register(whatsappRoutes);
  await app.register(paymentRoutes);
  await app.register(subscriptionRoutes);
  await app.register(walletRoutes);
  await app.register(receiptRoutes);
  await app.register(pricingRoutes);
  await app.register(googleRoutes);
  if (!env.isProd) await app.register(devRoutes);

  return app;
}
