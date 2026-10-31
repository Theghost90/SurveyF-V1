import { prisma } from '../lib/prisma';

/**
 * Funnel milestones, recorded the FIRST time each happens for an owner. They exist so that the first weeks of real sign-ups say where
 * people stop, instead of guessing (is it Meta setup? the 5-person wall? the price?). Best effort: a failure here must never fail the action.
 *
 *   signup → onboarding_done → whatsapp_connected → survey_created → first_send → first_response → paywall_view → checkout_start → paid
 */
export const FUNNEL_EVENTS = ['signup', 'onboarding_done', 'whatsapp_connected', 'survey_created', 'first_send', 'first_response', 'paywall_view', 'checkout_start', 'paid'] as const;
export type FunnelEventName = (typeof FUNNEL_EVENTS)[number];

export async function track(userId: string, name: FunnelEventName, meta?: Record<string, unknown>): Promise<void> {
  try {
    await prisma.funnelEvent.createMany({ data: [{ userId, name, meta: (meta ?? undefined) as never }], skipDuplicates: true });
  } catch {
    /* analytics must never break the product */
  }
}
