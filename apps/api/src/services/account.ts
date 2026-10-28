import { billingQuote } from './billing-currency';
import type { Subscription, User } from '@prisma/client';
import { PLANS, convertFromXAF, responseOverageFCFA } from '@surveyflow/shared';
import { prisma } from '../lib/prisma';
import { loadAccount } from './subscription/limits';

export function userDto(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    businessName: u.businessName,
    phone: u.phone,
    plan: u.plan,
    country: u.country,
    locale: u.locale,
    preferredCurrency: u.preferredCurrency,
    segment: u.segment,
    trialEndsAt: u.trialEndsAt,
    onboardingDoneAt: u.onboardingDoneAt,
    createdAt: u.createdAt,
    // Security state the web app needs to draw banners and the right sign-in prompts (never a hash, secret or code).
    emailVerified: !!u.emailVerifiedAt,
    twoFactorEnabled: !!u.totpEnabledAt,
    hasPassword: !!u.passwordHash,
  };
}

export function subscriptionDto(s: Subscription) {
  const msLeft = s.currentPeriodEnd.getTime() - Date.now();
  return {
    id: s.id,
    plan: s.plan,
    status: s.status,
    interval: s.interval,
    currentPeriodStart: s.currentPeriodStart,
    currentPeriodEnd: s.currentPeriodEnd,
    daysLeft: Math.max(0, Math.ceil(msLeft / 86_400_000)),
    amountFCFA: s.amountFCFA,
    paymentMethod: s.paymentMethod,
    pspProvider: s.pspProvider,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    graceEndsAt: s.graceEndsAt,
  };
}

/** Everything the dashboard shell needs in one call (plan, usage vs limits, onboarding progress). */
export async function accountSummary(userId: string) {
  const ctx = await loadAccount(userId);
  const [whatsapp, contacts, surveys] = await Promise.all([
    prisma.whatsAppAccount.count({ where: { userId, status: 'active' } }),
    prisma.contact.count({ where: { userId } }),
    prisma.survey.count({ where: { userId } }),
  ]);
  const { plan, usage } = ctx;
  const { quote } = await billingQuote(ctx.user);
  // Responses beyond a plan are billed as overage only on a PAID plan: Explore (or a lapsed plan) has nothing to bill.
  const overageFCFA = ctx.subscription.amountFCFA > 0 ? responseOverageFCFA(plan.key, usage.responses) : 0;
  return {
    user: userDto(ctx.user),
    subscription: subscriptionDto(ctx.subscription),
    plan: { key: plan.key, priceFCFA: plan.priceFCFA, limits: plan.limits, features: plan.features },
    usage: {
      activeSurveys: usage.activeSurveys,
      responses: usage.responses,
      messages: usage.messages,
      /** Different people ever invited (counted for Explore only). */
      recipients: usage.recipients,
      periodStart: usage.periodStart,
      periodEnd: usage.periodEnd,
      responseOverageFCFA: overageFCFA,
      /** The same overage in the owner's billing currency (live rate). `overageCurrency` says which. */
      responseOverage: convertFromXAF(overageFCFA, quote),
      overageCurrency: quote.currency,
    },
    onboarding: {
      whatsappConnected: whatsapp > 0,
      hasContacts: contacts > 0,
      hasSurvey: surveys > 0,
      paidPlan: ctx.subscription.amountFCFA > 0,
      segmentChosen: !!ctx.user.segment,
      done: !!ctx.user.onboardingDoneAt,
    },
    plans: PLANS,
  };
}
