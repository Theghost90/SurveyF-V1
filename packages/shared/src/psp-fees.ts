import type { PaymentMethod, PspName } from './countries';
import { isCfa, type Currency } from './fx';

/**
 * What each payment provider charges SurveyFlow, as read from the owner's contract-fee document ("PSPs contract fees", 2026), used to
 * pick the cheapest provider per payment. Percent of the amount, plus an optional fixed part per payment.
 *
 * Overridable at runtime with the PSP_FEES environment variable (your real negotiated rates win), merged per provider and method.
 * A provider with no fee anywhere (PayUnit: not in the document) ranks after the ones with a known fee, in its configured order.
 */
export interface PspFee {
  /** Percent of the payment amount. */
  percent: number;
  /** Fixed part per payment, in `fixedCurrency`. */
  fixed?: number;
  fixedCurrency?: Currency;
}
export type PspFees = Partial<Record<PspName, Partial<Record<PaymentMethod, PspFee>>>>;

/** CamerPay's plans (monthly fee → commission on mobile money). BYOK = your own Orange/MTN merchant keys, 0 % commission. */
export type CamerpayPlan = 'starter' | 'business' | 'pro' | 'byok';
export const CAMERPAY_PLANS: Record<CamerpayPlan, { monthlyXAF: number; mobileMoneyPercent: number; note: string }> = {
  starter: { monthlyXAF: 0, mobileMoneyPercent: 3.0, note: 'capped at 100 transactions / month' },
  business: { monthlyXAF: 500, mobileMoneyPercent: 1.5, note: 'unlimited transactions' },
  pro: { monthlyXAF: 2_500, mobileMoneyPercent: 1.0, note: '' },
  byok: { monthlyXAF: 2_500, mobileMoneyPercent: 0, note: 'Pro + your own direct Orange/MTN merchant API keys' },
};

/**
 * Fees from the document. Judgement calls, in the open:
 *  - CinetPay mobile money is "2.0 % to 2.5 %": the upper bound is used (conservative).
 *  - CamerPay cards: "provider fees + plan commission". Stripe (~2.9 % + €0.25) is added to the BUYER's checkout total, but it still
 *    makes that provider dearer for the customer, so it is counted: plan commission + 2.9 % + €0.25.
 *  - Payout / withdrawal fees in the document are not collection costs and are not used here.
 *  - CamerPay's plan is a business choice: set CAMERPAY_PLAN (default: starter, the free tier).
 */
export function documentedFees(camerpayPlan: CamerpayPlan = 'starter'): PspFees {
  const cp = CAMERPAY_PLANS[camerpayPlan].mobileMoneyPercent;
  return {
    camerpay: { mobile_money: { percent: cp }, card: { percent: Math.round((cp + 2.9) * 100) / 100, fixed: 0.25, fixedCurrency: 'EUR' } },
    notchpay: { mobile_money: { percent: 1.0 }, card: { percent: 3.9, fixed: 0.3, fixedCurrency: 'USD' } },
    campay: { mobile_money: { percent: 2.0 } }, // cards: not natively supported
    cinetpay: { mobile_money: { percent: 2.5 }, card: { percent: 3.5 } },
    flutterwave: { mobile_money: { percent: 2.0 }, card: { percent: 4.8 } },
  };
}

/** Where each provider's numbers come from (as listed in the contract-fee document, plus the CamerPay pages given by the owner). */
export const PSP_FEE_SOURCES: Record<Exclude<PspName, 'mock'>, { pricing: string; docs?: string; summary: string }> = {
  camerpay: {
    pricing: 'https://camerpay.biz/', docs: 'https://camerpay.biz/docs/',
    summary: 'Mobile money 1.0–3.0 % by plan (Starter 0 XAF/mo 3.0 %, max 100 tx/mo · Business 500 XAF/mo 1.5 % · Pro 2,500 XAF/mo 1.0 % · BYOK 0 %); cards/PayPal via Stripe (~2.9 % + €0.25) or PayPal (~3.49 % + €0.49) added to the buyer\'s checkout; withdrawals from 1,000 FCFA minimum.',
  },
  notchpay: { pricing: 'https://www.notchpay.co/pricing', summary: 'Mobile money (Orange & MTN) 1.0 %; international cards 3.9 % + $0.30; payouts 1.0 %; free setup, 0 XAF/month.' },
  campay: { pricing: 'https://www.campay.net/fr/', summary: 'Mobile money collections 2.0 %; cards not natively supported; withdrawals 1.0 % (mobile) or 5,000 FCFA (bank); free setup, 0 XAF/month.' },
  cinetpay: { pricing: 'https://cinetpay.com/pricing', summary: 'Mobile money 2.0–2.5 %; Visa/Mastercard 3.5 %; withdrawals 1.0–2.0 % (1.5 % flat above 5,000 concurrent transfers); free registration, monthly fees may apply to advanced plans.' },
  flutterwave: { pricing: 'https://flutterwave.com/cm/pricing', summary: 'Mobile money (Cameroon) 2.0 %; cards (local and international) 4.8 %; payouts 1,500 FCFA (bank) or 1.0 % (mobile money); free setup, 0 XAF/month.' },
  payunit: { pricing: '', summary: 'Not in the contract-fee document: no fee known, ranks after providers that have one.' },
};

/** Cost of one payment in XAF. `fixedToXAF` converts the fixed part (return null when no rate is available: the fixed part is then ignored). */
export function effectiveFeeXAF(fee: PspFee, amountXAF: number, fixedToXAF?: (amount: number, currency: Currency) => number | null): number {
  const pct = (fee.percent / 100) * amountXAF;
  if (!fee.fixed) return pct;
  const fixed = fee.fixedCurrency && !isCfa(fee.fixedCurrency) ? fixedToXAF?.(fee.fixed, fee.fixedCurrency) ?? 0 : fee.fixed;
  return pct + fixed;
}

/**
 * Orders providers cheapest-first for this payment. With `amountXAF` the fixed parts count (a $0.30 fixed fee matters on a 14,500 FCFA
 * payment); without it only the percentage is compared. Providers with no known fee go last, in their given order.
 */
export function rankByFee(
  psps: PspName[], method: PaymentMethod, fees: PspFees,
  ctx: { amountXAF?: number; fixedToXAF?: (amount: number, currency: Currency) => number | null } = {},
): PspName[] {
  const cost = (p: PspName): number | undefined => {
    const f = fees[p]?.[method];
    if (!f) return undefined;
    return ctx.amountXAF ? effectiveFeeXAF(f, ctx.amountXAF, ctx.fixedToXAF) : f.percent;
  };
  return psps
    .map((p, i) => ({ p, i, c: cost(p) }))
    .sort((a, b) => (a.c === undefined && b.c === undefined ? a.i - b.i : a.c === undefined ? 1 : b.c === undefined ? -1 : a.c - b.c || a.i - b.i))
    .map((x) => x.p);
}
