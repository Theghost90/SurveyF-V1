/**
 * Single source of truth for plans, prices and limits.
 * The marketing site, the dashboard, the payment layer and the plan-limit
 * middleware all import from here, so prices can never drift apart.
 *
 * Prices follow the V1 spec (§5.2). NOTE: the "SurveyFlow Hero & Pricing" design
 * artifact shows different example prices (14,500 / 39,000 / 95,000). Change them
 * HERE if those are the intended ones — nothing else needs to move.
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
    priceFCFA: 9_500,
    limits: { activeSurveys: 3, responsesPerMonth: 500, messagesPerMonth: 1_000, teamMembers: 1 },
    features: { exports: true, googleSheets: false, giftAutomation: false, apiAccess: false, prioritySupport: false, whiteLabel: false },
  },
  growth: {
    key: 'growth',
    priceFCFA: 29_000,
    limits: { activeSurveys: 15, responsesPerMonth: 3_000, messagesPerMonth: 7_000, teamMembers: 3 },
    features: { exports: true, googleSheets: true, giftAutomation: true, apiAccess: false, prioritySupport: true, whiteLabel: false },
  },
  business: {
    key: 'business',
    priceFCFA: 75_000,
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

/** Spec §9.7 multi-currency price table. */
export const PLAN_PRICES: Record<PaidPlanKey, Partial<Record<Currency, number>>> = {
  starter: { XAF: 9_500, XOF: 9_500, USD: 15, EUR: 14, NGN: 22_000, KES: 2_000 },
  growth: { XAF: 29_000, XOF: 29_000, USD: 47, EUR: 44, NGN: 70_000, KES: 6_200 },
  business: { XAF: 75_000, XOF: 75_000, USD: 120, EUR: 110, NGN: 180_000, KES: 15_500 },
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
