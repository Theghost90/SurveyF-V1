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
  /** True when starting a payment makes the PROVIDER push a prompt to the payer's phone by itself (Campay): then an unconfirmed start must never be repeated elsewhere. */
  push?: boolean;
  isConfigured(): boolean;
  initiatePayment(p: InitiateParams): Promise<InitiateResult>;
  verifyPayment(ref: { reference: string; pspReference?: string | null }): Promise<VerifyResult>;
  parseWebhook(input: WebhookInput): Promise<ParsedWebhook>;
}

export class PspError extends Error {
  constructor(
    message: string,
    public psp: PspName,
    /** true = safe to try the next PSP in the chain */
    public retryable = true,
    /**
     * true = the provider MAY have created the payment although we got an error (a timeout after the request left, a connection reset, a
     * gateway error). false = it certainly did not (connection refused, a 4xx rejection, a 429/503 "come back later").
     */
    public ambiguous = false,
  ) {
    super(message);
  }
}

/** Errors that happen before a single byte of the request could have left (no connection, no name, a refused TLS handshake): the provider cannot have seen it. */
const NEVER_SENT = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|ERR_TLS_|CERT_|DEPTH_ZERO|UNABLE_TO_)/;
const errorCode = (err: unknown): string => String((err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code ?? '');

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
    // Not connected at all → certainly not created. A timeout after sending, a reset, anything else → the provider MAY have created it.
    throw new PspError(`${psp} unreachable: ${(err as Error).message}`, psp, true, !NEVER_SENT.test(errorCode(err)));
  }
  const text = await res.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    // 4xx = rejected (nothing created); 429 and 503 = "come back later" (nothing created); 408, 500, 502, 504 = the request may have been processed.
    const comeBackLater = res.status === 429 || res.status === 503;
    throw new PspError(`${psp} HTTP ${res.status}: ${text.slice(0, 200)}`, psp, res.status >= 500 || res.status === 429 || res.status === 408, !comeBackLater && (res.status >= 500 || res.status === 408));
  }
  return data as T;
}
