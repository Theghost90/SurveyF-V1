import type { Survey, Contact, User } from '@prisma/client';
import { buildThankYouMessage, getPlan, sys, toWaId, type SurveyLang } from '@surveyflow/shared';
import { generateDiscountCode } from '../../lib/crypto';
import { prisma, type Tx } from '../../lib/prisma';
import { credsFor } from '../whatsapp/accounts';
import { getGateway } from '../whatsapp/gateway';
import { enqueueGiftNotice } from '../whatsapp/sender';
import { GiftError, getGiftProvider } from './providers';

/**
 * Gift automation (spec §8 / "GIFT AUTOMATION").
 *
 * The spec's switch statement has no `break`s, so an airtime winner would ALSO receive a
 * discount code, a prize-draw entry and the custom message. Here each gift type is handled
 * in exactly one branch, and delivery is idempotent: GiftDelivery has a unique
 * (surveyId, contactId) key, so a retried webhook can never create a second payout.
 */

export interface GiftPlan {
  type: 'airtime' | 'momo' | 'discount' | 'prize_draw' | 'none';
  value?: string | null;
  code?: string;
}

type SurveyWithOwner = Survey & { user: Pick<User, 'plan'> };

const nextTopOfHour = () => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
};

/**
 * Runs inside the completion transaction. Decides what the participant gets and records it.
 * Falls back to "none" (plain thank-you) when the plan no longer includes gifts or the
 * survey's gift budget is exhausted — never promising something we will not deliver.
 */
export async function planGift(tx: Tx, survey: SurveyWithOwner, contact: Pick<Contact, 'id'>): Promise<GiftPlan> {
  const type = survey.giftType;
  if (type === 'none' || type === 'custom') return { type: 'none' };
  if (!getPlan(survey.user.plan).features.giftAutomation) return { type: 'none' };

  if (survey.giftMaxCount) {
    const used = await tx.giftDelivery.count({ where: { surveyId: survey.id } });
    if (used >= survey.giftMaxCount) return { type: 'none' };
  }
  const existing = await tx.giftDelivery.findUnique({ where: { surveyId_contactId: { surveyId: survey.id, contactId: contact.id } } });
  if (existing) return { type: 'none' }; // already rewarded: never twice

  switch (type) {
    case 'airtime':
    case 'momo': {
      if (!survey.giftAmountFCFA) return { type: 'none' };
      await tx.giftDelivery.create({
        data: {
          surveyId: survey.id, contactId: contact.id, giftType: type, giftValue: survey.giftValue, amountFCFA: survey.giftAmountFCFA,
          status: 'pending', scheduledFor: survey.giftDeliveryMode === 'batch' ? nextTopOfHour() : new Date(),
        },
      });
      return { type, value: survey.giftValue };
    }
    case 'discount': {
      const code = generateDiscountCode();
      await tx.giftDelivery.create({
        data: { surveyId: survey.id, contactId: contact.id, giftType: 'discount', giftValue: survey.giftValue, code, status: 'sent', sentAt: new Date() },
      });
      return { type, value: survey.giftValue, code };
    }
    case 'prize_draw': {
      await tx.prizeDrawEntry.create({ data: { surveyId: survey.id, contactId: contact.id } });
      await tx.giftDelivery.create({
        data: { surveyId: survey.id, contactId: contact.id, giftType: 'prize_draw', giftValue: survey.giftValue, status: 'sent', sentAt: new Date() },
      });
      return { type, value: survey.giftValue };
    }
  }
  return { type: 'none' };
}

export function thankYouText(survey: Pick<Survey, 'language' | 'customThankYou'>, gift: GiftPlan): string {
  return buildThankYouMessage(
    { giftType: gift.type, giftValue: gift.value, customThankYou: survey.customThankYou, code: gift.code },
    (survey.language === 'en' ? 'en' : 'fr') as SurveyLang,
  );
}

// ---- delivery worker ---------------------------------------------------------------------

const RETRY_DELAYS_MS = [10 * 60_000, 60 * 60_000];
const MAX_ATTEMPTS = 3;
const LEASE_MS = 5 * 60_000;

export async function processDueGifts(limit = 20): Promise<number> {
  // Lease by pushing scheduledFor into the future; if we crash mid-flight the row reappears later.
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "GiftDelivery" SET "scheduledFor" = now() + (${LEASE_MS / 1000} * interval '1 second')
    WHERE "id" IN (
      SELECT "id" FROM "GiftDelivery"
      WHERE "status" = 'pending' AND "scheduledFor" <= now() AND "giftType" IN ('airtime','momo')
      ORDER BY "scheduledFor" ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ) RETURNING "id"`;
  for (const { id } of claimed) await processGift(id);
  return claimed.length;
}

async function processGift(id: string) {
  const gift = await prisma.giftDelivery.findUnique({
    where: { id },
    include: { contact: true, survey: { include: { account: true } } },
  });
  if (!gift || gift.status !== 'pending') return;

  // attempts > 0 with no recorded outcome = a previous run died after possibly calling the provider.
  if (gift.attempts > 0 && !gift.errorMessage) {
    await prisma.giftDelivery.update({
      where: { id }, data: { status: 'failed', errorMessage: `interrupted: outcome unknown, check provider for ref ${gift.providerRef ?? id} before retrying` },
    });
    return;
  }

  const ref = `sf-gift-${gift.id}`;
  await prisma.giftDelivery.update({ where: { id }, data: { attempts: { increment: 1 }, providerRef: ref, errorMessage: null } });
  const provider = getGiftProvider();
  try {
    const phone = toWaId(gift.contact.phone);
    const res = gift.giftType === 'airtime' ? await provider.sendAirtime(phone, gift.amountFCFA!, ref) : await provider.sendMoMo(phone, gift.amountFCFA!, ref);
    await prisma.giftDelivery.update({ where: { id }, data: { status: 'sent', sentAt: new Date(), providerRef: res.providerRef, errorMessage: null } });
    await notifyGiftSent(gift);
  } catch (err) {
    const e = err instanceof GiftError ? err : new GiftError((err as Error).message, true);
    if (e.ambiguous) {
      await prisma.giftDelivery.update({ where: { id }, data: { status: 'failed', errorMessage: `ambiguous: ${e.message} — check provider for ref ${ref} before retrying` } });
    } else if (gift.attempts + 1 >= MAX_ATTEMPTS) {
      await prisma.giftDelivery.update({ where: { id }, data: { status: 'failed', errorMessage: e.message.slice(0, 300) } });
    } else {
      await prisma.giftDelivery.update({
        where: { id },
        data: { errorMessage: e.message.slice(0, 300), scheduledFor: new Date(Date.now() + RETRY_DELAYS_MS[Math.min(gift.attempts, RETRY_DELAYS_MS.length - 1)]!) },
      });
    }
  }
}

async function notifyGiftSent(gift: { surveyId: string; contactId: string; giftValue: string | null; survey: { language: string; userId: string; giftDeliveryMode: string; account: { phoneNumberId: string; wabaId: string; accessToken: string } | null }; contact: { phone: string } }) {
  try {
    const lang = (gift.survey.language === 'en' ? 'en' : 'fr') as SurveyLang;
    const value = gift.giftValue ?? '';
    if (gift.survey.giftDeliveryMode === 'immediate' && gift.survey.account) {
      // Inside the 24h window the participant just opened by answering: plain text is free.
      await getGateway().sendMessage(credsFor(gift.survey.account), toWaId(gift.contact.phone), { kind: 'text', body: sys(lang).giftSent(value) });
    } else {
      const recipient = await prisma.surveyRecipient.findUnique({ where: { surveyId_contactId: { surveyId: gift.surveyId, contactId: gift.contactId } }, select: { id: true } });
      if (recipient) await enqueueGiftNotice(gift.survey.userId, recipient.id, value);
    }
  } catch {
    /* the money moved; a failed courtesy message must not flip the gift to failed */
  }
}

/** Owner action: re-queue gifts that definitively failed (not the ambiguous ones). */
export async function retryFailedGifts(surveyId: string): Promise<number> {
  const r = await prisma.giftDelivery.updateMany({
    where: { surveyId, status: 'failed', giftType: { in: ['airtime', 'momo'] }, NOT: { errorMessage: { startsWith: 'ambiguous' } }, AND: [{ NOT: { errorMessage: { startsWith: 'interrupted' } } }] },
    data: { status: 'pending', attempts: 0, errorMessage: null, scheduledFor: new Date() },
  });
  return r.count;
}
