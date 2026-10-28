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
import { clientIp } from './lib/client-ip';
import { registerInternalGate } from './lib/internal-gate';
import { isRateLimitExempt } from './lib/ratelimit';
import { redis } from './lib/redis';
import authPlugin from './plugins/auth';
import authRoutes from './routes/auth';
import surveyRoutes from './routes/surveys';
import contactRoutes from './routes/contacts';
import analyticsRoutes from './routes/analytics';
import analyticsBotRoutes from './routes/analytics-bot';
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
import mailboxRoutes from './routes/mailbox';

/** What the request log keeps of a request (SEC-14): the path WITHOUT its query string (a contact search, a token or a code can sit in a query), never a header. */
export const requestForLog = (req: { method?: string; url?: string; id?: string }) => ({ method: req.method, url: String(req.url).split('?')[0], id: req.id });
export const LOG_REDACT = ['req.headers.authorization', 'req.headers["x-hub-signature-256"]', 'req.headers["x-internal-secret"]', 'req.headers.cookie', 'req.headers["x-sf-client-ip"]'];

export interface BuildOptions {
  /** Tests only: capture the request log here (the app logs nothing under NODE_ENV=test otherwise). */
  logStream?: { write: (line: string) => void };
  /** Tests only: told about every route as it is registered (the route inventory that security-isolation.test.ts holds the whole API to). */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logStream
      ? { level: 'info', redact: LOG_REDACT, serializers: { req: requestForLog }, stream: opts.logStream }
      : env.NODE_ENV === 'test'
        ? false
        : {
            level: 'info',
            // Never log credentials or participants' phone numbers in clear text (finding 14).
            redact: LOG_REDACT,
            serializers: { req: requestForLog },
            transport: env.isProd ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
          },
    bodyLimit: 2 * 1024 * 1024,
    // Off on purpose: the visitor's address comes from the website's server (x-sf-client-ip, believed only with the shared secret), never from a header
    // anybody could send (lib/client-ip.ts).
    trustProxy: false,
  });

  if (opts.onRoute) app.addHook('onRoute', (r) => opts.onRoute!({ method: r.method, url: r.url }));
  registerInternalGate(app); // before anything else: a call that did not come through the website never reaches a handler
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.webOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: false,
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', keyGenerator: (req) => clientIp(req), allowList: (req) => isRateLimitExempt(req.url) });
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
  await app.register(analyticsBotRoutes);
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
  // The demo mailbox: where the mock e-mail provider keeps what it "sent". Never registered in production.
  if (!env.isProd && env.emailProvider === 'mock') await app.register(mailboxRoutes);

  return app;
}
