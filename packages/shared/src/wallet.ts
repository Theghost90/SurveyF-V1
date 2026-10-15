import { convertFromXAF, roundNice, type FxQuote } from './fx';

/**
 * Gift wallet rules shared by the API (which enforces them) and the dashboard (which previews them).
 *
 * The SURVEY OWNER pays for participant gifts. Money flows: owner tops up a prepaid wallet through the normal payment layer →
 * each airtime / Mobile Money gift debits the wallet when the participant completes → a definite payout failure refunds the
 * wallet. SurveyFlow never fronts gift money.
 *
 * The wallet is kept in the OWNER'S currency (whole units): a Nigerian owner tops up and sets gift amounts in naira, a Kenyan in
 * shillings, a Cameroonian in FCFA. The numbers below are defined in FCFA and converted at the live rate (tidy 1-2-5 values).
 * The payout provider speaks CFA francs only, so each gift also records its XAF equivalent at the moment it is paid.
 */

/** Smallest / largest single top-up, in FCFA. Max is a fraud + exposure cap, not a technical limit. */
export const WALLET_TOPUP_MIN_XAF = 2_000;
export const WALLET_TOPUP_MAX_XAF = 1_000_000;
/** Quick-pick amounts offered in the dashboard, in FCFA. */
export const WALLET_TOPUP_PRESETS_XAF = [5_000, 10_000, 25_000, 50_000, 100_000] as const;
/** Smallest / largest gift a participant can receive, in FCFA. */
export const GIFT_MIN_XAF = 100;
export const GIFT_MAX_XAF = 20_000;

export interface WalletLimits {
  topupMin: number;
  topupMax: number;
  presets: number[];
  giftMin: number;
  giftMax: number;
}

/** The limits above expressed in the wallet's currency: unchanged for CFA francs, otherwise converted live and rounded to tidy values. */
export function walletLimits(quote: FxQuote): WalletLimits {
  const cfa = quote.currency === 'XAF' || quote.currency === 'XOF';
  const conv = (xaf: number) => (cfa ? xaf : Math.max(1, roundNice(convertFromXAF(xaf, quote))));
  return {
    topupMin: conv(WALLET_TOPUP_MIN_XAF), topupMax: conv(WALLET_TOPUP_MAX_XAF), presets: WALLET_TOPUP_PRESETS_XAF.map(conv),
    giftMin: conv(GIFT_MIN_XAF), giftMax: conv(GIFT_MAX_XAF),
  };
}

/** Gift types that move real money and therefore need wallet funds. */
export const PAID_GIFT_TYPES = ['airtime', 'momo'] as const;
export const isPaidGift = (t: string): t is (typeof PAID_GIFT_TYPES)[number] => (PAID_GIFT_TYPES as readonly string[]).includes(t);

/**
 * Pass-through fee on a gift (payout + collection costs). Rounded UP so SurveyFlow can never lose a fraction of a unit per
 * gift. `percent` comes from server config; the dashboard receives it from GET /api/wallet.
 */
export function giftFee(amount: number, percent: number): number {
  if (!(amount > 0) || !(percent > 0)) return 0;
  return Math.ceil((amount * percent) / 100);
}

/** What ONE gift costs the owner: the participant's amount plus the fee (same currency). */
export function giftUnitCost(amount: number, percent: number): number {
  return amount + giftFee(amount, percent);
}

/**
 * Worst-case exposure of a send: every invited contact completes. With a gift cap the exposure is bounded by it.
 * (Real completion rates are far lower — this is the number the wallet needs to cover to guarantee EVERY gift.)
 */
export function worstCaseGiftCost(args: { amount: number; percent: number; invited: number; alreadyGifted: number; maxCount: number | null }): number {
  const room = args.maxCount ? Math.max(0, args.maxCount - args.alreadyGifted) : Infinity;
  return Math.min(args.invited, room) * giftUnitCost(args.amount, args.percent);
}
