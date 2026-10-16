import { env } from '../../../config/env';
import { hmacHex, safeEqual } from '../../../lib/crypto';
import { prisma } from '../../../lib/prisma';
import { redis } from '../../../lib/redis';
import { PspError, pspFetch, type InitiateParams, type PSPAdapter, type ParsedWebhook, type VerifyResult, type WebhookInput } from '../types';

/**
 * CamerPay (camerpay.biz): Orange Money / MTN MoMo, Visa / Mastercard / Amex, PayPal, Apple Pay, Google Pay, hosted checkout.
 * Docs: https://camerpay.biz/docs/ (webhooks: https://camerpay.biz/docs/webhooks). Fees: docs/DECISIONS.md §3.3 and shared/psp-fees.ts.
 *
 * Written from the public documentation pages and an SDK that could be read from the sandbox's search tool only; the hosts themselves
 * were not reachable, and nothing was sent to CamerPay. What is documented and followed:
 *  - POST {base}/api/payment/initiate, `Authorization: Bearer <key>`, fields payment_method, amount, currency, customer phone,
 *    invoice_id, merchant_callback_url, merchant_return_url; the answer carries a transaction uuid and a payment page URL;
 *  - webhooks: POST (form-encoded) to merchant_callback_url on every state change, header `X-CamerPay-Signature` = hex HMAC-SHA256,
 *    keyed with the dashboard's callback secret, over the STRING  uuid|invoice_id|status|amount  (amount with two decimals) —
 *    NOT over the raw body; statuses completed / failed / refunded.
 * What is NOT known and therefore not guessed:
 *  - a server-side "get transaction" endpoint. The settlement outcome therefore comes from the signed webhook itself: parseWebhook
 *    verifies the HMAC, stores the signed outcome, and verifyPayment hands it to the common settle path (which still checks the amount).
 *    If a webhook is lost the payment cannot be settled by polling (there is nothing to ask): re-send it from the CamerPay dashboard (replays keep
 *    their Idempotency-Key, and our settlement is idempotent anyway). A payment that expired meanwhile is still credited when the webhook finally
 *    arrives (late success), and the reconciliation job re-reads the stored outcome for seven days;
 *  - the exact `payment_method` value per mobile-money operator: it is left out so the hosted page lets the payer pick Orange or MTN;
 *    cards send `card`;
 *  - the currency is not part of the signed string: it is the currency we asked for, and the signed amount must cover what we asked.
 * Confirm field names against the dashboard / support before go-live: the pages disagree on `merchant_callback_url` vs `callback_url`.
 */
const base = () => env.CAMERPAY_BASE_URL.replace(/\/$/, '');
export const camerpayOutcomeKey = (reference: string) => `sf:camerpay:outcome:${reference}`;

const money2 = (v: string | number) => Number(v).toFixed(2);

/** The exact string CamerPay signs. */
export const camerpaySignedString = (p: { uuid: string; invoice_id: string; status: string; amount: string | number }) =>
  `${p.uuid}|${p.invoice_id}|${p.status}|${money2(p.amount)}`;

export class CamerPayAdapter implements PSPAdapter {
  readonly name = 'camerpay' as const;
  isConfigured = () => !!env.CAMERPAY_API_KEY && !!env.CAMERPAY_WEBHOOK_SECRET;

  async initiatePayment(p: InitiateParams) {
    const r = await pspFetch<Record<string, any>>(this.name, `${base()}/api/payment/initiate`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.CAMERPAY_API_KEY}` },
      json: {
        ...(p.method === 'card' ? { payment_method: 'card' } : {}),
        amount: p.amount, currency: p.currency, invoice_id: p.reference, description: p.description,
        customer_name: p.customerName, customer_email: p.customerEmail, customer_phone: p.customerPhone,
        merchant_callback_url: p.notifyUrl, merchant_return_url: p.returnUrl,
      },
    });
    const d = r?.data ?? r;
    const url: string | undefined = d.pay_url ?? d.payment_url ?? d.payment_page_url ?? d.checkout_url ?? d.url;
    const uuid: string | undefined = d.uuid ?? d.transaction_id ?? d.id ?? d.transaction?.uuid;
    if (!url) throw new PspError('camerpay did not return a payment page URL', this.name);
    return { checkoutUrl: url, pspReference: uuid };
  }

  /** The signed outcome parseWebhook stored; pending until a valid webhook has arrived. */
  async verifyPayment({ reference }: { reference: string; pspReference?: string | null }): Promise<VerifyResult> {
    const raw = await redis.get(camerpayOutcomeKey(reference));
    if (!raw) return { status: 'pending', amount: 0, currency: '' };
    const o = JSON.parse(raw) as { status: string; amount: number; uuid: string };
    const tx = await prisma.paymentTransaction.findUnique({ where: { reference }, select: { currency: true } });
    const s = o.status.toLowerCase();
    return { status: s === 'completed' ? 'success' : s === 'failed' ? 'failed' : 'pending', amount: o.amount, currency: tx?.currency ?? '', pspReference: o.uuid };
  }

  async parseWebhook({ headers, body }: WebhookInput): Promise<ParsedWebhook> {
    const b = (body ?? {}) as Record<string, string | undefined>;
    const given = String(headers['x-camerpay-signature'] ?? b.signature ?? '').trim().toLowerCase();
    const complete = !!(b.uuid && b.invoice_id && b.status && b.amount !== undefined && b.amount !== '');
    const ok = !!env.CAMERPAY_WEBHOOK_SECRET && complete && !!given
      && safeEqual(given, hmacHex(env.CAMERPAY_WEBHOOK_SECRET, camerpaySignedString({ uuid: b.uuid!, invoice_id: b.invoice_id!, status: b.status!, amount: b.amount! })));
    if (ok) {
      await redis.set(camerpayOutcomeKey(b.invoice_id!), JSON.stringify({ status: b.status, amount: Number(b.amount), uuid: b.uuid }), 'EX', 7 * 86_400);
    }
    return { reference: b.invoice_id, pspReference: b.uuid, signatureValid: ok };
  }
}
