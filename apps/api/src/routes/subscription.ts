import type { FastifyInstance } from 'fastify';
import { rl } from '../lib/ratelimit';
import { ANNUAL_MONTHS_CHARGED, OVERAGE, PAID_PLAN_KEYS, PLANS, convertFromXAF, identityQuote, overagePerBlock, planPrices, prorationCreditFCFA, replacesCurrentPeriod, type PaidPlanKey } from '@surveyflow/shared';
import { env } from '../config/env';
import { conflict } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { accountSummary } from '../services/account';
import { billingQuote, methodsFor } from '../services/billing-currency';
import { PLAN_RANK, initiatePayment, txDto } from '../services/payments/service';
import { initiateSchema } from './payments';


export default async function subscriptionRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  /** Subscription page data: current plan, usage vs limits, prices in the owner's currency, invoice history. */
  app.get('/api/subscription', auth, async (req) => {
    const summary = await accountSummary(req.userId);
    const { quote, fallback, requested } = await billingQuote(summary.user);
    const prices = planPrices(quote);
    const invoices = await prisma.paymentTransaction.findMany({ where: { userId: req.userId, status: 'success', purpose: 'subscription' }, orderBy: { paidAt: 'desc' }, take: 24 });
    // PAY-12: what moving to each plan would take off today, in the owner's currency (0 when nothing is replaced: the free plan, a renewal, a lapsed plan).
    const sub = await prisma.subscription.findUnique({ where: { userId: req.userId } });
    const now = new Date();
    const upgradeCredit = Object.fromEntries(PAID_PLAN_KEYS.map((p) => [p, Object.fromEntries((['monthly', 'annual'] as const).map((i) => {
      const fcfa = env.PRORATION_ENABLED && sub && PLAN_RANK[p]! > PLAN_RANK[sub.plan]! && replacesCurrentPeriod({ plan: sub.plan, status: sub.status, periodEnd: sub.currentPeriodEnd, paidFCFA: sub.amountFCFA }, p, now)
        ? prorationCreditFCFA({ paidFCFA: sub.amountFCFA, periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd, now, newPriceFCFA: PLANS[p].priceFCFA * (i === 'annual' ? ANNUAL_MONTHS_CHARGED : 1) })
        : 0;
      return [i, fcfa ? convertFromXAF(fcfa, quote) : 0];
    }))]));
    return {
      ...summary,
      upgradeCredit,
      /** What this owner is charged in: their currency at the live rate (CFA francs when no fresh rate exists: `fallback`). */
      currency: quote.currency,
      requestedCurrency: requested,
      fallback,
      quote: { rate: quote.rate, asOf: quote.asOf, source: quote.source },
      methods: methodsFor(quote.currency),
      overagePer100: overagePerBlock(quote),
      overageBlock: OVERAGE.responsesBlockSize,
      prices: Object.fromEntries(PAID_PLAN_KEYS.map((p) => [p, { ...prices[p], currency: quote.currency }])),
      invoices: invoices.map(txDto),
    };
  });

  /**
   * PUT /api/subscription/upgrade — thin wrapper over payment initiation that also refuses downgrades
   * (V1 does not prorate or refund; a lower plan is chosen by cancelling and re-subscribing after the period ends).
   */
  app.put('/api/subscription/upgrade', { preHandler: app.authenticateVerified, ...rl(20) }, async (req) => {
    const body = initiateSchema.parse(req.body);
    // The downgrade guard is inside initiatePayment, so POST /api/payments/initiate cannot bypass it.
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
    prices: planPrices(identityQuote()), // canonical FCFA prices; GET /api/pricing and GET /api/subscription give the visitor's / owner's currency
  }));
}
