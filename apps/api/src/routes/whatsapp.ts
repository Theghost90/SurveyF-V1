import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { NUMBER_SITUATIONS, SIGNUP_VERSION } from '@surveyflow/shared';
import { env } from '../config/env';
import { badRequest, conflict, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { audit, auditContext } from '../services/audit';
import { processWebhookPayload } from '../services/survey/handler';
import { ensureTemplates } from '../services/whatsapp/accounts';
import { attachAccount, retryRegistration } from '../services/whatsapp/connect';
import { confirmAppContactsConsent, pendingAppContacts, startSync } from '../services/whatsapp/coexistence';
import { exchangeEmbeddedSignupCode } from '../services/whatsapp/cloud';

export default async function whatsappRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  async function listAccounts(userId: string) {
    const accounts = await prisma.whatsAppAccount.findMany({ where: { userId }, include: { templates: true }, orderBy: { createdAt: 'asc' } });
    const pending = accounts.length ? await pendingAppContacts(userId) : 0;
    return accounts.map((a) => ({
      pendingAppContacts: a.mode === 'coexistence' ? pending : 0,
      id: a.id, wabaId: a.wabaId, phoneNumberId: a.phoneNumberId, displayPhone: a.displayPhone, status: a.status, createdAt: a.createdAt,
      // WA-11..13: how the number is connected and what is going on with it. Never the token, never the PIN.
      mode: a.mode, declaredSituation: a.declaredSituation, signupVersion: a.signupVersion, registered: !!a.registeredAt,
      sync: { state: a.syncState, contacts: a.contactsReceived, historyProgress: a.historyProgress, historyThreads: a.historyThreads, startedAt: a.syncStartedAt },
      lastAppActivityAt: a.lastAppActivityAt,
      disconnect: a.status === 'disconnected' ? { reason: a.disconnectReason, by: a.disconnectedBy, at: a.disconnectedAt } : null,
      // Tokens are never returned, not even encrypted.
      templates: a.templates.map((t) => ({ name: t.name, language: t.language, status: t.status, reason: t.reason })),
    }));
  }

  /** What the web app needs to render the "Connect WhatsApp" step. */
  app.get('/api/whatsapp/config', auth, async () => ({
    mode: env.waMode,
    graphVersion: env.META_GRAPH_VERSION,
    embeddedSignup: env.META_APP_ID && env.META_EMBEDDED_SIGNUP_CONFIG_ID ? { appId: env.META_APP_ID, configId: env.META_EMBEDDED_SIGNUP_CONFIG_ID, version: SIGNUP_VERSION } : null,
    webhookUrl: `${env.PUBLIC_API_URL}/api/webhook/whatsapp`,
    verifyTokenConfigured: !!env.WHATSAPP_VERIFY_TOKEN,
  }));

  app.get('/api/whatsapp/accounts', auth, async (req) => ({ items: await listAccounts(req.userId) }));

  const situation = z.enum(NUMBER_SITUATIONS);

  app.post('/api/whatsapp/accounts', { preHandler: app.authenticateVerified }, async (req, reply) => {
    const body = z.object({ wabaId: z.string().trim().min(3).max(40), phoneNumberId: z.string().trim().min(3).max(40), accessToken: z.string().trim().min(10).max(1000) }).parse(req.body);
    await attachAccount(req.userId, body, { ctx: auditContext(req) }, app.log);
    reply.code(201);
    return { items: await listAccounts(req.userId) };
  });

  /**
   * Meta Embedded Signup (v5, coexistence opted in): the browser hands us the OAuth `code` plus what the popup said. The ids and the number's situation are checked
   * with Meta, not believed: `isOnBizApp` from the browser is only a fallback when Meta's own answer is missing. The phone number id may be absent (v3/v4 coexistence event).
   */
  app.post('/api/whatsapp/embedded-signup', { preHandler: app.authenticateVerified }, async (req, reply) => {
    const body = z.object({
      code: z.string().min(5), wabaId: z.string().min(3), phoneNumberId: z.string().min(3).nullish(),
      isOnBizApp: z.boolean().nullish(), declared: situation.nullish(),
    }).parse(req.body);
    if (env.waMode !== 'live') throw badRequest('not_live', 'Embedded Signup needs WHATSAPP_MODE=live');
    let accessToken: string;
    try {
      accessToken = await exchangeEmbeddedSignupCode(body.code);
    } catch (err) {
      throw badRequest('code_exchange_failed', (err as Error).message);
    }
    await attachAccount(req.userId, { wabaId: body.wabaId, phoneNumberId: body.phoneNumberId ?? null, accessToken }, { embedded: { declared: body.declared ?? null, browserIsOnBizApp: body.isOnBizApp ?? null }, ctx: auditContext(req) }, app.log);
    reply.code(201);
    return { items: await listAccounts(req.userId) };
  });

  /**
   * Demo/dev only (mock mode): a simulated number so the whole product can be explored without Meta. `scenario` picks the story: `new` is a number that never had
   * WhatsApp (Armand: standard onboarding, registered with a PIN), `business_app` is a number in a WhatsApp Business app (Mireille: coexistence, sync started).
   * It goes through the same `attachAccount` as the real flow, with the same rules.
   */
  app.post('/api/whatsapp/accounts/mock', { preHandler: app.authenticateVerified }, async (req, reply) => {
    if (env.waMode !== 'mock') throw notFound('Route');
    const body = z.object({ scenario: z.enum(['new', 'business_app']).default('new'), declared: situation.nullish() }).parse(req.body ?? {});
    const id = body.scenario === 'business_app' ? `mock-app-${nanoid(10)}` : `mock-${nanoid(10)}`;
    await attachAccount(req.userId, { wabaId: `mock-waba-${nanoid(6)}`, phoneNumberId: id, accessToken: 'mock-token-for-local-development' }, { embedded: { declared: body.declared ?? (body.scenario === 'business_app' ? 'business_app' : 'new'), browserIsOnBizApp: body.scenario === 'business_app' }, ctx: auditContext(req) }, app.log);
    reply.code(201);
    return { items: await listAccounts(req.userId) };
  });

  /**
   * Mock mode only: plays the events Meta would send to a coexistence number, through the real webhook code (`processWebhookPayload`), so the whole of Mireille's
   * story can be run without Meta. `contacts` | `history` | `echo` | `disconnect` (reason PRIMARY_INACTIVITY by default) | `reconnect`.
   */
  app.post('/api/whatsapp/accounts/:id/mock-event', auth, async (req) => {
    if (env.waMode !== 'mock') throw notFound('Route');
    const acct = await prisma.whatsAppAccount.findFirst({ where: { id: (req.params as { id: string }).id, userId: req.userId } });
    if (!acct) throw notFound('WhatsApp account');
    const body = z.object({ event: z.enum(['contacts', 'history', 'echo', 'disconnect', 'reconnect']), reason: z.string().max(40).optional() }).parse(req.body);
    const meta = { messaging_product: 'whatsapp', metadata: { display_phone_number: (acct.displayPhone ?? '').replace(/\D/g, ''), phone_number_id: acct.phoneNumberId } };
    const wrap = (field: string, value: object) => ({ object: 'whatsapp_business_account', entry: [{ id: acct.wabaId, changes: [{ field, value }] }] });
    const sample = ['237650000011', '237650000012', '237650000013', '237650000014'].map((p, i) => ({ type: 'contact', contact: { full_name: `Client ${i + 1}`, first_name: `Client${i + 1}`, phone_number: p }, action: 'add', metadata: { timestamp: String(Date.now()) } }));
    const payload =
      body.event === 'contacts' ? wrap('smb_app_state_sync', { ...meta, state_sync: sample })
      : body.event === 'history' ? wrap('history', { ...meta, history: [{ metadata: { phase: 2, chunk_order: 1, progress: 100 }, threads: [{ id: '237650000011', messages: [] }, { id: '237650000012', messages: [] }] }] })
      : body.event === 'echo' ? wrap('smb_message_echoes', { ...meta, message_echoes: [{ from: meta.metadata.display_phone_number, to: '237650000011', id: `wamid.MOCK${nanoid(8)}`, timestamp: String(Date.now()), type: 'text' }] })
      : body.event === 'reconnect' ? wrap('account_update', { event: 'ACCOUNT_RECONNECTED' })
      : wrap('account_update', { event: 'PARTNER_REMOVED', waba_info: { waba_id: acct.wabaId, owner_business_id: 'mock-biz' }, disconnection_info: { reason: body.reason ?? 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' } });
    await processWebhookPayload(payload, app.log);
    return { items: await listAccounts(req.userId) };
  });

  /** Retry the Cloud API registration that failed at connect time (cloud mode). */
  app.post('/api/whatsapp/accounts/:id/register', auth, async (req) => {
    const acct = await prisma.whatsAppAccount.findFirst({ where: { id: (req.params as { id: string }).id, userId: req.userId } });
    if (!acct) throw notFound('WhatsApp account');
    if (!(await retryRegistration(acct))) throw badRequest('register_failed', 'Meta did not register the number. Try again in a minute, or connect it again.');
    return { items: await listAccounts(req.userId) };
  });

  /** Ask Meta again for the contacts and history of a coexistence number (only while the 24 hours Meta allows are not over; Meta says if they are). */
  app.post('/api/whatsapp/accounts/:id/sync', auth, async (req) => {
    const acct = await prisma.whatsAppAccount.findFirst({ where: { id: (req.params as { id: string }).id, userId: req.userId } });
    if (!acct) throw notFound('WhatsApp account');
    if (acct.mode !== 'coexistence') throw badRequest('not_coexistence', 'Only a number that is also in the WhatsApp Business app has contacts to import.');
    if ((await startSync(acct)) === 'failed') throw badRequest('sync_failed', 'Meta did not accept the request. It allows it once, in the first 24 hours after connecting: if that time has passed, reconnect the number.');
    return { items: await listAccounts(req.userId) };
  });

  /** The owner confirms, for the whole batch imported from their WhatsApp Business app, that those people agreed to be contacted. Until then they cannot be sent a survey. */
  app.post('/api/whatsapp/app-contacts/confirm', { preHandler: app.authenticateVerified }, async (req) => {
    z.object({ consent: z.literal(true) }).parse(req.body);
    const confirmed = await confirmAppContactsConsent(req.userId);
    await audit(auditContext(req), { action: 'app_contacts_confirmed', meta: { count: confirmed } }, app.log);
    return { confirmed };
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
