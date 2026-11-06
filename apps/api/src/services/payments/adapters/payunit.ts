import { env } from '../../../config/env';
import { PspError, pspFetch, type InitiateParams, type PSPAdapter, type ParsedWebhook, type VerifyResult, type WebhookInput } from '../types';

/**
 * PayUnit (Cameroon: MTN/Orange MoMo, cards, PayPal, Express Union).
 * LOWEST-CONFIDENCE adapter: auth scheme (x-api-key + Basic apiUsername:apiPassword + `mode` header) is known from
 * their SDKs, but the endpoint paths and response shapes below are from memory and could not be checked offline.
 * Verify with PayUnit's sandbox before enabling. It is last in the Cameroon failover chain for that reason.
 */
const BASE = 'https://gateway.payunit.net/api/gateway';

export class PayUnitAdapter implements PSPAdapter {
  readonly name = 'payunit' as const;
  isConfigured = () => !!(env.PAYUNIT_API_KEY && env.PAYUNIT_API_USERNAME && env.PAYUNIT_API_PASSWORD);
  private headers = () => ({
    'x-api-key': env.PAYUNIT_API_KEY!,
    mode: env.PAYUNIT_MODE,
    Authorization: 'Basic ' + Buffer.from(`${env.PAYUNIT_API_USERNAME}:${env.PAYUNIT_API_PASSWORD}`).toString('base64'),
  });

  async initiatePayment(p: InitiateParams) {
    const r = await pspFetch<{ body?: { transaction_url?: string; transaction_id?: string }; message?: string }>(this.name, `${BASE}/initialize`, {
      method: 'POST', headers: this.headers(),
      json: { total_amount: p.amount, currency: p.currency, transaction_id: p.reference, return_url: p.returnUrl, notify_url: p.notifyUrl, description: p.description, name: p.customerName, email: p.customerEmail, phone_number: p.customerPhone },
    });
    const url = r.body?.transaction_url;
    if (!url) throw new PspError(`payunit: ${r.message ?? 'no transaction_url'}`, this.name);
    return { checkoutUrl: url, pspReference: r.body?.transaction_id };
  }

  async verifyPayment({ reference }: { reference: string }): Promise<VerifyResult> {
    const r = await pspFetch<{ body?: { transaction_status?: string; transaction_amount?: number | string; transaction_currency?: string } }>(
      this.name, `${BASE}/gettransactionstatus/${encodeURIComponent(reference)}`, { headers: this.headers() },
    );
    const b = r.body;
    if (!b) return { status: 'pending', amount: 0, currency: '' };
    const s = (b.transaction_status ?? '').toUpperCase();
    return { status: ['SUCCESS', 'SUCCESSFUL', 'COMPLETED'].includes(s) ? 'success' : ['FAILED', 'CANCELLED', 'CANCELED'].includes(s) ? 'failed' : 'pending', amount: Number(b.transaction_amount ?? 0), currency: b.transaction_currency ?? 'XAF' };
  }

  async parseWebhook({ body, query }: WebhookInput): Promise<ParsedWebhook> {
    return { reference: body?.transaction_id ?? query?.transaction_id, signatureValid: true }; // authenticity via verifyPayment()
  }
}
