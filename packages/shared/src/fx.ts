/**
 * Currency conversion, as pure functions. SurveyFlow's canonical prices are in CFA francs; every other currency is derived from a
 * LIVE rate (apps/api/src/services/fx.ts fetches it) and never from a number typed into the code.
 *
 * A rate is "units of the target currency per 1 XAF" (so NGN 2.4 means 1 XAF = 2.4 NGN).
 *  - XAF and XOF are pegged 1:1 to each other, and both to the euro at 655.957 per EUR, so those three never need a live rate.
 *  - Everything else (NGN, KES, GHS, USD, GBP, ZAR, UGX) comes from the live feed.
 */

export const CURRENCIES = ['XAF', 'XOF', 'ZAR', 'GHS', 'KES', 'NGN', 'UGX', 'USD', 'GBP', 'EUR'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Currencies the payment providers can charge in (the owner's statement: XAF, XOF, ZAR, GHS, KES, NGN, UGX, USD, GBP, EUR). */
export const PSP_CHARGE_CURRENCIES: readonly Currency[] = ['XAF', 'XOF', 'ZAR', 'GHS', 'KES', 'NGN', 'UGX', 'USD', 'GBP', 'EUR'];

export const isCurrency = (v: unknown): v is Currency => (CURRENCIES as readonly unknown[]).includes(v);
export const isCfa = (c: string): boolean => c === 'XAF' || c === 'XOF';

/** Fixed euro peg of the CFA franc: 1 EUR = 655.957 XAF (= XOF). */
export const XAF_PER_EUR = 655.957;

export type FxSource = 'identity' | 'peg' | 'live' | 'stale';
export interface FxQuote {
  currency: Currency;
  /** Units of `currency` per 1 XAF. */
  rate: number;
  /** When the rate was published by the source (ISO), null for fixed pegs. */
  asOf: string | null;
  source: FxSource;
}

export const identityQuote = (currency: Currency = 'XAF'): FxQuote => ({ currency, rate: 1, asOf: null, source: 'identity' });
export const eurQuote = (): FxQuote => ({ currency: 'EUR', rate: 1 / XAF_PER_EUR, asOf: null, source: 'peg' });

/**
 * A price people see and pay: three significant digits from 1,000 up, whole units from 10 up, and two decimals only below 10
 * (those small values are display-only, like the overage per block: a charged amount is always a whole number of units, which is also
 * what the database stores). The deviation from the exact conversion is at most about 0.5 % above 1,000 and 2 % around 25.
 */
export function roundPrice(value: number, _currency?: Currency): number {
  if (!(value > 0)) return 0;
  if (value >= 1000) {
    const unit = Math.pow(10, Math.floor(Math.log10(value)) - 2);
    return Math.round(value / unit) * unit;
  }
  if (value >= 10) return Math.round(value);
  return Math.round(value * 100) / 100;
}

/** Nearest value of the 1-2-5 series (… 100, 200, 500, 1000 …): for limits and presets, where a tidy number matters more than precision. */
export function roundNice(value: number): number {
  if (!(value > 0)) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const candidates = [1, 2, 5, 10].map((m) => m * pow);
  return candidates.reduce((best, c) => (Math.abs(Math.log(c / value)) < Math.abs(Math.log(best / value)) ? c : best));
}

/** XAF → `quote.currency`, rounded for display and payment. CFA francs pass through untouched. */
export function convertFromXAF(amountXAF: number, quote: FxQuote): number {
  if (isCfa(quote.currency)) return amountXAF;
  return roundPrice(amountXAF * quote.rate, quote.currency);
}

/** Same, but exact (no price rounding): for sums that are rounded once at the end, like annual = 11 × monthly. */
export function convertFromXAFExact(amountXAF: number, quote: FxQuote): number {
  return isCfa(quote.currency) ? amountXAF : amountXAF * quote.rate;
}

/** `quote.currency` → whole XAF (what a payout provider that only speaks CFA francs is asked to send). */
export function convertToXAF(amount: number, quote: FxQuote): number {
  if (isCfa(quote.currency)) return Math.round(amount);
  return Math.round(amount / quote.rate);
}
