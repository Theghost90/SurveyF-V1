import { randomInt } from 'node:crypto';
import type { WhatsAppAccount } from '@prisma/client';
import { SIGNUP_VERSION, type NumberSituation } from '@surveyflow/shared';
import { env } from '../../config/env';
import { encryptSecret } from '../../lib/crypto';
import { badRequest, conflict } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { track } from '../funnel';
import { audit, type AuditContext } from '../audit';
import { ensureTemplates } from './accounts';
import { startSync } from './coexistence';
import { getGateway, WaError } from './gateway';

interface Logger { warn: (o: unknown, m?: string) => void }

export interface AttachInput { wabaId: string; phoneNumberId: string | null; accessToken: string }
export interface AttachOptions {
  /** Present when the number came through Embedded Signup. Absent for credentials typed by hand and for the simulated number. */
  embedded?: { declared: NumberSituation | null; browserIsOnBizApp: boolean | null };
  /** Tests and the simulated number only: what the mock should be told about the number. */
  ctx?: AuditContext;
}

/**
 * Connects a number to an owner. One function for the three ways in (credentials typed by hand, Embedded Signup, the simulated number), so the rules cannot drift:
 *  - the token and the ids are proven with Meta before anything is stored;
 *  - Meta, not the browser, says whether the number is also in the WhatsApp Business app (`is_on_biz_app`); if it will not say, we refuse to guess (a wrong guess
 *    would register a coexistence number, which Meta forbids, or skip the registration of a new one);
 *  - a new number is registered for the Cloud API with a random PIN (D-19), a coexistence number never is (Meta: it is already registered);
 *  - a coexistence number starts the contacts and history sync at once (Meta gives 24 hours);
 *  - a number Meta disconnected is reconnected in place, so the owner keeps the surveys that point at it.
 */
export async function attachAccount(userId: string, input: AttachInput, opts: AttachOptions, log: Logger): Promise<WhatsAppAccount> {
  const existing = await prisma.whatsAppAccount.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } });
  if (existing && existing.status !== 'disconnected') throw conflict('already_connected', 'A WhatsApp number is already connected. Disconnect it first.');
  const gw = getGateway();

  let phoneNumberId = input.phoneNumberId;
  if (!phoneNumberId) {
    // The v3/v4 coexistence event carries only the Messaging account: ask Meta which number it holds.
    let numbers: Array<{ id: string }> = [];
    try { numbers = await gw.listPhoneNumbers({ wabaId: input.wabaId, phoneNumberId: '', accessToken: input.accessToken }); } catch (err) {
      if (err instanceof WaError) throw badRequest('whatsapp_rejected', `Meta rejected these credentials: ${err.message}`);
      throw err;
    }
    if (numbers.length !== 1) throw badRequest('phone_unknown', 'Meta did not say which number was connected. Try again, or use the credentials form.');
    phoneNumberId = numbers[0]!.id;
  }
  const taken = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId } });
  if (taken && taken.id !== existing?.id) throw conflict('number_in_use', 'This WhatsApp number is already connected to another account');

  const creds = { wabaId: input.wabaId, phoneNumberId, accessToken: input.accessToken };
  let displayPhone: string;
  let isOnApp: boolean | null;
  try {
    displayPhone = (await gw.getPhoneInfo(creds)).displayPhone; // proves the token + ids work before we store anything
    const graph = await gw.getAppStatus(creds);
    if (opts.embedded && graph.isOnBizApp !== null && opts.embedded.browserIsOnBizApp !== null && graph.isOnBizApp !== opts.embedded.browserIsOnBizApp) {
      log.warn({ graph: graph.isOnBizApp, browser: opts.embedded.browserIsOnBizApp }, 'Meta and the browser disagree about is_on_biz_app: Meta wins');
    }
    isOnApp = graph.isOnBizApp ?? opts.embedded?.browserIsOnBizApp ?? null;
    if (opts.embedded && isOnApp === null) throw badRequest('mode_unknown', 'Meta did not say whether this number is also in the WhatsApp Business app, so nothing was changed. Try again in a minute.');
    await gw.subscribeApp(creds); // route this WABA's webhooks to our app
  } catch (err) {
    if (err instanceof WaError) throw badRequest('whatsapp_rejected', `Meta rejected these credentials: ${err.message}`);
    throw err;
  }
  const mode = isOnApp ? 'coexistence' : 'cloud';

  // Standard onboarding: the number must be registered for the Cloud API. A failure keeps the connection (we hold a valid token) and shows a retry button, because the
  // one-time Embedded Signup code is spent and making the owner start over would be the worst way to fail.
  let registerFailed = false;
  let pin: string | null = null;
  let registeredAt: Date | null = null;
  if (opts.embedded && mode === 'cloud') {
    pin = String(randomInt(100_000, 1_000_000));
    try { await gw.registerPhone(creds, pin); registeredAt = new Date(); } catch { registerFailed = true; }
  }

  const data = {
    wabaId: input.wabaId, phoneNumberId, displayPhone: displayPhone || null, accessToken: encryptSecret(input.accessToken),
    status: registerFailed ? 'error' : 'active', mode,
    declaredSituation: opts.embedded?.declared ?? null, signupVersion: opts.embedded ? SIGNUP_VERSION : null,
    registeredAt, registerPin: pin ? encryptSecret(pin) : null,
    syncState: opts.embedded && mode === 'coexistence' ? 'pending' : 'none', syncStartedAt: null, contactsReceived: 0, historyProgress: null, historyThreads: 0,
    disconnectReason: null, disconnectedBy: null, disconnectedAt: null,
  };
  const account = existing ? await prisma.whatsAppAccount.update({ where: { id: existing.id }, data }) : await prisma.whatsAppAccount.create({ data: { userId, ...data } });

  if (opts.embedded && mode === 'coexistence') await startSync(account);
  // Surveys drafted before connecting get attached to the new number.
  await prisma.survey.updateMany({ where: { userId, whatsappAccountId: null }, data: { whatsappAccountId: account.id } });
  // ~16 Graph calls: against the real Meta that must not hold the owner's click, so it runs behind the response; the mock is instant and tests read the templates right away.
  if (env.waMode === 'live') ensureTemplates(account).catch((err) => log.warn({ err: (err as Error).message }, 'template submission failed after connect'));
  else await ensureTemplates(account);
  await track(userId, 'whatsapp_connected');
  if (opts.ctx) await audit(opts.ctx, { action: existing ? 'whatsapp_reconnected' : 'whatsapp_connected', targetType: 'whatsapp_account', targetId: account.id, meta: { mode, embedded: !!opts.embedded, declared: opts.embedded?.declared ?? null, registerFailed } }, log);
  return prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: account.id } });
}

/** Retry of the Cloud API registration that failed at connect time (cloud mode, Embedded Signup only). */
export async function retryRegistration(acct: WhatsAppAccount): Promise<boolean> {
  if (acct.mode !== 'cloud' || !acct.signupVersion) return false;
  const { decryptSecret } = await import('../../lib/crypto');
  const pin = acct.registerPin ? decryptSecret(acct.registerPin) : String(randomInt(100_000, 1_000_000));
  try {
    await getGateway().registerPhone({ wabaId: acct.wabaId, phoneNumberId: acct.phoneNumberId, accessToken: decryptSecret(acct.accessToken) }, pin);
  } catch { return false; }
  await prisma.whatsAppAccount.update({ where: { id: acct.id }, data: { registeredAt: new Date(), registerPin: encryptSecret(pin), status: 'active' } });
  return true;
}
