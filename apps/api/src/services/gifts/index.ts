import type { Prisma, Survey, Contact, User } from '@prisma/client';
import { PAID_GIFT_TYPES, buildThankYouMessage, convertToXAF, getPlan, giftFee, isCfa, sys, toWaId, type Currency, type SurveyLang } from '@surveyflow/shared';
import { env } from '../../config/env';
import { conflict } from '../../lib/errors';
import { generateDiscountCode } from '../../lib/crypto';
import { prisma, type Tx } from '../../lib/prisma';
import { walletCurrency } from '../billing-currency';
import { getQuote } from '../fx';
import { receiptToken, receiptUrl } from '../receipts';
import { creditWallet, debitWallet, heldByGift } from '../wallet';
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
 *
 * WHO PAYS: the survey owner, from a prepaid wallet (services/wallet.ts). Airtime / Mobile Money gifts are debited in the
 * SAME transaction that marks the participant completed. If the wallet cannot cover the gift the participant gets a plain
 * thank-you (we never promise a gift that is not paid for) and the row is kept as `unfunded` for the owner to release later.
 */

export interface GiftPlan {
  type: 'airtime' | 'momo' | 'discount' | 'prize_draw' | 'none';
  value?: string | null;
  code?: string;
}

type SurveyWithOwner = Survey & { user: Pick<User, 'plan' | 'giftCurrency' | 'preferredCurrency' | 'country'> };

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
      if (!survey.giftAmount) return { type: 'none' };
      const fee = giftFee(survey.giftAmount, env.GIFT_FEE_PERCENT);
      const gift = await tx.giftDelivery.create({
        data: {
          surveyId: survey.id, contactId: contact.id, giftType: type, giftValue: survey.giftValue, amount: survey.giftAmount, fee, currency: walletCurrency(survey.user),
          status: 'pending', scheduledFor: survey.giftDeliveryMode === 'batch' ? nextTopOfHour() : new Date(),
        },
      });
      const paid = await debitWallet(tx, survey.userId, survey.giftAmount + fee, gift.id, `Gift — ${survey.title}`);
      if (paid === null) {
        // Not enough prepaid balance: the participant must NOT be promised a gift. Keep the row so the owner can release it.
        await tx.giftDelivery.update({ where: { id: gift.id }, data: { status: 'unfunded' } });
        return { type: 'none' };
      }
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

  // The provider pays in CFA francs. A gift in another currency is converted at the live rate ONCE and that amount is pinned on the
  // row, so a retry never re-quotes. No fresh rate: wait (the owner's money stays debited, nothing is guessed) and try again shortly.
  let payoutXAF = gift.payoutXAF;
  if (payoutXAF === null) {
    if (isCfa(gift.currency)) payoutXAF = gift.amount!;
    else {
      const q = await getQuote(gift.currency as Currency);
      if (!q) {
        await prisma.giftDelivery.update({ where: { id }, data: { errorMessage: 'fx_unavailable: waiting for the exchange rate', scheduledFor: new Date(Date.now() + 10 * 60_000) } });
        return;
      }
      payoutXAF = convertToXAF(gift.amount!, q);
    }
  }
  const ref = `sf-gift-${gift.id}`;
  await prisma.giftDelivery.update({ where: { id }, data: { attempts: { increment: 1 }, providerRef: ref, errorMessage: null, payoutXAF } });
  const provider = getGiftProvider();
  try {
    const phone = toWaId(gift.contact.phone);
    const res = gift.giftType === 'airtime' ? await provider.sendAirtime(phone, payoutXAF, ref) : await provider.sendMoMo(phone, payoutXAF, ref);
    await prisma.giftDelivery.update({ where: { id }, data: { status: 'sent', sentAt: new Date(), providerRef: res.providerRef, errorMessage: null } });
    await notifyGiftSent(gift);
  } catch (err) {
    const e = err instanceof GiftError ? err : new GiftError((err as Error).message, true);
    if (e.ambiguous) {
      await prisma.giftDelivery.update({ where: { id }, data: { status: 'failed', errorMessage: `ambiguous: ${e.message} — check provider for ref ${ref} before retrying` } });
    } else if (gift.attempts + 1 >= MAX_ATTEMPTS) {
      // The provider definitely did not pay (every attempt was a clean rejection): give the owner's money back.
      await failAndRefund(id, e.message.slice(0, 300));
    } else {
      await prisma.giftDelivery.update({
        where: { id },
        data: { errorMessage: e.message.slice(0, 300), scheduledFor: new Date(Date.now() + RETRY_DELAYS_MS[Math.min(gift.attempts, RETRY_DELAYS_MS.length - 1)]!) },
      });
    }
  }
}

async function notifyGiftSent(gift: { id: string; surveyId: string; contactId: string; giftValue: string | null; notifyViaTemplate: boolean; survey: { language: string; userId: string; giftDeliveryMode: string; account: { phoneNumberId: string; wabaId: string; accessToken: string } | null }; contact: { phone: string } }) {
  try {
    const lang = (gift.survey.language === 'en' ? 'en' : 'fr') as SurveyLang;
    const value = gift.giftValue ?? '';
    if (gift.survey.giftDeliveryMode === 'immediate' && gift.survey.account && !gift.notifyViaTemplate) {
      // Inside the 24h window the participant just opened by answering: plain text is free.
      // Same look as the template path below: a short message and a "Download receipt" button, not a raw URL in the text.
      await getGateway().sendMessage(credsFor(gift.survey.account), toWaId(gift.contact.phone), { kind: 'link', body: sys(lang).giftSent(value), buttonLabel: sys(lang).receiptButton, url: receiptUrl(gift.id) });
    } else {
      const recipient = await prisma.surveyRecipient.findUnique({ where: { surveyId_contactId: { surveyId: gift.surveyId, contactId: gift.contactId } }, select: { id: true } });
      if (recipient) await enqueueGiftNotice(gift.survey.userId, recipient.id, value, receiptToken(gift.id));
    }
  } catch {
    /* the money moved; a failed courtesy message must not flip the gift to failed */
  }
}

/** pending → failed (definite) and return exactly what the ledger says this gift holds. Idempotent via the status compare-and-set. */
async function failAndRefund(id: string, message: string) {
  await prisma.$transaction(async (tx) => {
    const g = await tx.giftDelivery.findUnique({ where: { id }, select: { survey: { select: { userId: true } } } });
    const claimed = await tx.giftDelivery.updateMany({ where: { id, status: 'pending' }, data: { status: 'failed', errorMessage: message } });
    if (!claimed.count || !g) return;
    const held = await heldByGift(tx, id);
    if (held > 0) {
      await creditWallet(tx, g.survey.userId, held, 'gift_refund', id, 'Gift could not be delivered — refunded');
      await tx.giftDelivery.update({ where: { id }, data: { refundedAt: new Date() } });
    }
  });
}

/** Re-activates one gift (failed→pending or unfunded→pending) and debits the wallet for it, atomically. false = wallet too low. */
async function reactivate(from: 'failed' | 'unfunded', id: string): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      const g = await tx.giftDelivery.findUnique({ where: { id }, select: { amount: true, fee: true, survey: { select: { userId: true, title: true } } } });
      if (!g?.amount) return false;
      // The compare-and-set is what makes a double click / two tabs charge once.
      const claimed = await tx.giftDelivery.updateMany({
        where: { id, status: from, ...(from === 'failed' ? { refundedAt: { not: null } } : {}) },
        // The participant's 24h window is long closed by now: notify through the approved template instead of free text.
        data: { status: 'pending', attempts: 0, errorMessage: null, refundedAt: null, scheduledFor: new Date(), notifyViaTemplate: true },
      });
      if (!claimed.count) return false;
      const ok = await debitWallet(tx, g.survey.userId, g.amount + g.fee, id, `${from === 'failed' ? 'Retry' : 'Released'} — ${g.survey.title}`);
      if (ok === null) throw new InsufficientFunds();
      return true;
    });
  } catch (err) {
    if (err instanceof InsufficientFunds) return false;
    throw err;
  }
}
class InsufficientFunds extends Error {}

/**
 * Owner action: re-queue gifts the provider DEFINITELY rejected (their money was already refunded, so this debits again).
 * Gifts whose outcome is unknown (ambiguous / interrupted) are never retried — a retry could pay a participant twice.
 */
export async function retryFailedGifts(surveyId: string): Promise<{ requeued: number; insufficient: number }> {
  const rows = await prisma.giftDelivery.findMany({
    where: { surveyId, status: 'failed', giftType: { in: [...PAID_GIFT_TYPES] }, refundedAt: { not: null } },
    orderBy: { createdAt: 'asc' }, select: { id: true },
  });
  let requeued = 0;
  for (const { id } of rows) if (await reactivate('failed', id)) requeued++;
  return { requeued, insufficient: rows.length - requeued };
}

/**
 * Owner action after a top-up: pay the gifts of participants who finished while the wallet was empty.
 * Deliberately NOT automatic — a top-up meant for survey B must not be silently spent on survey A's backlog.
 * Oldest first; stops at the first gift the balance cannot cover.
 */
export async function releaseUnfundedGifts(surveyId: string): Promise<{ released: number; remaining: number }> {
  const rows = await prisma.giftDelivery.findMany({
    where: { surveyId, status: 'unfunded', giftType: { in: [...PAID_GIFT_TYPES] } },
    orderBy: { createdAt: 'asc' }, select: { id: true },
  });
  let released = 0;
  for (const { id } of rows) {
    if (!(await reactivate('unfunded', id))) break;
    released++;
  }
  return { released, remaining: rows.length - released };
}

/**
 * Deleting a survey or contact cascades to its GiftDelivery rows. A gift that is debited but not yet delivered would take the
 * owner's money with it, so deletion waits until the pipeline has settled (minutes; batch gifts at most until the next hour).
 */
export async function assertNoGiftsInFlight(where: Prisma.GiftDeliveryWhereInput) {
  const n = await prisma.giftDelivery.count({ where: { ...where, giftType: { in: [...PAID_GIFT_TYPES] }, status: 'pending' } });
  if (n) throw conflict('gifts_in_flight', `${n} gift${n === 1 ? ' is' : 's are'} still being delivered. Try again in a few minutes.`);
}
