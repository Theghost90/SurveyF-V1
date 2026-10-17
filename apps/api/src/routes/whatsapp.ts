import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { env } from '../config/env';
import { encryptSecret } from '../lib/crypto';
import { badRequest, conflict, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { track } from '../services/funnel';
import { ensureTemplates } from '../services/whatsapp/accounts';
import { exchangeEmbeddedSignupCode } from '../services/whatsapp/cloud';
import { getGateway, WaError } from '../services/whatsapp/gateway';

export default async function whatsappRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  async function listAccounts(userId: string) {
    const accounts = await prisma.whatsAppAccount.findMany({ where: { userId }, include: { templates: true }, orderBy: { createdAt: 'asc' } });
    return accounts.map((a) => ({
      id: a.id, wabaId: a.wabaId, phoneNumberId: a.phoneNumberId, displayPhone: a.displayPhone, status: a.status, createdAt: a.createdAt,
      // Tokens are never returned, not even encrypted.
      templates: a.templates.map((t) => ({ name: t.name, language: t.language, status: t.status, reason: t.reason })),
    }));
  }

  /** What the web app needs to render the "Connect WhatsApp" step. */
  app.get('/api/whatsapp/config', auth, async () => ({
    mode: env.waMode,
    graphVersion: env.META_GRAPH_VERSION,
    embeddedSignup: env.META_APP_ID && env.META_EMBEDDED_SIGNUP_CONFIG_ID ? { appId: env.META_APP_ID, configId: env.META_EMBEDDED_SIGNUP_CONFIG_ID } : null,
    webhookUrl: `${env.PUBLIC_API_URL}/api/webhook/whatsapp`,
    verifyTokenConfigured: !!env.WHATSAPP_VERIFY_TOKEN,
  }));

  app.get('/api/whatsapp/accounts', auth, async (req) => ({ items: await listAccounts(req.userId) }));

  async function attach(userId: string, input: { wabaId: string; phoneNumberId: string; accessToken: string }) {
    if (await prisma.whatsAppAccount.count({ where: { userId } })) throw conflict('already_connected', 'A WhatsApp number is already connected. Disconnect it first.');
    if (await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId: input.phoneNumberId } })) throw conflict('number_in_use', 'This WhatsApp number is already connected to another account');
    const gw = getGateway();
    const creds = { ...input };
    let info: { displayPhone: string };
    try {
      info = await gw.getPhoneInfo(creds); // proves the token + ids work before we store anything
      await gw.subscribeApp(creds); // route this WABA's webhooks to our app
    } catch (err) {
      if (err instanceof WaError) throw badRequest('whatsapp_rejected', `Meta rejected these credentials: ${err.message}`);
      throw err;
    }
    const account = await prisma.whatsAppAccount.create({
      data: { userId, wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, displayPhone: info.displayPhone || null, accessToken: encryptSecret(input.accessToken), status: 'active' },
    });
    // Surveys drafted before connecting get attached to the new number.
    await prisma.survey.updateMany({ where: { userId, whatsappAccountId: null }, data: { whatsappAccountId: account.id } });
    await ensureTemplates(account);
    await track(userId, 'whatsapp_connected');
    return account;
  }

  app.post('/api/whatsapp/accounts', auth, async (req, reply) => {
    const body = z.object({ wabaId: z.string().trim().min(3).max(40), phoneNumberId: z.string().trim().min(3).max(40), accessToken: z.string().trim().min(10).max(1000) }).parse(req.body);
    await attach(req.userId, body);
    reply.code(201);
    return { items: await listAccounts(req.userId) };
  });

  /** Meta Embedded Signup: the browser hands us the OAuth `code` plus the ids from the popup's message event. */
  app.post('/api/whatsapp/embedded-signup', auth, async (req, reply) => {
    const body = z.object({ code: z.string().min(5), wabaId: z.string().min(3), phoneNumberId: z.string().min(3) }).parse(req.body);
    if (env.waMode !== 'live') throw badRequest('not_live', 'Embedded Signup needs WHATSAPP_MODE=live');
    let accessToken: string;
    try {
      accessToken = await exchangeEmbeddedSignupCode(body.code);
    } catch (err) {
      throw badRequest('code_exchange_failed', (err as Error).message);
    }
    await attach(req.userId, { wabaId: body.wabaId, phoneNumberId: body.phoneNumberId, accessToken });
    reply.code(201);
    return { items: await listAccounts(req.userId) };
  });

  /** Demo/dev only: a simulated number so the whole product can be explored without Meta credentials. */
  app.post('/api/whatsapp/accounts/mock', auth, async (req, reply) => {
    if (env.waMode !== 'mock') throw notFound('Route');
    await attach(req.userId, { wabaId: `mock-waba-${nanoid(6)}`, phoneNumberId: `mock-${nanoid(10)}`, accessToken: 'mock-token-for-local-development' });
    reply.code(201);
    return { items: await listAccounts(req.userId) };
  });

  app.post('/api/whatsapp/accounts/:id/templates/sync', auth, async (req) => {
    const acct = await prisma.whatsAppAccount.findFirst({ where: { id: (req.params as { id: string }).id, userId: req.userId } });
    if (!acct) throw notFound('WhatsApp account');
    await ensureTemplates(acct);
    return { items: await listAccounts(req.userId) };
  });

  app.delete('/api/whatsapp/accounts/:id', auth, async (req, reply) => {
    const r = await prisma.whatsAppAccount.deleteMany({ where: { id: (req.params as { id: string }).id, userId: req.userId } });
    if (!r.count) throw notFound('WhatsApp account');
    return reply.code(204).send();
  });
}
