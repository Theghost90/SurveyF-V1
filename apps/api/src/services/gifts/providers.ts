import { env } from '../../config/env';

/**
 * Money-moving providers. IMPORTANT behavioural contract:
 *  - throw GiftError(ambiguous=false) ONLY when the provider definitely did not pay;
 *  - throw GiftError(ambiguous=true) when we cannot know (timeout, connection reset after send).
 * Ambiguous failures are never retried automatically — a retry could pay a participant twice.
 */
export class GiftError extends Error {
  constructor(message: string, public ambiguous = false) {
    super(message);
  }
}

export interface GiftProvider {
  readonly name: string;
  /** phone is E.164 digits without "+"; `ref` is our idempotency/reference id. */
  sendAirtime(phone: string, amountFCFA: number, ref: string): Promise<{ providerRef: string }>;
  sendMoMo(phone: string, amountFCFA: number, ref: string): Promise<{ providerRef: string }>;
}

class MockProvider implements GiftProvider {
  readonly name = 'mock';
  async sendAirtime(_p: string, _a: number, ref: string) {
    return { providerRef: `mock-airtime-${ref}` };
  }
  async sendMoMo(_p: string, _a: number, ref: string) {
    return { providerRef: `mock-momo-${ref}` };
  }
}

/**
 * Campay (Cameroon MTN/Orange). Spec §9.6 says Campay "can transfer airtime".
 * UNVERIFIED against Campay's live/demo API from this environment — paths and field names
 * below follow their public docs as remembered; confirm with the demo sandbox before go-live.
 */
class CampayProvider implements GiftProvider {
  readonly name = 'campay';
  private base = env.CAMPAY_ENV === 'prod' ? 'https://campay.net/api' : 'https://demo.campay.net/api';

  private async post(path: string, body: Record<string, unknown>): Promise<{ reference?: string; message?: string; detail?: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { Authorization: `Token ${env.CAMPAY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new GiftError(`network: ${(err as Error).message}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as { reference?: string; message?: string; detail?: string };
    if (res.status >= 500) throw new GiftError(`campay ${res.status}`, true); // server may have processed it
    if (!res.ok || !json.reference) throw new GiftError(json.message ?? json.detail ?? `campay ${res.status}`, false);
    return json;
  }

  async sendAirtime(phone: string, amount: number, ref: string) {
    const r = await this.post('/utilities/airtime/transfer/', { amount: String(amount), to: phone, external_reference: ref });
    return { providerRef: r.reference! };
  }

  async sendMoMo(phone: string, amount: number, ref: string) {
    const r = await this.post('/withdraw/', { amount: String(amount), to: phone, description: 'SurveyFlow gift', external_reference: ref });
    return { providerRef: r.reference! };
  }
}

let provider: GiftProvider | null = null;
export function getGiftProvider(): GiftProvider {
  if (!provider) provider = env.giftProvider === 'campay' ? new CampayProvider() : new MockProvider();
  return provider;
}
export function setGiftProvider(p: GiftProvider | null) {
  provider = p;
}
