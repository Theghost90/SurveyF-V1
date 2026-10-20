/**
 * Single source of truth for plans, prices and limits.
 * The marketing site, the dashboard, the payment layer and the plan-limit
 * middleware all import from here, so prices can never drift apart.
 *
 * Prices are the owner's decision (14,500 / 39,000 / 95,000 FCFA), which supersede the
 * blueprint's 9,500 / 29,000 / 75,000. Change them HERE — nothing else needs to move.
 * Every other currency is converted from these FCFA prices at a LIVE rate (see fx.ts); nothing is typed in per currency.
 */
import { convertFromXAF, convertFromXAFExact, identityQuote, isCfa, type Currency, type FxQuote } from './fx';
export type { Currency } from './fx';

export const PLAN_KEYS = ['trial', 'starter', 'growth', 'business'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export type PaidPlanKey = Exclude<PlanKey, 'trial'>;
export const PAID_PLAN_KEYS: PaidPlanKey[] = ['starter', 'growth', 'business'];

export interface PlanLimits {
  /** Surveys in status "active" at the same time. null = unlimited. */
  activeSurveys: number | null;
  /** Completed participants per billing period. */
  responsesPerMonth: number;
  /**
   * Business-initiated (template) WhatsApp messages per billing period:
   * invitations, reminders and out-of-window gift notices.
   * Free-form replies inside the 24h window are not counted.
   */
  messagesPerMonth: number;
  teamMembers: number;
  /**
   * How many different people the plan may ever send a survey to. Only Explore has this cap (null = no cap): it is what turns "try it" into
   * "activate to reach everyone", without a countdown. It is counted over the account's whole life, not per month.
   */
  recipients: number | null;
}

export interface PlanFeatures {
  exports: boolean;
  googleSheets: boolean;
  /** airtime / mobile money / discount code / prize draw automation */
  giftAutomation: boolean;
  apiAccess: boolean;
  prioritySupport: boolean;
  whiteLabel: boolean;
  /** Analytics on WhatsApp: the owner asks the SurveyFlow number for STATS, DROP, NONRESP… Paid plans only (Explore sees it in the simulator). */
  analyticsBot: boolean;
}

export interface PlanDef {
  key: PlanKey;
  /** Monthly price in FCFA (XAF). */
  priceFCFA: number;
  limits: PlanLimits;
  features: PlanFeatures;
}

export const PLANS: Record<PlanKey, PlanDef> = {
  // Explore (internal key `trial`): free, no clock, capped by USAGE. One live survey and 5 people reached for real, for the whole life of the
  // account (so a plan that lapses lands here too, never on a free Starter). Responses cannot be refused mid-survey, so the cap that really
  // bounds them is `recipients`; the numbers below only describe what 5 recipients can produce.
  trial: {
    key: 'trial',
    priceFCFA: 0,
    limits: { activeSurveys: 1, responsesPerMonth: 5, messagesPerMonth: 25, teamMembers: 1, recipients: 5 },
    // No gift automation: airtime/MoMo gifts are real money, and a free tier that can pay out is a farming vector.
    features: { exports: true, googleSheets: false, giftAutomation: false, apiAccess: false, prioritySupport: false, whiteLabel: false, analyticsBot: false },
  },
  starter: {
    key: 'starter',
    priceFCFA: 14_500,
    limits: { activeSurveys: 3, responsesPerMonth: 500, messagesPerMonth: 1_000, teamMembers: 1, recipients: null },
    features: { exports: true, googleSheets: false, giftAutomation: false, apiAccess: false, prioritySupport: false, whiteLabel: false, analyticsBot: true },
  },
  growth: {
    key: 'growth',
    priceFCFA: 39_000,
    limits: { activeSurveys: 15, responsesPerMonth: 3_000, messagesPerMonth: 7_000, teamMembers: 3, recipients: null },
    features: { exports: true, googleSheets: true, giftAutomation: true, apiAccess: false, prioritySupport: true, whiteLabel: false, analyticsBot: true },
  },
  business: {
    key: 'business',
    priceFCFA: 95_000,
    limits: { activeSurveys: null, responsesPerMonth: 15_000, messagesPerMonth: 30_000, teamMembers: 10, recipients: null },
    features: { exports: true, googleSheets: true, giftAutomation: true, apiAccess: true, prioritySupport: true, whiteLabel: true, analyticsBot: true },
  },
};

/** Entitlements that are sold on the plan table but not built in V1. Shown as "Coming soon". */
export const COMING_SOON: Array<keyof PlanFeatures | 'teamMembers'> = ['teamMembers', 'apiAccess', 'whiteLabel'];

export const PAST_DUE_GRACE_DAYS = 3;
/** Annual billing = 11 × monthly ("1 month free"). */
export const ANNUAL_MONTHS_CHARGED = 11;
/** Overage: 500 FCFA per 100 extra responses. */
export const OVERAGE = { responsesBlockSize: 100, responsesBlockFCFA: 500 } as const;

/** Price of a plan in FCFA, the canonical currency. */
export function planPriceXAF(plan: PaidPlanKey, interval: 'monthly' | 'annual' = 'monthly'): number {
  return PLANS[plan].priceFCFA * (interval === 'annual' ? ANNUAL_MONTHS_CHARGED : 1);
}

/** Price of a plan in the quote's currency: the live conversion of the FCFA price, rounded once (annual = 11 × the exact monthly). */
export function planPriceIn(plan: PaidPlanKey, interval: 'monthly' | 'annual', quote: FxQuote): number {
  return convertFromXAF(planPriceXAF(plan, interval), quote);
}

export interface PlanPriceRow { monthly: number; annual: number }
export const planPrices = (quote: FxQuote): Record<PaidPlanKey, PlanPriceRow> =>
  Object.fromEntries(PAID_PLAN_KEYS.map((k) => [k, { monthly: planPriceIn(k, 'monthly', quote), annual: planPriceIn(k, 'annual', quote) }])) as Record<PaidPlanKey, PlanPriceRow>;

export function getPlan(key: string): PlanDef {
  return PLANS[(PLAN_KEYS as readonly string[]).includes(key) ? (key as PlanKey) : 'trial'];
}

/** Plan that fits a monthly response volume (mirrors the pricing slider). */
export function recommendPlan(responsesPerMonth: number): PaidPlanKey {
  if (responsesPerMonth <= PLANS.starter.limits.responsesPerMonth) return 'starter';
  if (responsesPerMonth <= PLANS.growth.limits.responsesPerMonth) return 'growth';
  return 'business';
}

/** Effective cost of one answer (in the quote's currency, default FCFA) if the plan's response allowance is fully used. */
export function costPerAnswer(plan: PaidPlanKey, responses: number, quote: FxQuote = identityQuote()): number {
  return convertFromXAFExact(PLANS[plan].priceFCFA, quote) / Math.max(1, Math.min(responses, PLANS[plan].limits.responsesPerMonth));
}

/** Overage price per block of 100 extra responses in the quote's currency (500 FCFA converted). */
export function overagePerBlock(quote: FxQuote = identityQuote()): number {
  return convertFromXAF(OVERAGE.responsesBlockFCFA, quote);
}

/** What people read next to an amount: both CFA francs are "FCFA", everything else its ISO code. */
export const currencyLabel = (currency: string): string => (isCfa(currency) ? 'FCFA' : currency);

/**
 * Money string for a price, always "amount label": "14,500 FCFA", "34,800 NGN", "0.86 USD". One style for every currency, so a price
 * reads the same on the pricing page, in the wallet and in the checkout. Whole units, except small values (< 10) which keep two decimals.
 */
export function formatPrice(amount: number, currency: Currency, locale: 'en' | 'fr' = 'en'): string {
  if (isCfa(currency) || Number.isInteger(amount)) return `${formatFCFA(amount, locale)} ${currencyLabel(currency)}`;
  const [i, d] = amount.toFixed(2).split('.');
  return `${formatFCFA(Number(i), locale)}${locale === 'fr' ? ',' : '.'}${d} ${currencyLabel(currency)}`;
}

/** Overage in FCFA for `used` responses on `plan`. */
export function responseOverageFCFA(plan: PlanKey, used: number): number {
  const extra = Math.max(0, used - getPlan(plan).limits.responsesPerMonth);
  return Math.ceil(extra / OVERAGE.responsesBlockSize) * OVERAGE.responsesBlockFCFA;
}

export function formatFCFA(n: number, locale: 'en' | 'fr' = 'en'): string {
  // Intl uses a narrow no-break space for fr; keep plain separators for predictable rendering.
  const sep = locale === 'fr' ? ' ' : ',';
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}
