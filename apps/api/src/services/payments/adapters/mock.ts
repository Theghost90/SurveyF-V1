import { env } from '../../../config/env';
import { redis } from '../../../lib/redis';
import { prisma } from '../../../lib/prisma';
import type { InitiateParams, PSPAdapter, ParsedWebhook, VerifyResult } from '../types';

/**
 * Demo PSP: the checkout page at /billing/mock-checkout lets you "pay" or "fail" a payment without any PSP account.
 * Only registered when PSP_MOCK=true (refused at boot in production). It goes through the SAME settle path as real
 * PSPs, so amount verification and idempotency are exercised for real.
 */
export const mockOutcomeKey = (reference: string) => `sf:mockpay:${reference}`;

export class MockPspAdapter implements PSPAdapter {
  readonly name = 'mock' as const;
  isConfigured = () => env.PSP_MOCK && !env.isProd;

  async initiatePayment(p: InitiateParams) {
    const web = env.webOrigins[0] ?? 'http://localhost:4222';
    return { checkoutUrl: `${web}/billing/mock-checkout?ref=${encodeURIComponent(p.reference)}`, pspReference: `mock-${p.reference}` };
  }

  async verifyPayment({ reference }: { reference: string }): Promise<VerifyResult> {
    const tx = await prisma.paymentTransaction.findUnique({ where: { reference } });
    const outcome = await redis.get(mockOutcomeKey(reference));
    if (!tx || !outcome) return { status: 'pending', amount: 0, currency: '' };
    return { status: outcome === 'success' ? 'success' : 'failed', amount: tx.amount, currency: tx.currency, pspReference: `mock-${reference}` };
  }

  async parseWebhook(): Promise<ParsedWebhook> {
    return { signatureValid: false }; // the mock PSP has no webhook; the checkout page settles through an authenticated route
  }
}
