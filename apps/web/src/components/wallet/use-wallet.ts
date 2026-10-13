'use client';
import useSWR from 'swr';

export interface WalletData {
  balanceFCFA: number;
  feePercent: number;
  inFlight: { count: number; fcfa: number };
  unfunded: { count: number; fcfa: number };
  needsCheck: { count: number; fcfa: number };
  entries: Array<{ id: string; at: string; deltaFCFA: number; balanceAfter: number; kind: 'topup' | 'gift_debit' | 'gift_refund'; note: string | null }>;
  topup: { min: number; max: number; presets: number[] };
}

/** The owner's prepaid gift wallet. SWR dedupes it across the header chip, billing card and builder panels. */
export function useWallet() {
  const { data, mutate, isLoading } = useSWR<WalletData>('/wallet');
  return { wallet: data, mutate, isLoading };
}

/** Same arithmetic as the server (packages/shared): the fee is rounded UP, so the preview never under-states the cost. */
export const unitCost = (amount: number, feePercent: number) => amount + (amount > 0 && feePercent > 0 ? Math.ceil((amount * feePercent) / 100) : 0);
