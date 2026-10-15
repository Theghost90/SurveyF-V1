import { billingQuote } from './billing-currency';
import type { Subscription, User } from '@prisma/client';
import { OVERAGE, PLANS, TRIAL_DAYS, convertFromXAF, responseOverageFCFA } from '@surveyflow/shared';
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
  return {
    user: userDto(ctx.user),
    subscription: subscriptionDto(ctx.subscription),
    plan: { key: plan.key, priceFCFA: plan.priceFCFA, limits: plan.limits, features: plan.features },
    usage: {
      activeSurveys: usage.activeSurveys,
      responses: usage.responses,
      messages: usage.messages,
      periodStart: usage.periodStart,
      periodEnd: usage.periodEnd,
      responseOverageFCFA: responseOverageFCFA(plan.key, usage.responses),
      /** The same overage in the owner's billing currency (live rate). `overageCurrency` says which. */
      responseOverage: convertFromXAF(responseOverageFCFA(plan.key, usage.responses), quote),
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
    trialDays: TRIAL_DAYS,
    plans: PLANS,
  };
}
