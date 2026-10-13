/**
 * Gift wallet rules shared by the API (which enforces them) and the dashboard (which previews them).
 *
 * The SURVEY OWNER pays for participant gifts. Money flows: owner tops up a prepaid FCFA wallet through the
 * normal payment layer → each airtime / Mobile Money gift debits the wallet when the participant completes →
 * a definite payout failure refunds the wallet. SurveyFlow never fronts gift money.
 *
 * Everything is in whole FCFA (XAF and XOF are pegged 1:1 and gifts only exist in that zone), so no FX is involved.
 */

/** Smallest / largest single top-up. Max is a fraud + exposure cap, not a technical limit. */
export const WALLET_TOPUP_MIN_FCFA = 2_000;
export const WALLET_TOPUP_MAX_FCFA = 1_000_000;
/** Quick-pick amounts offered in the dashboard. */
export const WALLET_TOPUP_PRESETS = [5_000, 10_000, 25_000, 50_000, 100_000] as const;

/** Gift types that move real money and therefore need wallet funds. */
export const PAID_GIFT_TYPES = ['airtime', 'momo'] as const;
export const isPaidGift = (t: string): t is (typeof PAID_GIFT_TYPES)[number] => (PAID_GIFT_TYPES as readonly string[]).includes(t);

/**
 * Pass-through fee on a gift (payout + collection costs). Rounded UP so SurveyFlow can never lose a fraction of a
 * franc per gift. `percent` comes from server config; the dashboard receives it from GET /api/wallet.
 */
export function giftFeeFCFA(amountFCFA: number, percent: number): number {
  if (!(amountFCFA > 0) || !(percent > 0)) return 0;
  return Math.ceil((amountFCFA * percent) / 100);
}

/** What ONE gift costs the owner: the participant's amount plus the fee. */
export function giftUnitCostFCFA(amountFCFA: number, percent: number): number {
  return amountFCFA + giftFeeFCFA(amountFCFA, percent);
}

/**
 * Worst-case exposure of a send: every invited contact completes. With a gift cap the exposure is bounded by it.
 * (Real completion rates are far lower — this is the number the wallet needs to cover to guarantee EVERY gift.)
 */
export function worstCaseGiftCostFCFA(args: { amountFCFA: number; percent: number; invited: number; alreadyGifted: number; maxCount: number | null }): number {
  const room = args.maxCount ? Math.max(0, args.maxCount - args.alreadyGifted) : Infinity;
  return Math.min(args.invited, room) * giftUnitCostFCFA(args.amountFCFA, args.percent);
}
