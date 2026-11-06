import { env } from '../../../config/env';
import { safeEqual } from '../../../lib/crypto';
import { PspError, pspFetch, type InitiateParams, type PSPAdapter, type ParsedWebhook, type VerifyResult, type WebhookInput } from '../types';

/** Flutterwave v3 Standard (hosted checkout). Universal card fallback. */
const BASE = 'https://api.flutterwave.com/v3';

export class FlutterwaveAdapter implements PSPAdapter {
  readonly name = 'flutterwave' as const;
  isConfigured = () => !!env.FLUTTERWAVE_SECRET_KEY;
  private headers = () => ({ Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}` });

  async initiatePayment(p: InitiateParams) {
    const options =
      p.method === 'card' ? 'card'
      : p.currency === 'XAF' || p.currency === 'XOF' ? 'mobilemoneyfranco'
      : p.currency === 'GHS' ? 'mobilemoneyghana'
      : p.currency === 'KES' ? 'mpesa' : undefined;
    const r = await pspFetch<{ status: string; data?: { link?: string } }>(this.name, `${BASE}/payments`, {
      method: 'POST', headers: this.headers(),
      json: {
        tx_ref: p.reference, amount: p.amount, currency: p.currency, redirect_url: p.returnUrl,
        ...(options ? { payment_options: options } : {}),
        customer: { email: p.customerEmail, name: p.customerName, phonenumber: p.customerPhone },
        customizations: { title: 'SurveyFlow', description: p.description },
      },
    });
    if (r.status !== 'success' || !r.data?.link) throw new PspError('flutterwave did not return a payment link', this.name);
    return { checkoutUrl: r.data.link };
  }

  async verifyPayment({ reference }: { reference: string }): Promise<VerifyResult> {
    const r = await pspFetch<{ status: string; data?: { status?: string; amount?: number; currency?: string; id?: number } }>(
      this.name, `${BASE}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, { headers: this.headers() },
    );
    const d = r.data;
    if (r.status !== 'success' || !d) return { status: 'pending', amount: 0, currency: '' };
    const s = (d.status ?? '').toLowerCase();
    return { status: s === 'successful' ? 'success' : s === 'failed' || s === 'cancelled' ? 'failed' : 'pending', amount: d.amount ?? 0, currency: d.currency ?? '', pspReference: d.id ? String(d.id) : undefined };
  }

  async parseWebhook({ headers, body }: WebhookInput): Promise<ParsedWebhook> {
    // Flutterwave sends the secret hash you configured in the dashboard in the `verif-hash` header.
    const given = String(headers['verif-hash'] ?? '');
    const ok = !!env.FLUTTERWAVE_WEBHOOK_HASH && !!given && safeEqual(given, env.FLUTTERWAVE_WEBHOOK_HASH);
    return { reference: body?.data?.tx_ref ?? body?.txRef, pspReference: body?.data?.id ? String(body.data.id) : undefined, signatureValid: ok };
  }
}
