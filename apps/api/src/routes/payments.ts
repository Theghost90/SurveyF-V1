import type { FastifyInstance } from 'fastify';
import { rl } from '../lib/ratelimit';
import { z } from 'zod';
import { PAID_PLAN_KEYS } from '@surveyflow/shared';
import { env } from '../config/env';
import { notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { mockOutcomeKey } from '../services/payments/adapters/mock';
import { pspRouter } from '../services/payments/router';
import { initiatePayment, refreshTransaction, txDto } from '../services/payments/service';

export const initiateSchema = z.object({
  plan: z.enum(PAID_PLAN_KEYS as [string, ...string[]]),
  interval: z.enum(['monthly', 'annual']).default('monthly'),
  method: z.enum(['mobile_money', 'card', 'bank_transfer']),
  phone: z.string().trim().max(30).optional(),
});

export default async function paymentRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  /** Unified payment initiation: server picks the PSP chain, computes the amount, never trusts the client for either. */
  app.post('/api/payments/initiate', { ...auth, ...rl(20) }, async (req, reply) => {
    const body = initiateSchema.parse(req.body);
    const tx = await initiatePayment(req.userId, body as never);
    reply.code(201);
    return txDto(tx);
  });

  app.get('/api/payments', auth, async (req) => {
    const items = await prisma.paymentTransaction.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { items: items.map(txDto) };
  });

  /** Status poll used by the return page / "approve on your phone" screen. Verifies with the PSP, so it self-heals missed webhooks. */
  app.get('/api/payments/:id', auth, async (req) => {
    const tx = await prisma.paymentTransaction.findFirst({ where: { userId: req.userId, OR: [{ id: (req.params as { id: string }).id }, { reference: (req.params as { id: string }).id }] } });
    if (!tx) throw notFound('Payment');
    const { tx: fresh } = await refreshTransaction(tx, pspRouter, req.log);
    return txDto(fresh);
  });

  /**
   * PSP webhook. The body is NOT trusted: we use it only to find the transaction, then ask the PSP directly what
   * happened and check the amount. Always answers 200 for unknown references so PSPs do not retry forever.
   */
  const webhook = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const psp = (req.params as { psp: string }).psp;
    const adapter = pspRouter.getAdapter(psp);
    if (!adapter || !adapter.isConfigured() || psp === 'mock') return reply.code(404).send({ error: 'unknown_psp' });

    const parsed = await adapter.parseWebhook({ rawBody: req.rawBody ?? Buffer.alloc(0), headers: req.headers, body: req.body, query: req.query as never });
    if (!parsed.signatureValid) return reply.code(401).send({ error: 'invalid_signature' });

    const tx = await prisma.paymentTransaction.findFirst({
      where: { pspProvider: psp, OR: [...(parsed.reference ? [{ reference: parsed.reference }] : []), ...(parsed.pspReference ? [{ pspReference: parsed.pspReference }] : [])] },
    });
    if (!tx) {
      req.log.warn({ psp, ref: parsed.reference }, 'webhook for unknown transaction');
      return reply.code(200).send({ ok: true });
    }
    await refreshTransaction(tx, pspRouter, req.log);
    return reply.code(200).send({ ok: true });
  };
  app.post('/api/payments/webhook/:psp', webhook);
  app.get('/api/payments/webhook/:psp', webhook); // CinetPay / Campay notify via GET as well

  /** Demo checkout: "pay" or "fail" a mock payment. Only exists when PSP_MOCK=true (never in production). */
  if (env.PSP_MOCK && !env.isProd) {
    app.post('/api/payments/mock/:reference', auth, async (req) => {
      const { outcome } = z.object({ outcome: z.enum(['success', 'failed']) }).parse(req.body);
      const tx = await prisma.paymentTransaction.findFirst({ where: { reference: (req.params as { reference: string }).reference, userId: req.userId, pspProvider: 'mock' } });
      if (!tx) throw notFound('Payment');
      await redis.set(mockOutcomeKey(tx.reference), outcome, 'EX', 3600);
      const { tx: fresh } = await refreshTransaction(tx, pspRouter, req.log);
      return txDto(fresh);
    });
  }
}
