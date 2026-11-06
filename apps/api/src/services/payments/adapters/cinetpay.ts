import { env } from '../../../config/env';
import { PspError, pspFetch, type InitiateParams, type PSPAdapter, type ParsedWebhook, type VerifyResult, type WebhookInput } from '../types';

/**
 * CinetPay Checkout v2. Amounts must be multiples of 5; transaction ids must avoid special characters.
 * The notification is only a trigger: CinetPay's own guidance is to call the check endpoint, which is exactly
 * what verifyPayment() does — so the x-token HMAC is not needed to be safe (nothing is trusted from the body).
 */
const BASE = 'https://api-checkout.cinetpay.com/v2';

export class CinetPayAdapter implements PSPAdapter {
  readonly name = 'cinetpay' as const;
  isConfigured = () => !!(env.CINETPAY_API_KEY && env.CINETPAY_SITE_ID);

  async initiatePayment(p: InitiateParams) {
    if (p.amount % 5 !== 0) throw new PspError('CinetPay amounts must be multiples of 5', this.name, true);
    const [first, ...rest] = p.customerName.split(' ');
    const r = await pspFetch<{ code?: string; message?: string; data?: { payment_url?: string; payment_token?: string } }>(this.name, `${BASE}/payment`, {
      method: 'POST',
      json: {
        apikey: env.CINETPAY_API_KEY, site_id: env.CINETPAY_SITE_ID, transaction_id: p.reference, amount: p.amount, currency: p.currency,
        description: p.description, notify_url: p.notifyUrl, return_url: p.returnUrl, channels: p.method === 'card' ? 'CREDIT_CARD' : 'MOBILE_MONEY',
        customer_name: first, customer_surname: rest.join(' ') || first, customer_email: p.customerEmail, customer_phone_number: `+${p.customerPhone}`,
        customer_address: 'N/A', customer_city: 'N/A', customer_country: 'CM', customer_state: 'CM', customer_zip_code: '00000', lang: 'fr',
      },
    });
    if (r.code !== '201' || !r.data?.payment_url) throw new PspError(`cinetpay: ${r.message ?? 'no payment_url'}`, this.name);
    return { checkoutUrl: r.data.payment_url, pspReference: r.data.payment_token };
  }

  async verifyPayment({ reference }: { reference: string }): Promise<VerifyResult> {
    const r = await pspFetch<{ code?: string; data?: { status?: string; amount?: string | number; currency?: string; payment_method?: string } }>(this.name, `${BASE}/payment/check`, {
      method: 'POST', json: { apikey: env.CINETPAY_API_KEY, site_id: env.CINETPAY_SITE_ID, transaction_id: reference },
    });
    const d = r.data;
    if (!d) return { status: 'pending', amount: 0, currency: '' };
    const s = (d.status ?? '').toUpperCase();
    return { status: s === 'ACCEPTED' ? 'success' : s === 'REFUSED' ? 'failed' : 'pending', amount: Number(d.amount ?? 0), currency: d.currency ?? '' };
  }

  async parseWebhook({ body, query }: WebhookInput): Promise<ParsedWebhook> {
    const reference = body?.cpm_trans_id ?? query?.cpm_trans_id;
    return { reference, signatureValid: true }; // authenticity comes from verifyPayment(), see header comment
  }
}
