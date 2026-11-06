import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import type { Prisma, WhatsAppAccount } from '@prisma/client';
import { joinConsentText, joinInvalidText, joinLink, joinRefusal, sys, type SurveyLang } from '@surveyflow/shared';
import { env } from '../../config/env';
import { badRequest, notFound } from '../../lib/errors';
import { phoneIndex, prisma } from '../../lib/prisma';
import { redis, withLock } from '../../lib/redis';
import { audit, type AuditContext } from '../audit';
import { recordCapSignal } from '../cap-signals';
import { freshRecipientCount, loadAccount } from '../subscription/limits';
import { sendInConversation } from '../whatsapp/sender';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** 16 random bytes as 26 base32 characters: 128 bits, never derived from anything about the survey. */
export function newJoinCode(): string {
  const bytes = randomBytes(17); // 136 bits, the first 130 give 26 characters
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5 && out.length < 26) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  return out;
}

export interface JoinInput { enabled?: boolean; expiresInDays?: number | null; max?: number | null; countries?: string[]; gifts?: boolean; giftMax?: number | null; rotate?: boolean }
const MAX_EXPIRY_DAYS = 365;

/** The owner's view of a survey's join link. `waNumber` is the connected number the link opens (null while no number is connected). */
export async function getJoin(userId: string, surveyId: string) {
  const s = await prisma.survey.findFirst({ where: { id: surveyId, userId }, include: { account: true } });
  if (!s) throw notFound('Survey');
  const account = s.account ?? (await prisma.whatsAppAccount.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } }));
  const joined = await prisma.surveyRecipient.count({ where: { surveyId, via: 'join' } });
  const completed = await prisma.surveyRecipient.count({ where: { surveyId, via: 'join', status: 'completed' } });
  const joinedIds = (await prisma.surveyRecipient.findMany({ where: { surveyId, via: 'join' }, select: { contactId: true } })).map((r) => r.contactId);
  const giftsGiven = joinedIds.length ? await prisma.giftDelivery.count({ where: { surveyId, contactId: { in: joinedIds } } }) : 0;
  const link = s.joinCode && account?.displayPhone ? joinLink(account.displayPhone, s.joinCode) : null;
  return {
    title: s.title, lang: s.language, enabled: s.joinEnabled, code: s.joinCode, expiresAt: s.joinExpiresAt, max: s.joinMax, countries: s.joinCountries, gifts: s.joinGifts, giftMax: s.joinGiftMax,
    joined, completed, giftsGiven,
    link,
    qr: link ? await QRCode.toDataURL(link, { margin: 1, width: 280, errorCorrectionLevel: 'M' }) : null,
    live: s.status === 'active',
  };
}

export async function updateJoin(userId: string, surveyId: string, input: JoinInput, ctx: AuditContext) {
  const s = await prisma.survey.findFirst({ where: { id: surveyId, userId } });
  if (!s) throw notFound('Survey');
  const data: Prisma.SurveyUpdateInput = {};
  if (input.max !== undefined) data.joinMax = input.max;
  if (input.countries) data.joinCountries = [...new Set(input.countries.map((c) => c.toUpperCase()))];
  if (input.gifts !== undefined) data.joinGifts = input.gifts;
  if (input.giftMax !== undefined) data.joinGiftMax = input.giftMax;
  if (input.expiresInDays !== undefined) data.joinExpiresAt = input.expiresInDays === null ? null : new Date(Date.now() + Math.min(input.expiresInDays, MAX_EXPIRY_DAYS) * 86_400_000);
  const turningOn = input.enabled === true && !s.joinEnabled;
  if (input.enabled !== undefined) data.joinEnabled = input.enabled;
  if (input.rotate || (turningOn && !s.joinCode)) data.joinCode = newJoinCode();
  // A link that is switched on without an end date gets one: a QR code printed once must not stay open for ever by accident.
  if (turningOn && input.expiresInDays === undefined && !s.joinExpiresAt) data.joinExpiresAt = new Date(Date.now() + 30 * 86_400_000);
  if (input.gifts === true && s.giftType === 'none') throw badRequest('no_gift', 'This survey has no gift to give to the people who join.');
  await prisma.survey.update({ where: { id: s.id }, data });
  await audit(ctx, { action: input.rotate ? 'join_link_rotated' : input.enabled === false ? 'join_link_off' : turningOn ? 'join_link_on' : 'join_link_changed', meta: { surveyId: s.id, gifts: input.gifts ?? null, max: input.max ?? null, countries: input.countries?.length ?? null } });
  return getJoin(userId, surveyId);
}

interface Logger { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }

/**
 * Somebody sent "JOIN <code>" to a business's number. Everything that can refuse is checked BEFORE anything is stored, and every refusal looks the same to the person ("this link
 * is not valid any more"): they learn nothing about the survey, its limits or whether the code exists. The number is proven by WhatsApp itself (the message comes from it).
 *
 * Abuse containment, in the order it is applied: a few tries an hour per number, a ceiling of attempts per business an hour (past it we stop answering at all, so that the number
 * cannot be turned into something that sends messages to strangers), then the survey's own limits (live, switched on, not expired, country, maximum), then the free plan's cap
 * on different people reached. A person who joins is asked for consent in the first message and nothing starts until they answer START.
 */
export async function handleJoin(account: WhatsAppAccount & { user: { locale: string } }, from: string, phone: string, code: string, profileName: string | undefined, log: Logger): Promise<void> {
  const lang = (account.user.locale === 'en' ? 'en' : 'fr') as SurveyLang;
  const tries = await redis.incr(`sf:join:try:${account.id}:${from}`);
  if (tries === 1) await redis.expire(`sf:join:try:${account.id}:${from}`, 3600);
  const flood = await redis.incr(`sf:join:acct:${account.id}`);
  if (flood === 1) await redis.expire(`sf:join:acct:${account.id}`, 3600);
  if (tries > 6 || flood > 300) return; // silence: no answer to answer

  const refuse = () => sendInConversation(account, from, [{ kind: 'text', body: joinInvalidText(lang) }], log);

  const survey = await prisma.survey.findUnique({ where: { joinCode: code }, include: { user: { select: { id: true, name: true, businessName: true, plan: true } } } });
  if (!survey || survey.userId !== account.userId) return void (await refuse());
  const surveyLang = (survey.language === 'en' ? 'en' : 'fr') as SurveyLang;

  await withLock(`join:${survey.id}`, async () => {
    const joined = await prisma.surveyRecipient.count({ where: { surveyId: survey.id, via: 'join' } });
    const why = joinRefusal({ enabled: survey.joinEnabled, expiresAt: survey.joinExpiresAt, max: survey.joinMax, countries: survey.joinCountries }, { surveyActive: survey.status === 'active', joined, phone });
    if (why) { log.info({ surveyId: survey.id, why }, 'join refused'); return void (await refuse()); }

    const existing = await prisma.contact.findUnique({ where: { userId_phoneHash: { userId: survey.userId, phoneHash: phoneIndex(phone) } } });
    let recipient = existing ? await prisma.surveyRecipient.findUnique({ where: { surveyId_contactId: { surveyId: survey.id, contactId: existing.id } } }) : null;
    if (recipient?.status === 'completed') return void (await sendInConversation(account, from, [{ kind: 'text', body: sys(surveyLang).alreadyDone }], log));

    if (!recipient) {
      // The free plan reaches a fixed number of different people; a person who joins is one of them. Nobody is created past it.
      const ctx = await loadAccount(survey.userId);
      const cap = ctx.plan.limits.recipients;
      if (cap !== null) {
        const fresh = await freshRecipientCount(survey.userId, existing ? [existing.id] : []) + (existing ? 0 : 1);
        if (fresh > Math.max(0, cap - ctx.usage.recipients)) {
          await recordCapSignal(survey.userId, 'join_refused', { plan: ctx.plan.key, cap, reached: ctx.usage.recipients, wanted: fresh });
          return void (await refuse());
        }
      }
    }

    const name = (profileName ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || (surveyLang === 'en' ? 'Participant' : 'Participant');
    const now = new Date();
    const contact = existing ?? (await prisma.contact.create({ data: { userId: survey.userId, phone, name, tags: ['join'], consentAt: now, consentSource: 'join_link' } }));
    if (!recipient) {
      recipient = await prisma.surveyRecipient.create({ data: { surveyId: survey.id, contactId: contact.id, status: 'sent', sentAt: now, via: 'join' } });
    }
    // The notice is the privacy policy's participants' section. The link is the same in both languages: the page shows itself in the visitor's language (cookie, then browser) and has a switch.
    await sendInConversation(account, from, [{ kind: 'text', body: joinConsentText(surveyLang, survey.user.businessName || survey.user.name, survey.title, `${env.webBaseUrl}/privacy#participants`) }], log);
  });
}

/** Should a person who got into the survey by a link be paid? Decided at completion, inside the same transaction as the gift. */
export function joinGiftAllowed(survey: { joinGifts: boolean }, recipientVia: string | null): boolean {
  return recipientVia !== 'join' || survey.joinGifts;
}

