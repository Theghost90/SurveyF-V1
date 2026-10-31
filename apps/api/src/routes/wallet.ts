import type { FastifyInstance } from 'fastify';
import { assertWhatsAppConnected } from '../services/whatsapp/require';
import { z } from 'zod';
import { rl } from '../lib/ratelimit';
import { assertFeature, assertNotSuspended, loadAccount } from '../services/subscription/limits';
import { initiateGiftTopup, txDto } from '../services/payments/service';
import { methodsFor } from '../services/billing-currency';
import { getWalletSummary } from '../services/wallet';

/** The owner's prepaid gift wallet. The survey owner — not SurveyFlow — pays for participant gifts. */
export default async function walletRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  app.get('/api/wallet', auth, async (req) => {
    const summary = await getWalletSummary(req.userId);
    return { ...summary, methods: methodsFor(summary.currency) };
  });

  /**
   * Starts a top-up checkout through the same PSP layer as subscriptions (failover, verify-before-credit, idempotent
   * settlement). The balance is only credited after the PSP confirms the money — never on the redirect.
   */
  app.post('/api/wallet/topup', { preHandler: app.authenticateVerified, ...rl(20) }, async (req, reply) => {
    const body = z.object({
      /** Whole units of the wallet's currency; the allowed range depends on the currency and is checked against the live limits. */
      amount: z.number().int().min(1),
      method: z.enum(['mobile_money', 'card', 'bank_transfer']),
      phone: z.string().trim().max(30).optional(),
    }).parse(req.body);
    await assertWhatsAppConnected(req.userId);
    const ctx = await loadAccount(req.userId);
    assertNotSuspended(ctx);
    // A plan without gift automation can never spend the balance, and V1 has no payout-back path: don't take the money.
    assertFeature(ctx, 'giftAutomation', 'Gift automation');
    const tx = await initiateGiftTopup(req.userId, body);
    reply.code(201);
    return txDto(tx);
  });
}
