import type { PaymentMethod, PspName } from '@surveyflow/shared';

export interface InitiateParams {
  amount: number;
  currency: string;
  method: PaymentMethod;
  /** Our own unique id (alphanumeric only — CinetPay rejects `_`, `#`, `/`, `$`, `&`). */
  reference: string;
  customerName: string;
  customerEmail: string;
  /** E.164 digits without "+", e.g. 237677123456 */
  customerPhone: string;
  description: string;
  /** Browser lands here after paying. */
  returnUrl: string;
  /** Server-to-server notification URL. */
  notifyUrl: string;
}

export interface InitiateResult {
  /** Hosted checkout: redirect the browser here. */
  checkoutUrl?: string;
  /** Push-to-phone flows (Campay): nothing to redirect to, the payer approves on their handset. */
  paymentToken?: string;
  /** The PSP's own id for this payment, needed by some verify endpoints. */
  pspReference?: string;
}

export interface VerifyResult {
  status: 'success' | 'failed' | 'pending';
  amount: number;
  currency: string;
  pspReference?: string;
}

export interface ParsedWebhook {
  /** Our reference, if the payload carries it. */
  reference?: string;
  /** The PSP's reference, if the payload carries it. */
  pspReference?: string;
  /** False when the PSP signs webhooks and the signature did not match. */
  signatureValid: boolean;
}

export interface WebhookInput {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  body: any;
  query: Record<string, any>;
}

/**
 * Spec §9.3 PSPAdapter, with one deliberate change: parseWebhook() only extracts identifiers and checks the
 * signature. The spec lets the webhook body assert `status: 'success'`; here a webhook is just a "go look"
 * signal and the outcome ALWAYS comes from verifyPayment() (server-to-server, amount + currency checked).
 */
export interface PSPAdapter {
  readonly name: PspName;
  isConfigured(): boolean;
  initiatePayment(p: InitiateParams): Promise<InitiateResult>;
  verifyPayment(ref: { reference: string; pspReference?: string | null }): Promise<VerifyResult>;
  parseWebhook(input: WebhookInput): Promise<ParsedWebhook>;
}

export class PspError extends Error {
  constructor(message: string, public psp: PspName, /** true = safe to try the next PSP in the chain */ public retryable = true) {
    super(message);
  }
}

export async function pspFetch<T>(psp: PspName, url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers as Record<string, string>) },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new PspError(`${psp} unreachable: ${(err as Error).message}`, psp, true);
  }
  const text = await res.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new PspError(`${psp} HTTP ${res.status}: ${text.slice(0, 200)}`, psp, res.status >= 500 || res.status === 429);
  return data as T;
}
