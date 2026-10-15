/**
 * Single source of truth for plans, prices and limits.
 * The marketing site, the dashboard, the payment layer and the plan-limit
 * middleware all import from here, so prices can never drift apart.
 *
 * Prices are the owner's decision (14,500 / 39,000 / 95,000 FCFA), which supersede the
 * blueprint's 9,500 / 29,000 / 75,000. Change them HERE — nothing else needs to move.
 * Non-FCFA prices below are DERIVED from the blueprint's implied exchange rates and rounded;
 * they are placeholders until real prices are set for those currencies.
 */

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
}

export interface PlanFeatures {
  exports: boolean;
  googleSheets: boolean;
  /** airtime / mobile money / discount code / prize draw automation */
  giftAutomation: boolean;
  apiAccess: boolean;
  prioritySupport: boolean;
  whiteLabel: boolean;
}

export interface PlanDef {
  key: PlanKey;
  /** Monthly price in FCFA (XAF). */
  priceFCFA: number;
  limits: PlanLimits;
  features: PlanFeatures;
}

export const PLANS: Record<PlanKey, PlanDef> = {
  trial: {
    key: 'trial',
    priceFCFA: 0,
    // Spec §5.1: 14 days, 1 survey, 50 responses. Message cap is our addition.
    limits: { activeSurveys: 1, responsesPerMonth: 50, messagesPerMonth: 100, teamMembers: 1 },
    // No gift automation in trial: airtime/MoMo gifts are real money, and a free
    // trial that can pay out is a farming vector.
    features: { exports: true, googleSheets: false, giftAutomation: false, apiAccess: false, prioritySupport: false, whiteLabel: false },
  },
  starter: {
    key: 'starter',
    priceFCFA: 14_500,
    limits: { activeSurveys: 3, responsesPerMonth: 500, messagesPerMonth: 1_000, teamMembers: 1 },
    features: { exports: true, googleSheets: false, giftAutomation: false, apiAccess: false, prioritySupport: false, whiteLabel: false },
  },
  growth: {
    key: 'growth',
    priceFCFA: 39_000,
    limits: { activeSurveys: 15, responsesPerMonth: 3_000, messagesPerMonth: 7_000, teamMembers: 3 },
    features: { exports: true, googleSheets: true, giftAutomation: true, apiAccess: false, prioritySupport: true, whiteLabel: false },
  },
  business: {
    key: 'business',
    priceFCFA: 95_000,
    limits: { activeSurveys: null, responsesPerMonth: 15_000, messagesPerMonth: 30_000, teamMembers: 10 },
    features: { exports: true, googleSheets: true, giftAutomation: true, apiAccess: true, prioritySupport: true, whiteLabel: true },
  },
};

/** Entitlements that are sold on the plan table but not built in V1. Shown as "Coming soon". */
export const COMING_SOON: Array<keyof PlanFeatures | 'teamMembers'> = ['teamMembers', 'apiAccess', 'whiteLabel'];

export const TRIAL_DAYS = 14;
export const PAST_DUE_GRACE_DAYS = 3;
/** Annual billing = 10 × monthly ("2 months free"). */
export const ANNUAL_MONTHS_CHARGED = 10;
/** Overage: 500 FCFA per 100 extra responses. */
export const OVERAGE = { responsesBlockSize: 100, responsesBlockFCFA: 500 } as const;

export type Currency = 'XAF' | 'XOF' | 'USD' | 'EUR' | 'NGN' | 'KES' | 'GHS';

/** Multi-currency price table (FCFA = owner's prices; other currencies derived, see header). */
export const PLAN_PRICES: Record<PaidPlanKey, Partial<Record<Currency, number>>> = {
  starter: { XAF: 14_500, XOF: 14_500, USD: 23, EUR: 22, NGN: 35_000, KES: 3_100 },
  growth: { XAF: 39_000, XOF: 39_000, USD: 62, EUR: 59, NGN: 94_000, KES: 8_200 },
  business: { XAF: 95_000, XOF: 95_000, USD: 152, EUR: 145, NGN: 228_000, KES: 20_000 },
};

export function planPrice(plan: PaidPlanKey, currency: Currency, interval: 'monthly' | 'annual' = 'monthly'): number {
  const monthly = PLAN_PRICES[plan][currency];
  if (monthly === undefined) throw new Error(`No ${currency} price configured for plan ${plan}`);
  return interval === 'annual' ? monthly * ANNUAL_MONTHS_CHARGED : monthly;
}

export function getPlan(key: string): PlanDef {
  return PLANS[(PLAN_KEYS as readonly string[]).includes(key) ? (key as PlanKey) : 'trial'];
}

/** Plan that fits a monthly response volume (mirrors the pricing slider). */
export function recommendPlan(responsesPerMonth: number): PaidPlanKey {
  if (responsesPerMonth <= PLANS.starter.limits.responsesPerMonth) return 'starter';
  if (responsesPerMonth <= PLANS.growth.limits.responsesPerMonth) return 'growth';
  return 'business';
}

/** Effective FCFA cost of one answer if the plan's response allowance is fully used. */
export function costPerAnswer(plan: PaidPlanKey, responses: number): number {
  return PLANS[plan].priceFCFA / Math.max(1, Math.min(responses, PLANS[plan].limits.responsesPerMonth));
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
