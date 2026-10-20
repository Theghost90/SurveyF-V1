import { api } from './api';

export type PayStatus = 'pending' | 'success' | 'failed' | 'expired' | 'review';
export interface PayState {
  status: PayStatus;
  purpose?: string;
  /** Safe category of a failure (the provider's own words never reach the browser). */
  failCode?: 'declined' | 'unavailable' | 'other' | null;
}

/** Message key for a payment that did not go through, from the safe failure category. */
export const failKey = (code: PayState['failCode']): 'bill.fail.declined' | 'bill.fail.unavailable' | 'bill.payFailed' =>
  code === 'declined' ? 'bill.fail.declined' : code === 'unavailable' ? 'bill.fail.unavailable' : 'bill.payFailed';

/** Polling cadence. A test (or a very slow network) can override it with `window.__SF_PAY_POLL__ = { every, tries }`. */
const cadence = () => ({ every: 3_000, tries: 60, ...(typeof window !== 'undefined' ? (window as { __SF_PAY_POLL__?: { every?: number; tries?: number } }).__SF_PAY_POLL__ : undefined) });

/**
 * Watches one payment until it is decided: the API re-verifies with the provider on every call, so this also heals a missed webhook.
 * `done` fires for every decided state (success, failed, expired, review); `timeout` fires when we ran out of patience while it is STILL
 * pending, which is not a failure: the customer may be about to approve, or already did.
 */
export function watchPayment(id: string, on: { done: (s: PayState) => void; timeout: () => void }): () => void {
  let stop = false;
  void (async () => {
    const { every, tries } = cadence();
    for (let i = 0; i < tries && !stop; i++) {
      try {
        const s = await api<PayState>(`/payments/${id}`);
        if (s.status !== 'pending') { if (!stop) on.done(s); return; }
      } catch { /* the network blinked: keep trying */ }
      await new Promise((r) => setTimeout(r, every));
    }
    if (!stop) on.timeout();
  })();
  return () => { stop = true; };
}
