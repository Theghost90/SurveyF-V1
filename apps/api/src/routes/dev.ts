import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { toWaId } from '@surveyflow/shared';
import { env } from '../config/env';
import { conflict, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { processDueGifts } from '../services/gifts';
import { outboxKey, pushChat, type MockOutboxItem } from '../services/whatsapp/mock';
import { processWebhookPayload } from '../services/survey/handler';
import { sweepAbandoned } from '../services/survey/abandon';
import { getSession, saveSession } from '../services/survey/sessions';
import { runSendWorkerOnce } from '../services/whatsapp/sender';

/**
 * Local simulator: lets you play the PARTICIPANT's phone against the real webhook code path
 * (same payload shape Meta sends), without any Meta credentials. Registered only when
 * NODE_ENV != production AND WHATSAPP_MODE=mock.
 */
export default async function devRoutes(app: FastifyInstance) {
  if (env.waMode !== 'mock') return;
  const auth = { preHandler: app.authenticate };

  async function target(userId: string, contactId: string) {
    const contact = await prisma.contact.findFirst({ where: { id: contactId, userId } });
    if (!contact) throw notFound('Contact');
    const account = await prisma.whatsAppAccount.findFirst({ where: { userId, status: 'active' } });
    if (!account) throw conflict('no_whatsapp', 'Connect (simulated) WhatsApp first');
    return { contact, account, waId: toWaId(contact.phone) };
  }

  async function snapshot(userId: string, contactId: string) {
    const { contact, account, waId } = await target(userId, contactId);
    const raw = await redis.lrange(outboxKey(account.phoneNumberId, waId), 0, -1);
    const session = await getSession(account.phoneNumberId, waId);
    const recipients = await prisma.surveyRecipient.findMany({ where: { contactId: contact.id }, include: { survey: { select: { title: true, id: true } } }, orderBy: { createdAt: 'desc' }, take: 5 });
    return {
      contact: { id: contact.id, name: contact.name, phone: contact.phone, optedOut: !!contact.optedOutAt },
      chat: raw.map((r) => JSON.parse(r) as MockOutboxItem),
      session: session ? { surveyId: session.surveyId, currentIndex: session.currentIndex } : null,
      recipients: recipients.map((r) => ({ surveyId: r.surveyId, title: r.survey.title, status: r.status })),
    };
  }

  app.get('/api/dev/simulator/:contactId', auth, async (req) => snapshot(req.userId, (req.params as { contactId: string }).contactId));

  const sendSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().min(1).max(4000) }),
    z.object({ type: z.literal('reply'), id: z.string().min(1), title: z.string().default('') }),
    z.object({ type: z.literal('template'), payload: z.string().min(1), title: z.string().default('') }),
  ]);

  app.post('/api/dev/simulator/:contactId/send', auth, async (req) => {
    const contactId = (req.params as { contactId: string }).contactId;
    const body = sendSchema.parse(req.body);
    const { contact, account, waId } = await target(req.userId, contactId);

    const base = { from: waId, id: `wamid.SIM${nanoid(14)}`, timestamp: String(Math.floor(Date.now() / 1000)) };
    const message =
      body.type === 'text' ? { ...base, type: 'text', text: { body: body.text } }
      : body.type === 'reply' ? { ...base, type: 'interactive', interactive: { type: body.id.startsWith('a:') ? 'button_reply' : 'list_reply', button_reply: { id: body.id, title: body.title }, list_reply: { id: body.id, title: body.title } } }
      : { ...base, type: 'button', button: { payload: body.payload, text: body.title } };

    await pushChat(waId, { direction: 'in', phoneNumberId: account.phoneNumberId, text: body.type === 'text' ? body.text : body.title || body.type, id: base.id });
    await processWebhookPayload(
      {
        object: 'whatsapp_business_account',
        entry: [{ id: account.wabaId, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: account.displayPhone ?? '', phone_number_id: account.phoneNumberId }, contacts: [{ profile: { name: contact.name }, wa_id: waId }], messages: [message] } }] }],
      },
      req.log,
    );
    return snapshot(req.userId, contactId);
  });

  /** Fast-forward 25h of silence and run the abandonment sweeper. */
  app.post('/api/dev/simulator/:contactId/expire', auth, async (req) => {
    const contactId = (req.params as { contactId: string }).contactId;
    const { account, waId } = await target(req.userId, contactId);
    const s = await getSession(account.phoneNumberId, waId);
    if (s) await saveSession(account.phoneNumberId, waId, { ...s, lastInteractionAt: new Date(Date.now() - 25 * 3_600_000).toISOString() });
    await sweepAbandoned();
    return snapshot(req.userId, contactId);
  });

  /** Runs the send queue + gift worker once (they also run on a timer). */
  app.post('/api/dev/jobs/run', auth, async () => ({ sent: await runSendWorkerOnce(200), gifts: await processDueGifts(50) }));
}
