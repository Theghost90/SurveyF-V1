import { PLANS, getPlan, type PlanDef, type PlanFeatures, type PlanKey } from '@surveyflow/shared';
import type { Subscription, User } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { paymentRequired, notFound } from '../../lib/errors';

/**
 * Plan enforcement. The spec says "return 402 when over limit at middleware level",
 * but two of the three limits cannot be enforced by rejecting an HTTP request:
 *   - responses arrive via the WhatsApp webhook (there is no client to answer 402 to,
 *     and dropping a participant's answers mid-survey would be hostile), so responses
 *     are NEVER blocked — they accrue overage (500 FCFA / 100) as the pricing says.
 *   - messages are enforced where they cost money: when a send is requested.
 * Active surveys are enforced when a survey is published/resumed.
 */

export interface UsageSnapshot {
  activeSurveys: number;
  responses: number;
  messages: number;
  /** Different people ever sent a survey. Only counted for a plan that caps it (Explore); 0 otherwise. */
  recipients: number;
  periodStart: Date;
  periodEnd: Date;
}

export interface AccountContext {
  user: User;
  subscription: Subscription;
  plan: PlanDef;
  usage: UsageSnapshot;
}

export function nextPlan(plan: PlanKey): PlanKey | null {
  if (plan === 'trial') return 'starter';
  if (plan === 'starter') return 'growth';
  if (plan === 'growth') return 'business';
  return null;
}

/** Different people this owner has ever invited, across all surveys. */
export async function countRecipients(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(DISTINCT r."contactId")::bigint AS n FROM "SurveyRecipient" r JOIN "Survey" s ON s."id" = r."surveyId" WHERE s."userId" = ${userId}`;
  return Number(rows[0]?.n ?? 0);
}

export async function computeUsage(userId: string, periodStart: Date, periodEnd: Date, capsRecipients = false): Promise<UsageSnapshot> {
  const [activeSurveys, responses, messages, recipients] = await Promise.all([
    prisma.survey.count({ where: { userId, status: 'active' } }),
    prisma.surveyRecipient.count({ where: { status: 'completed', completedAt: { gte: periodStart, lt: periodEnd }, survey: { userId } } }),
    prisma.messageLog.count({ where: { userId, createdAt: { gte: periodStart, lt: periodEnd } } }),
    capsRecipients ? countRecipients(userId) : Promise.resolve(0),
  ]);
  return { activeSurveys, responses, messages, recipients, periodStart, periodEnd };
}

export async function loadAccount(userId: string): Promise<AccountContext> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { subscription: true } });
  if (!user || !user.subscription) throw notFound('Account');
  const { subscription, ...rest } = user;
  return {
    user: rest as User,
    subscription,
    plan: getPlan(user.plan),
    usage: await computeUsage(userId, subscription.currentPeriodStart, subscription.currentPeriodEnd, getPlan(user.plan).limits.recipients !== null),
  };
}

function upgradeHint(plan: PlanKey) {
  const rec = nextPlan(plan);
  return rec ? { recommendedPlan: rec, priceFCFA: PLANS[rec].priceFCFA } : null;
}

/** A suspended account is read-only: it can look at and export data but cannot publish or send. */
export function assertNotSuspended(ctx: AccountContext) {
  if (ctx.subscription.status === 'suspended') {
    throw paymentRequired('subscription_suspended', 'Your subscription is suspended. Renew to publish or send surveys.', { upgrade: upgradeHint(ctx.plan.key) });
  }
}

export function assertCanActivateSurvey(ctx: AccountContext) {
  assertNotSuspended(ctx);
  const max = ctx.plan.limits.activeSurveys;
  if (max !== null && ctx.usage.activeSurveys >= max) {
    throw paymentRequired('plan_limit', `Your ${ctx.plan.key} plan allows ${max} active survey${max === 1 ? '' : 's'}.`, {
      limit: 'activeSurveys', max, current: ctx.usage.activeSurveys, upgrade: upgradeHint(ctx.plan.key),
    });
  }
}

export function messagesRemaining(ctx: AccountContext): number {
  return Math.max(0, ctx.plan.limits.messagesPerMonth - ctx.usage.messages);
}

/** `count` = business-initiated messages this action will queue. */
export function assertCanSendMessages(ctx: AccountContext, count: number) {
  assertNotSuspended(ctx);
  const remaining = messagesRemaining(ctx);
  if (count > remaining) {
    throw paymentRequired('plan_limit', `This send needs ${count} messages but only ${remaining} remain in your plan this period.`, {
      limit: 'messagesPerMonth', max: ctx.plan.limits.messagesPerMonth, current: ctx.usage.messages, remaining, requested: count, upgrade: upgradeHint(ctx.plan.key),
    });
  }
}

/**
 * Explore reaches a fixed number of different people, for the life of the account. `contactIds` are the people this send would invite;
 * those already invited before (in any survey) cost nothing new. Over the cap → 402 with the plan to activate.
 */
export async function freshRecipientCount(userId: string, contactIds: string[]): Promise<number> {
  if (!contactIds.length) return 0;
  const known = new Set((await prisma.surveyRecipient.findMany({ where: { survey: { userId }, contactId: { in: contactIds } }, select: { contactId: true }, distinct: ['contactId'] })).map((r) => r.contactId));
  return contactIds.filter((id) => !known.has(id)).length;
}

export async function assertCanAddRecipients(ctx: AccountContext, contactIds: string[]) {
  const cap = ctx.plan.limits.recipients;
  if (cap === null || !contactIds.length) return;
  const fresh = await freshRecipientCount(ctx.user.id, contactIds);
  const remaining = Math.max(0, cap - ctx.usage.recipients);
  if (fresh > remaining) {
    throw paymentRequired('plan_limit', remaining
      ? `Explore lets you reach ${cap} people for free and ${remaining} are left. Activate a plan to send to everyone.`
      : `You have reached the ${cap} people Explore includes. Activate a plan to send to everyone.`, {
      limit: 'recipients', max: cap, current: ctx.usage.recipients, remaining, requested: fresh, upgrade: upgradeHint(ctx.plan.key),
    });
  }
}

/** People Explore can still reach (null = the plan has no such cap). */
export const recipientsRemaining = (ctx: AccountContext): number | null => (ctx.plan.limits.recipients === null ? null : Math.max(0, ctx.plan.limits.recipients - ctx.usage.recipients));

export function assertFeature(ctx: AccountContext, feature: keyof PlanFeatures, label: string) {
  if (!ctx.plan.features[feature]) {
    const rec = (['starter', 'growth', 'business'] as const).find((p) => PLANS[p].features[feature]) ?? 'growth';
    throw paymentRequired('plan_feature', `${label} is not included in your ${ctx.plan.key} plan.`, {
      feature, upgrade: { recommendedPlan: rec, priceFCFA: PLANS[rec].priceFCFA },
    });
  }
}
