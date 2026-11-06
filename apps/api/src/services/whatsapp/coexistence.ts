import type { WhatsAppAccount } from '@prisma/client';
import { COUNTRY_CONFIG, DEFAULT_COUNTRY, canonicalWaId, fromWaId, normalizePhone, parseCoexistenceEvents, type CoexistenceEvent } from '@surveyflow/shared';
import { phoneIndex, prisma } from '../../lib/prisma';
import { audit } from '../audit';
import { sendMail } from '../mail';
import { credsFor } from './accounts';
import { getGateway } from './gateway';

interface Logger { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }

/** A safety ceiling on what one connected number may import from the owner's address book. Beyond it the rest is counted, not stored. */
export const MAX_APP_CONTACTS = 20_000;
export const APP_CONTACT_SOURCE = 'whatsapp_app_sync';
export const APP_CONTACT_TAG = 'app-contact';

/**
 * WA-12. Meta gives a partner 24 hours after onboarding to ask for the owner's contacts and chat history, each once; after that the number has to be offboarded and
 * the owner has to run Embedded Signup again. So this runs inside the connect request. A refusal from Meta marks the sync `failed` and the owner can retry from Settings
 * (a request Meta already accepted answers with an error on the second try, which is harmless).
 */
export async function startSync(acct: WhatsAppAccount): Promise<'pending' | 'failed'> {
  const gw = getGateway();
  const creds = credsFor(acct);
  let failed = false;
  for (const type of ['smb_app_state_sync', 'history'] as const) {
    try { await gw.requestAppDataSync(creds, type); } catch { failed = true; }
  }
  const state = failed ? 'failed' : 'pending';
  await prisma.whatsAppAccount.update({ where: { id: acct.id }, data: { syncState: state, syncStartedAt: new Date() } });
  return state;
}

/** The webhook entry for everything that only exists for coexistence. Never reads what the owner wrote to a customer: contacts are names and numbers, history and echoes are counted. */
export async function processCoexistence(body: unknown, log: Logger): Promise<void> {
  for (const ev of parseCoexistenceEvents(body)) {
    try {
      await handleEvent(ev, log);
    } catch (err) {
      log.error({ err, kind: ev.kind }, 'coexistence event failed');
      throw err; // Meta retries; every handler below is safe to repeat
    }
  }
}

async function handleEvent(ev: CoexistenceEvent, log: Logger): Promise<void> {
  if (ev.kind === 'contacts' || ev.kind === 'history' || ev.kind === 'echo') {
    const acct = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId: ev.phoneNumberId } });
    if (!acct) return; // not ours: ignore
    if (ev.kind === 'echo') {
      await prisma.whatsAppAccount.update({ where: { id: acct.id }, data: { lastAppActivityAt: new Date() } });
    } else if (ev.kind === 'history') {
      const progress = ev.progress === null ? acct.historyProgress : Math.max(acct.historyProgress ?? 0, ev.progress);
      await prisma.whatsAppAccount.update({
        where: { id: acct.id },
        data: { historyThreads: { increment: ev.threads }, historyProgress: progress, syncState: ev.declined ? 'declined' : progress === 100 ? 'done' : ['none', 'failed', 'pending'].includes(acct.syncState) ? 'partial' : acct.syncState },
      });
    } else {
      await importContacts(acct, ev.contacts);
    }
    return;
  }

  const acct = await prisma.whatsAppAccount.findFirst({ where: { wabaId: ev.wabaId } });
  if (!acct) return;
  if (ev.kind === 'reconnected') {
    await prisma.whatsAppAccount.update({ where: { id: acct.id }, data: { status: 'active', disconnectReason: null, disconnectedBy: null, disconnectedAt: null } });
    return;
  }
  // partner_removed | offboarded: Meta cut the link. The surveys, the contacts and the answers stay; sending stops (the sender refuses a disconnected number).
  if (acct.status === 'disconnected') return; // already known: one e-mail, not one per retry
  const reason = ev.kind === 'partner_removed' ? ev.reason : 'OFFBOARDED';
  const by = ev.kind === 'partner_removed' ? ev.initiatedBy : null;
  await prisma.whatsAppAccount.update({ where: { id: acct.id }, data: { status: 'disconnected', disconnectReason: reason, disconnectedBy: by, disconnectedAt: new Date() } });
  await audit({ userId: acct.userId, actorId: null, sessionId: null, ip: null, userAgent: null }, { action: 'whatsapp_disconnected', targetType: 'whatsapp_account', targetId: acct.id, meta: { reason, by, mode: acct.mode } }, log);
  const user = await prisma.user.findUnique({ where: { id: acct.userId }, select: { email: true, name: true, locale: true } });
  if (user) await sendMail(user.email, 'whatsapp_disconnected', user.locale === 'en' ? 'en' : 'fr', { name: user.name, what: reason, from: by ?? undefined }, log as never).catch(() => undefined);
}

/**
 * The owner's address book, as Meta sends it. They arrive WITHOUT consent (`consentAt` null): a phone number in an address book is not an agreement to receive
 * surveys, and WhatsApp's policy needs that agreement. The owner confirms for the whole batch in Settings (`confirmAppContactsConsent`), the same attestation the CSV import asks for.
 * A contact the owner removes from the phone is NOT removed here: it may already have answers.
 */
async function importContacts(acct: WhatsAppAccount, contacts: Array<{ phone: string; name: string; action: 'add' | 'edit' | 'remove' }>) {
  const user = await prisma.user.findUnique({ where: { id: acct.userId }, select: { country: true } });
  const country = user && COUNTRY_CONFIG[user.country] ? user.country : DEFAULT_COUNTRY;
  const own = (acct.displayPhone ?? '').replace(/\D/g, '');
  const seen = new Set<string>();
  const rows: Array<{ phone: string; name: string }> = [];
  for (const c of contacts) {
    if (c.action === 'remove') continue;
    const phone = normalizePhone(fromWaId(canonicalWaId(c.phone)), country);
    if (!phone || seen.has(phone) || phone.replace(/\D/g, '') === own) continue;
    seen.add(phone);
    rows.push({ phone, name: (c.name || phone).slice(0, 120) });
  }
  const room = Math.max(0, MAX_APP_CONTACTS - acct.contactsReceived);
  const take = rows.slice(0, room);
  for (let i = 0; i < take.length; i += 200) {
    await prisma.$transaction(take.slice(i, i + 200).map((v) =>
      prisma.contact.upsert({
        where: { userId_phoneHash: { userId: acct.userId, phoneHash: phoneIndex(v.phone) } },
        create: { userId: acct.userId, phone: v.phone, name: v.name, tags: [APP_CONTACT_TAG], consentAt: null, consentSource: APP_CONTACT_SOURCE },
        update: {}, // never overwrite what the owner already has, and never touch consent or a STOP
      })));
  }
  await prisma.whatsAppAccount.update({
    where: { id: acct.id },
    data: { contactsReceived: { increment: take.length }, syncState: acct.syncState === 'pending' || acct.syncState === 'none' || acct.syncState === 'failed' ? 'partial' : acct.syncState },
  });
}

/** Contacts that came from the owner's WhatsApp Business app and wait for the owner's confirmation that they agreed to be contacted. */
export const pendingAppContacts = (userId: string) => prisma.contact.count({ where: { userId, consentAt: null, consentSource: APP_CONTACT_SOURCE, optedOutAt: null } });

/** The owner's attestation, for the whole batch, with a timestamp as proof. STOP is never overridden. */
export async function confirmAppContactsConsent(userId: string): Promise<number> {
  const r = await prisma.contact.updateMany({ where: { userId, consentAt: null, consentSource: APP_CONTACT_SOURCE, optedOutAt: null }, data: { consentAt: new Date(), consentSource: 'owner_attested_app_contacts' } });
  return r.count;
}
