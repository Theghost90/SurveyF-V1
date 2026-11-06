import { env } from '../../../config/env';
import { hmacHex, safeEqual } from '../../../lib/crypto';
import { PspError, pspFetch, type InitiateParams, type PSPAdapter, type ParsedWebhook, type VerifyResult, type WebhookInput } from '../types';

/**
 * Notch Pay. POST /payments → authorization_url; GET /payments/{reference} → transaction.status.
 * UNVERIFIED against a live sandbox from this environment: the webhook signature scheme (HMAC-SHA256 of the raw
 * body with your webhook hash, header `x-notch-signature`) comes from secondary sources — if it does not match,
 * webhooks are rejected (safe) and the status poll in GET /api/payments/:id still activates paid subscriptions.
 */
const BASE = 'https://api.notchpay.co';

export class NotchPayAdapter implements PSPAdapter {
  readonly name = 'notchpay' as const;
  isConfigured = () => !!env.NOTCHPAY_API_KEY;
  private headers = () => ({ Authorization: env.NOTCHPAY_API_KEY!, Accept: 'application/json' });

  async initiatePayment(p: InitiateParams) {
    const r = await pspFetch<{ authorization_url?: string; transaction?: { reference?: string } }>(this.name, `${BASE}/payments`, {
      method: 'POST', headers: this.headers(),
      json: {
        amount: p.amount, currency: p.currency, email: p.customerEmail, phone: `+${p.customerPhone}`, name: p.customerName,
        reference: p.reference, callback: `${p.returnUrl}`, description: p.description,
      },
    });
    if (!r.authorization_url) throw new PspError('notchpay did not return an authorization_url', this.name);
    return { checkoutUrl: r.authorization_url, pspReference: r.transaction?.reference };
  }

  async verifyPayment({ reference, pspReference }: { reference: string; pspReference?: string | null }): Promise<VerifyResult> {
    // Notch Pay wants ITS reference here, not the merchant reference.
    const r = await pspFetch<{ transaction?: { status?: string; amount?: number; currency?: string; reference?: string } }>(
      this.name, `${BASE}/payments/${encodeURIComponent(pspReference || reference)}`, { headers: this.headers() },
    );
    const t = r.transaction;
    if (!t) return { status: 'pending', amount: 0, currency: '' };
    const s = (t.status ?? '').toLowerCase();
    return { status: s === 'complete' ? 'success' : ['failed', 'canceled', 'cancelled', 'expired', 'rejected'].includes(s) ? 'failed' : 'pending', amount: t.amount ?? 0, currency: t.currency ?? '', pspReference: t.reference };
  }

  async parseWebhook({ rawBody, headers, body }: WebhookInput): Promise<ParsedWebhook> {
    const given = String(headers['x-notch-signature'] ?? headers['x-notchpay-signature'] ?? '');
    const ok = !!env.NOTCHPAY_WEBHOOK_HASH && !!given && safeEqual(given, hmacHex(env.NOTCHPAY_WEBHOOK_HASH, rawBody));
    const tx = body?.data?.transaction ?? body?.data ?? {};
    return { reference: tx.merchant_reference ?? body?.data?.merchant_reference ?? tx.reference, pspReference: tx.reference, signatureValid: ok };
  }
}
