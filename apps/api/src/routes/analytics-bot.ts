import type { FastifyInstance } from 'fastify';
import { conflict, notFound } from '../lib/errors';
import { rl } from '../lib/ratelimit';
import { MAX_LINKED_PHONES, createLinkCode, linkedPhones, platformPhone, unlinkPhoneById } from '../services/analytics-bot';
import { prisma } from '../lib/prisma';
import { z } from 'zod';
import { assertFeature, loadAccount } from '../services/subscription/limits';

/** Settings → "Analytics on WhatsApp": what the owner needs to link a phone to the Analytics Bot, and to unlink it. */
export default async function analyticsBotRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  app.get('/api/analytics-bot', auth, async (req) => {
    const ctx = await loadAccount(req.userId);
    const phone = platformPhone();
    return {
      /** Starter, Growth and Business. Explore sees the bot only in the builder's preview and the simulator. */
      included: ctx.plan.features.analyticsBot,
      available: !!phone,
      platformPhone: phone ? `+${phone}` : null,
      maxPhones: MAX_LINKED_PHONES,
      phones: await linkedPhones(req.userId),
    };
  });

  /** A one-time code (15 minutes). The owner sends `LINK <code>` to the SurveyFlow number from the phone to link. */
  app.post('/api/analytics-bot/link-code', { preHandler: app.authenticateVerified, ...rl(10) }, async (req) => {
    assertFeature(await loadAccount(req.userId), 'analyticsBot', 'Analytics on WhatsApp');
    if (!platformPhone()) throw conflict('bot_unavailable', 'The Analytics Bot is not available on this deployment: SurveyFlow’s WhatsApp number is not configured.');
    if ((await linkedPhones(req.userId)).length >= MAX_LINKED_PHONES) throw conflict('link_limit', `You can link up to ${MAX_LINKED_PHONES} phones. Remove one first.`);
    return createLinkCode(req.userId);
  });

  /** The alerts switch of one linked phone (the same as MUTE / ALERTS ON typed on it). */
  app.patch('/api/analytics-bot/phones/:id', auth, async (req) => {
    const body = z.object({ alerts: z.boolean() }).parse(req.body);
    const done = await prisma.ownerPhone.updateMany({ where: { id: (req.params as { id: string }).id, userId: req.userId }, data: { alerts: body.alerts } });
    if (done.count === 0) throw notFound('Linked phone');
    return { alerts: body.alerts };
  });

  app.delete('/api/analytics-bot/phones/:id', auth, async (req, reply) => {
    if (!(await unlinkPhoneById(req.userId, (req.params as { id: string }).id))) throw notFound('Linked phone');
    return reply.code(204).send();
  });
}
