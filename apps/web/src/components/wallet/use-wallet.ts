'use client';
import useSWR from 'swr';

/** The wallet is kept in the owner's currency (whole units): `currency` says which, every amount below is in it. */
export interface WalletData {
  currency: string;
  balance: number;
  feePercent: number;
  inFlight: { count: number; amount: number };
  unfunded: { count: number; amount: number };
  needsCheck: { count: number; amount: number };
  entries: Array<{ id: string; at: string; delta: number; balanceAfter: number; kind: 'topup' | 'gift_debit' | 'gift_refund'; note: string | null }>;
  /** Top-up and gift limits in `currency`; null while a non-CFA currency has no fresh exchange rate (top-ups pause). */
  limits: { topupMin: number; topupMax: number; presets: number[]; giftMin: number; giftMax: number } | null;
  fxUnavailable: boolean;
  /** Payment methods available in this currency: Mobile Money only exists in CFA francs, everything else pays by card. */
  methods: Array<'mobile_money' | 'card'>;
}

/** The owner's prepaid gift wallet. SWR dedupes it across the header chip, billing card and builder panels. */
export function useWallet() {
  const { data, mutate, isLoading } = useSWR<WalletData>('/wallet');
  return { wallet: data, mutate, isLoading };
}

/** Same arithmetic as the server (packages/shared): the fee is rounded UP, so the preview never under-states the cost. */
export const unitCost = (amount: number, feePercent: number) => amount + (amount > 0 && feePercent > 0 ? Math.ceil((amount * feePercent) / 100) : 0);
