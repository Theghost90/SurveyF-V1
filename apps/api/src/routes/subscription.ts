import type { FastifyInstance } from 'fastify';
import { rl } from '../lib/ratelimit';
import { PAID_PLAN_KEYS, PLANS, PLAN_PRICES, currencyForCountry, type Currency, type PaidPlanKey } from '@surveyflow/shared';
import { conflict } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { accountSummary } from '../services/account';
import { initiatePayment, txDto } from '../services/payments/service';
import { initiateSchema } from './payments';

const rank: Record<string, number> = { trial: 0, starter: 1, growth: 2, business: 3 };

export default async function subscriptionRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  /** Subscription page data: current plan, usage vs limits, prices in the owner's currency, invoice history. */
  app.get('/api/subscription', auth, async (req) => {
    const summary = await accountSummary(req.userId);
    const currency = (summary.user.preferredCurrency || currencyForCountry(summary.user.country)) as Currency;
    const invoices = await prisma.paymentTransaction.findMany({ where: { userId: req.userId, status: 'success' }, orderBy: { paidAt: 'desc' }, take: 24 });
    return {
      ...summary,
      currency,
      prices: Object.fromEntries(PAID_PLAN_KEYS.map((p) => [p, { monthly: PLAN_PRICES[p][currency] ?? PLAN_PRICES[p].USD, annual: (PLAN_PRICES[p][currency] ?? PLAN_PRICES[p].USD!) * 10, currency: PLAN_PRICES[p][currency] ? currency : 'USD' }])),
      invoices: invoices.map(txDto),
    };
  });

  /**
   * PUT /api/subscription/upgrade — thin wrapper over payment initiation that also refuses downgrades
   * (V1 does not prorate or refund; a lower plan is chosen by cancelling and re-subscribing after the period ends).
   */
  app.put('/api/subscription/upgrade', { ...auth, ...rl(20) }, async (req) => {
    const body = initiateSchema.parse(req.body);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: req.userId } });
    const paidAndActive = sub.amountFCFA > 0 && ['active', 'past_due'].includes(sub.status);
    if (paidAndActive && rank[body.plan]! < rank[sub.plan]!) {
      throw conflict('downgrade_not_supported', 'To move to a lower plan, cancel at period end and subscribe again afterwards.');
    }
    return txDto(await initiatePayment(req.userId, body as { plan: PaidPlanKey; interval: 'monthly' | 'annual'; method: 'mobile_money' | 'card' | 'bank_transfer'; phone?: string }));
  });

  app.post('/api/subscription/cancel', auth, async (req) => {
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: req.userId } });
    if (sub.amountFCFA === 0) throw conflict('nothing_to_cancel', 'You are not on a paid plan');
    await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
    return accountSummary(req.userId);
  });

  app.post('/api/subscription/reactivate', auth, async (req) => {
    await prisma.subscription.update({ where: { userId: req.userId }, data: { cancelAtPeriodEnd: false } });
    return accountSummary(req.userId);
  });

  app.get('/api/plans', async () => ({
    plans: Object.fromEntries((['trial', ...PAID_PLAN_KEYS] as const).map((k) => [k, { priceFCFA: PLANS[k].priceFCFA, limits: PLANS[k].limits, features: PLANS[k].features }])),
    prices: PLAN_PRICES,
  }));
}
