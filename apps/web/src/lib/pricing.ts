import { headers } from 'next/headers';
import { identityQuote, planPrices, overagePerBlock, type PaidPlanKey, type PlanPriceRow } from '@surveyflow/shared';
import { API_URL, internalHeaders } from './auth';
import { countryFromHeaders } from './geo';

/** What the public pages show: the FCFA prices converted at the live rate into the visitor's currency (computed by the API). */
export interface PricingData {
  country: string;
  currency: string;
  /** The currency the visitor's country uses; differs from `currency` when no fresh exchange rate was available (`fallback`). */
  requestedCurrency: string;
  fallback: boolean;
  quote: { rate: number; asOf: string | null; source: string };
  plans: Record<PaidPlanKey, PlanPriceRow>;
  overagePer100: number;
}

/**
 * Asked per request, with the country this server read from the CDN header (never from the browser). If the API is unreachable the
 * page still renders, in FCFA: the canonical prices need no exchange rate, so this fallback is exact, not a guess.
 */
export async function getPricing(): Promise<PricingData> {
  const country = countryFromHeaders(await headers());
  try {
    const res = await fetch(`${API_URL}/api/pricing`, {
      headers: { ...internalHeaders(), ...(country ? { 'x-sf-country': country } : {}) },
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) return (await res.json()) as PricingData;
  } catch { /* fall through to FCFA */ }
  const q = identityQuote('XAF');
  return { country: 'CM', currency: 'XAF', requestedCurrency: 'XAF', fallback: true, quote: { rate: 1, asOf: null, source: 'identity' }, plans: planPrices(q), overagePer100: overagePerBlock(q) };
}
