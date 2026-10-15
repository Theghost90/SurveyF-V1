import { PSP_CHARGE_CURRENCIES, currencyForCountry, identityQuote, isCfa, isCurrency, type Currency, type FxQuote, type PaymentMethod } from '@surveyflow/shared';
import { AppError } from '../lib/errors';
import { getQuote, quoteOrXaf } from './fx';

/**
 * Which currency an owner is billed and holds their wallet in.
 *  - owner currency: the currency of their country (it follows the visitor's location until the first payment, then stays);
 *  - wallet currency: set by the FIRST top-up and never changed, so a ledger never mixes units.
 */
export const ownerCurrency = (u: { preferredCurrency: string | null; country: string }): Currency =>
  isCurrency(u.preferredCurrency) ? u.preferredCurrency : currencyForCountry(u.country);

export const walletCurrency = (u: { giftCurrency: string | null; preferredCurrency: string | null; country: string }): Currency =>
  isCurrency(u.giftCurrency) ? u.giftCurrency : ownerCurrency(u);

/** Quote for the wallet's currency; refuses (503) rather than guess when a non-CFA currency has no fresh rate. */
export async function walletQuote(u: { giftCurrency: string | null; preferredCurrency: string | null; country: string }) {
  const currency = walletCurrency(u);
  const quote = await getQuote(currency);
  if (!quote) throw new AppError(503, 'fx_unavailable', `The ${currency} exchange rate is temporarily unavailable. Please try again in a few minutes.`);
  return quote;
}

/**
 * What a subscription is priced and charged in: the owner's currency at the live rate, as long as the payment providers can charge in it.
 * No fresh rate (or a currency they cannot charge, like EUR) → CFA francs, flagged `fallback`, never an invented conversion.
 */
export async function billingQuote(u: { preferredCurrency: string | null; country: string }): Promise<{ quote: FxQuote; fallback: boolean; requested: Currency }> {
  const requested = ownerCurrency(u);
  const r = await quoteOrXaf(requested);
  if (!(PSP_CHARGE_CURRENCIES as readonly string[]).includes(r.quote.currency)) return { quote: identityQuote('XAF'), fallback: true, requested };
  return { ...r, requested };
}

/** Mobile Money (MTN MoMo / Orange Money) only exists in CFA francs; every other currency pays by international card through the providers. */
export const methodsFor = (currency: string): PaymentMethod[] => (isCfa(currency) ? ['mobile_money', 'card'] : ['card']);

export { isCfa };
