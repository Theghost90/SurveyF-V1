'use client';
import useSWR from 'swr';

export interface Account {
  user: { id: string; email: string; name: string; businessName: string; phone: string; plan: string; country: string; locale: string; preferredCurrency: string; segment: string | null; trialEndsAt: string | null; onboardingDoneAt: string | null };
  subscription: { status: string; plan: string; daysLeft: number; currentPeriodEnd: string; currentPeriodStart: string; amountFCFA: number; graceEndsAt: string | null; cancelAtPeriodEnd: boolean; interval: string; paymentMethod: string | null; pspProvider: string | null };
  plan: { key: string; priceFCFA: number; limits: { activeSurveys: number | null; responsesPerMonth: number; messagesPerMonth: number; teamMembers: number }; features: Record<string, boolean> };
  usage: { activeSurveys: number; responses: number; messages: number; periodStart: string; periodEnd: string; responseOverageFCFA: number; /** the same, in the owner's billing currency */ responseOverage: number; overageCurrency: string };
  onboarding: { whatsappConnected: boolean; hasContacts: boolean; hasSurvey: boolean; paidPlan: boolean; segmentChosen: boolean; done: boolean };
}

export function useAccount() {
  const { data, error, mutate, isLoading } = useSWR<Account>('/auth/me', { refreshInterval: 60_000 });
  return { account: data, error, mutate, isLoading };
}
