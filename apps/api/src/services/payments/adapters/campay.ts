import { jwtVerify } from 'jose';
import { env } from '../../../config/env';
import { PspError, pspFetch, type InitiateParams, type PSPAdapter, type ParsedWebhook, type VerifyResult, type WebhookInput } from '../types';

/**
 * Campay (Cameroon MTN / Orange Mobile Money, no cards). `collect` pushes a USSD approval prompt to the payer's phone,
 * so there is no hosted checkout URL: the UI shows "approve on your phone" and polls.
 * UNVERIFIED against Campay's demo environment from here — check paths/fields in their sandbox before go-live.
 */
const base = () => (env.CAMPAY_ENV === 'prod' ? 'https://campay.net/api' : 'https://demo.campay.net/api');

export class CampayAdapter implements PSPAdapter {
  readonly name = 'campay' as const;
  /** `collect` makes Campay push the prompt to the phone by itself: an unconfirmed start must never be repeated at another provider. */
  readonly push = true;
  isConfigured = () => !!env.CAMPAY_API_KEY;
  private headers = () => ({ Authorization: `Token ${env.CAMPAY_API_KEY}` });

  async initiatePayment(p: InitiateParams) {
    if (p.method !== 'mobile_money') throw new PspError('Campay supports mobile money only', this.name, true);
    const r = await pspFetch<{ reference?: string; ussd_code?: string; operator?: string }>(this.name, `${base()}/collect/`, {
      method: 'POST', headers: this.headers(),
      json: { amount: String(p.amount), currency: p.currency, from: p.customerPhone, description: p.description, external_reference: p.reference },
    });
    // Campay answered 2xx but we cannot track the payment: the prompt may well be on the phone (ambiguous), and only its signed webhook can tell us.
    if (!r.reference) throw new PspError('campay did not return a reference', this.name, true, true);
    return { paymentToken: r.reference, pspReference: r.reference };
  }

  async verifyPayment({ reference, pspReference }: { reference: string; pspReference?: string | null }): Promise<VerifyResult> {
    if (!pspReference) return { status: 'pending', amount: 0, currency: '' };
    const r = await pspFetch<{ status?: string; amount?: number | string; currency?: string; external_reference?: string }>(this.name, `${base()}/transaction/${encodeURIComponent(pspReference)}/`, { headers: this.headers() });
    // The reference we hold may have come from a webhook rather than from our own start of the payment: it must be THIS payment's.
    if (r.external_reference && r.external_reference !== reference) throw new PspError(`campay transaction ${pspReference} belongs to another payment`, this.name, false);
    const s = (r.status ?? '').toUpperCase();
    return { status: s === 'SUCCESSFUL' ? 'success' : s === 'FAILED' ? 'failed' : 'pending', amount: Number(r.amount ?? 0), currency: r.currency ?? 'XAF', pspReference };
  }

  async parseWebhook({ query, body }: WebhookInput): Promise<ParsedWebhook> {
    const p = { ...(query ?? {}), ...(body ?? {}) } as Record<string, string | undefined>;
    let ok = false;
    if (env.CAMPAY_WEBHOOK_KEY && p.signature) {
      try {
        await jwtVerify(p.signature, new TextEncoder().encode(env.CAMPAY_WEBHOOK_KEY), { algorithms: ['HS256'] });
        ok = true;
      } catch { /* bad signature */ }
    }
    return { reference: p.external_reference, pspReference: p.reference, signatureValid: ok };
  }
}
