import type { Currency } from './plans';

export type PspName = 'notchpay' | 'cinetpay' | 'campay' | 'payunit' | 'flutterwave' | 'mock';
export type PaymentMethod = 'mobile_money' | 'card' | 'bank_transfer';

export interface CountryConfig {
  name: string;
  callingCode: string;
  currency: Currency;
  /** Preferred PSP for mobile money, in failover order. */
  mobileMoneyPSPs: PspName[];
  /** PSPs for card payments, in failover order. */
  cardPSPs: PspName[];
}

/**
 * Spec §9.7 COUNTRY_CONFIG, extended with ordered failover lists: the spec routes to
 * exactly one PSP, which means one PSP outage = no revenue for that country.
 */
export const COUNTRY_CONFIG: Record<string, CountryConfig> = {
  CM: { name: 'Cameroon', callingCode: '237', currency: 'XAF', mobileMoneyPSPs: ['campay', 'notchpay', 'payunit', 'cinetpay'], cardPSPs: ['flutterwave', 'payunit', 'notchpay', 'cinetpay'] },
  CI: { name: "Côte d'Ivoire", callingCode: '225', currency: 'XOF', mobileMoneyPSPs: ['cinetpay', 'notchpay', 'flutterwave'], cardPSPs: ['flutterwave', 'cinetpay', 'notchpay'] },
  SN: { name: 'Senegal', callingCode: '221', currency: 'XOF', mobileMoneyPSPs: ['notchpay', 'cinetpay', 'flutterwave'], cardPSPs: ['flutterwave', 'notchpay', 'cinetpay'] },
  NG: { name: 'Nigeria', callingCode: '234', currency: 'NGN', mobileMoneyPSPs: ['flutterwave', 'notchpay'], cardPSPs: ['flutterwave', 'notchpay'] },
  KE: { name: 'Kenya', callingCode: '254', currency: 'KES', mobileMoneyPSPs: ['flutterwave', 'notchpay'], cardPSPs: ['flutterwave', 'notchpay'] },
  GH: { name: 'Ghana', callingCode: '233', currency: 'GHS', mobileMoneyPSPs: ['flutterwave', 'notchpay'], cardPSPs: ['flutterwave', 'notchpay'] },
};

export const DEFAULT_COUNTRY = 'CM';

export function currencyForCountry(country: string): Currency {
  return COUNTRY_CONFIG[country]?.currency ?? 'USD';
}

/** What each PSP can actually do — used to filter the failover chain. */
export const PSP_CAPABILITIES: Record<PspName, { countries: string[] | '*'; methods: PaymentMethod[]; currencies: Currency[] }> = {
  notchpay: { countries: ['CM', 'CI', 'SN', 'NG', 'GH', 'KE'], methods: ['mobile_money', 'card', 'bank_transfer'], currencies: ['XAF', 'XOF', 'NGN', 'USD', 'EUR'] },
  cinetpay: { countries: ['CI', 'SN', 'CM'], methods: ['mobile_money', 'card'], currencies: ['XOF', 'XAF', 'USD', 'EUR'] },
  campay: { countries: ['CM'], methods: ['mobile_money'], currencies: ['XAF'] },
  payunit: { countries: ['CM'], methods: ['mobile_money', 'card'], currencies: ['XAF', 'USD'] },
  flutterwave: { countries: '*', methods: ['mobile_money', 'card', 'bank_transfer'], currencies: ['XAF', 'XOF', 'NGN', 'KES', 'GHS', 'USD', 'EUR'] },
  mock: { countries: '*', methods: ['mobile_money', 'card', 'bank_transfer'], currencies: ['XAF', 'XOF', 'NGN', 'KES', 'GHS', 'USD', 'EUR'] },
};
