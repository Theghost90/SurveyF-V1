import { PAID_GIFT_TYPES, maskPhone } from '@surveyflow/shared';
import { prisma } from '../lib/prisma';
import { audit } from './audit';
import { cancelHeldGift, releaseHeldGiftByOperator, resolveUnknownAsRefunded, resolveUnknownAsSent } from './gifts';
import { resolveReview } from './payments/settlement';

/**
 * The money that needs a person (PAY-07): a payout whose outcome nobody knows, a gift a payout limit holds for good, a payment the provider confirmed but that could
 * not simply be applied. What an operator decides here moves money, so the rules are written into the functions, not left to care:
 *
 *   - the amounts come from the ledger, never from what is typed; each decision is one compare-and-set, so a second run does nothing;
 *   - a decision needs WHO (`operator`) and WHY (`note`); saying "the provider paid" also needs the provider's own reference for the payout (`evidence`);
 *   - it is recorded twice: a full internal line (who, why, the evidence; owner unlinked so the note is never shown to the customer) and a bare line in the
 *     owner's own activity ("SurveyFlow support took an action on a payment or a gift"), so that nothing done to somebody's money is invisible to them;
 *   - participants' numbers are shown masked; showing one in full is a separate, recorded step.
 *
 * What this is NOT: a staff login. There is no identity behind `operator`: it is whatever the operator types, and the credential is access to the database. That is
 * what the admin backend (ADM-01) adds, with accounts, roles, second factors and the rule that the one who asks cannot approve. Until then these functions are reached
 * only by `scripts/payments-review.mts`, not by any web route: a staff screen without those protections would be the stolen-admin-login risk the backlog names.
 */

export type GiftDecision = 'sent' | 'refund' | 'release' | 'cancel';
export interface Decision { operator: string; note: string; evidence?: string }

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
function needWhoAndWhy(d: Decision) {
  if (clean(d.operator).length < 2) throw new Error('say who is deciding (--operator): it is recorded');
  if (clean(d.note).length < 5) throw new Error('say why (--note, at least a few words): it is recorded');
}

export interface GiftToVerify {
  id: string; why: 'unknown_outcome' | 'held_for_good' | 'held'; status: string; type: string; amount: number; fee: number; currency: string; attempts: number;
  error: string | null; providerRef: string | null; owner: string; survey: string; phone: string; createdAt: Date; inLedger: number;
}

/** Gifts only a person can settle: an unknown outcome (debited, never retried by itself), and gifts a limit holds for good (a single amount above a cap). */
export async function giftsToVerify(): Promise<GiftToVerify[]> {
  const rows = await prisma.giftDelivery.findMany({
    where: { giftType: { in: [...PAID_GIFT_TYPES] }, OR: [{ status: 'failed', refundedAt: null }, { status: 'held', heldUntil: null }] },
    orderBy: { createdAt: 'asc' }, take: 200,
    include: { contact: { select: { phone: true } }, survey: { select: { title: true, user: { select: { email: true } } } } },
  });
  const ledger = await prisma.walletEntry.groupBy({ by: ['refId'], where: { refId: { in: rows.map((r) => r.id) }, kind: { in: ['gift_debit', 'gift_refund'] } }, _sum: { delta: true } });
  const held = new Map(ledger.map((l) => [l.refId, -(l._sum.delta ?? 0)]));
  return rows.map((g) => ({
    id: g.id, why: g.status === 'failed' ? 'unknown_outcome' as const : 'held_for_good' as const, status: g.status, type: g.giftType, amount: g.amount ?? 0, fee: g.fee, currency: g.currency, attempts: g.attempts,
    error: g.errorMessage, providerRef: g.providerRef, owner: g.survey.user.email, survey: g.survey.title, phone: maskPhone(g.contact.phone), createdAt: g.createdAt, inLedger: held.get(g.id) ?? 0,
  }));
}

/** What a decision would do, for the preview that comes before any `--yes`. */
export function describeGiftDecision(g: GiftToVerify, decision: GiftDecision): string {
  switch (decision) {
    case 'sent': return `mark it SENT (you saw the payout in the provider's records) and tell the participant. The ledger keeps the ${g.inLedger} ${g.currency} debit.`;
    case 'refund': return `put ${g.inLedger} ${g.currency} back in the owner's wallet (what the ledger says this gift holds), once. The owner can then retry it.`;
    case 'release': return `pay it out whatever the limits say: debit the owner's wallet ${g.amount + g.fee} ${g.currency}, and count it in the limits from now on.`;
    case 'cancel': return 'drop it. It was never debited and never promised, so nothing is given back.';
  }
}

/** Carries out one decision on one gift. 'not_resolvable' = it is not in a state this decision applies to (already resolved, or never needed it). */
export async function resolveGift(id: string, decision: GiftDecision, d: Decision): Promise<'done' | 'not_resolvable' | 'insufficient'> {
  needWhoAndWhy(d);
  if (decision === 'sent' && clean(d.evidence).length < 4) throw new Error("saying the provider paid needs the provider's own reference for that payout (--evidence)");
  const gift = await prisma.giftDelivery.findUnique({ where: { id }, include: { survey: { select: { userId: true } } } });
  if (!gift) return 'not_resolvable';
  let result: 'done' | 'not_resolvable' | 'insufficient' = 'not_resolvable';
  let moved = 0;
  if (decision === 'sent') result = (await resolveUnknownAsSent(id, clean(d.evidence))) ? 'done' : 'not_resolvable';
  else if (decision === 'refund') { const r = await resolveUnknownAsRefunded(id); result = r.ok ? 'done' : 'not_resolvable'; moved = r.refunded; }
  else if (decision === 'cancel') result = (await cancelHeldGift(id, clean(d.note))) ? 'done' : 'not_resolvable';
  else { const r = await releaseHeldGiftByOperator(id); result = r === 'ok' ? 'done' : r === 'insufficient' ? 'insufficient' : 'not_resolvable'; }
  if (result === 'not_resolvable') return result;
  await recordDecision('staff_gift_resolved', gift.survey.userId, 'gift', { giftId: id, decision, result, moved, operator: clean(d.operator), note: clean(d.note), evidence: clean(d.evidence) || null });
  return result;
}

/** A payment in `review`: credited or rejected by a person (the rules of `resolveReview`), now recorded with who and why. */
export async function resolvePayment(txId: string, decision: 'credit' | 'reject', d: Decision): Promise<'credited' | 'rejected' | 'not_in_review'> {
  needWhoAndWhy(d);
  const tx = await prisma.paymentTransaction.findUnique({ where: { id: txId }, select: { userId: true, reference: true, amount: true, currency: true } });
  if (!tx) return 'not_in_review';
  const r = await resolveReview(txId, decision, `${clean(d.operator)}: ${clean(d.note)}`);
  if (r !== 'not_in_review') await recordDecision('staff_payment_resolved', tx.userId, 'payment', { paymentId: txId, reference: tx.reference, amount: tx.amount, currency: tx.currency, decision, result: r, operator: clean(d.operator), note: clean(d.note) });
  return r;
}

/** Shows a participant's number in full: one deliberate step, recorded with who and why. */
export async function revealGiftNumber(id: string, d: Decision): Promise<string | null> {
  needWhoAndWhy(d);
  const g = await prisma.giftDelivery.findUnique({ where: { id }, include: { contact: { select: { phone: true } }, survey: { select: { userId: true } } } });
  if (!g) return null;
  await audit({ userId: null }, { action: 'staff_number_revealed', meta: { ownerId: g.survey.userId, giftId: id, operator: clean(d.operator), note: clean(d.note) } });
  return g.contact.phone;
}

async function recordDecision(action: 'staff_gift_resolved' | 'staff_payment_resolved', ownerId: string, what: 'gift' | 'payment', meta: Record<string, unknown>) {
  await audit({ userId: null }, { action, meta: { ownerId, ...meta } });
  // The owner's own trail gets a line with no note and no names: that something was done, and to what. The note is internal.
  await audit({ userId: ownerId }, { action: 'support_action', meta: { what, result: meta.result as string } });
}
