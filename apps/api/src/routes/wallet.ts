import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WALLET_TOPUP_MAX_FCFA, WALLET_TOPUP_MIN_FCFA, WALLET_TOPUP_PRESETS } from '@surveyflow/shared';
import { rl } from '../lib/ratelimit';
import { assertFeature, assertNotSuspended, loadAccount } from '../services/subscription/limits';
import { initiateGiftTopup, txDto } from '../services/payments/service';
import { getWalletSummary } from '../services/wallet';

/** The owner's prepaid gift wallet. The survey owner — not SurveyFlow — pays for participant gifts. */
export default async function walletRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  app.get('/api/wallet', auth, async (req) => ({
    ...(await getWalletSummary(req.userId)),
    currency: 'FCFA',
    topup: { min: WALLET_TOPUP_MIN_FCFA, max: WALLET_TOPUP_MAX_FCFA, presets: WALLET_TOPUP_PRESETS },
  }));

  /**
   * Starts a top-up checkout through the same PSP layer as subscriptions (failover, verify-before-credit, idempotent
   * settlement). The balance is only credited after the PSP confirms the money — never on the redirect.
   */
  app.post('/api/wallet/topup', { ...auth, ...rl(20) }, async (req, reply) => {
    const body = z.object({
      amountFCFA: z.number().int().min(WALLET_TOPUP_MIN_FCFA).max(WALLET_TOPUP_MAX_FCFA),
      method: z.enum(['mobile_money', 'card', 'bank_transfer']),
      phone: z.string().trim().max(30).optional(),
    }).parse(req.body);
    const ctx = await loadAccount(req.userId);
    assertNotSuspended(ctx);
    // A plan without gift automation can never spend the balance, and V1 has no payout-back path: don't take the money.
    assertFeature(ctx, 'giftAutomation', 'Gift automation');
    const tx = await initiateGiftTopup(req.userId, body);
    reply.code(201);
    return txDto(tx);
  });
}
