import type { Currency } from './plans';

export type PspName = 'notchpay' | 'cinetpay' | 'campay' | 'payunit' | 'flutterwave' | 'mock';
export type PaymentMethod = 'mobile_money' | 'card' | 'bank_transfer';

export interface CountryConfig {
  name: string;
  nameFr: string;
  callingCode: string;
  /** Official currency; also the currency owners from this country are billed in. */
  currency: Currency;
  /** A realistic mobile number in local international format, shown as the input example. */
  phoneExample: string;
  /** Fixed UTC offset in minutes (none of these countries observes DST). Used for business days / quiet hours. */
  utcOffsetMinutes: number;
  /** Preferred PSP for mobile money, in failover order. */
  mobileMoneyPSPs: PspName[];
  /** PSPs for card payments, in failover order. */
  cardPSPs: PspName[];
}

/**
 * Spec §9.7 COUNTRY_CONFIG, extended with ordered failover lists: the spec routes to
 * exactly one PSP, which means one PSP outage = no revenue for that country.
 */
// PSP lists below are what we would TRY; PSP_CAPABILITIES then filters to what each provider really supports.
const MM_FCFA_WEST: PspName[] = ['cinetpay', 'notchpay', 'flutterwave'];
const CARD_FCFA_WEST: PspName[] = ['flutterwave', 'cinetpay', 'notchpay'];
const MM_OTHER: PspName[] = ['notchpay', 'flutterwave'];
const CARD_OTHER: PspName[] = ['flutterwave', 'notchpay'];

export const COUNTRY_CONFIG: Record<string, CountryConfig> = {
  // CEMAC — XAF
  CM: { name: 'Cameroon', nameFr: 'Cameroun', callingCode: '237', currency: 'XAF', phoneExample: '+237 677 12 34 56', utcOffsetMinutes: 60, mobileMoneyPSPs: ['campay', 'notchpay', 'payunit', 'cinetpay'], cardPSPs: ['flutterwave', 'payunit', 'notchpay', 'cinetpay'] },
  GA: { name: 'Gabon', nameFr: 'Gabon', callingCode: '241', currency: 'XAF', phoneExample: '+241 06 12 34 56', utcOffsetMinutes: 60, mobileMoneyPSPs: MM_OTHER, cardPSPs: CARD_OTHER },
  CG: { name: 'Congo', nameFr: 'Congo', callingCode: '242', currency: 'XAF', phoneExample: '+242 06 123 4567', utcOffsetMinutes: 60, mobileMoneyPSPs: MM_OTHER, cardPSPs: CARD_OTHER },
  TD: { name: 'Chad', nameFr: 'Tchad', callingCode: '235', currency: 'XAF', phoneExample: '+235 63 01 23 45', utcOffsetMinutes: 60, mobileMoneyPSPs: MM_OTHER, cardPSPs: CARD_OTHER },
  CF: { name: 'Central African Republic', nameFr: 'République centrafricaine', callingCode: '236', currency: 'XAF', phoneExample: '+236 70 01 23 45', utcOffsetMinutes: 60, mobileMoneyPSPs: MM_OTHER, cardPSPs: CARD_OTHER },
  GQ: { name: 'Equatorial Guinea', nameFr: 'Guinée équatoriale', callingCode: '240', currency: 'XAF', phoneExample: '+240 222 123 456', utcOffsetMinutes: 60, mobileMoneyPSPs: MM_OTHER, cardPSPs: CARD_OTHER },
  // UEMOA — XOF
  CI: { name: "Côte d'Ivoire", nameFr: "Côte d'Ivoire", callingCode: '225', currency: 'XOF', phoneExample: '+225 07 12 34 56 78', utcOffsetMinutes: 0, mobileMoneyPSPs: MM_FCFA_WEST, cardPSPs: CARD_FCFA_WEST },
  SN: { name: 'Senegal', nameFr: 'Sénégal', callingCode: '221', currency: 'XOF', phoneExample: '+221 77 123 45 67', utcOffsetMinutes: 0, mobileMoneyPSPs: ['notchpay', 'cinetpay', 'flutterwave'], cardPSPs: ['flutterwave', 'notchpay', 'cinetpay'] },
  ML: { name: 'Mali', nameFr: 'Mali', callingCode: '223', currency: 'XOF', phoneExample: '+223 65 01 23 45', utcOffsetMinutes: 0, mobileMoneyPSPs: MM_FCFA_WEST, cardPSPs: CARD_FCFA_WEST },
  BF: { name: 'Burkina Faso', nameFr: 'Burkina Faso', callingCode: '226', currency: 'XOF', phoneExample: '+226 70 12 34 56', utcOffsetMinutes: 0, mobileMoneyPSPs: MM_FCFA_WEST, cardPSPs: CARD_FCFA_WEST },
  BJ: { name: 'Benin', nameFr: 'Bénin', callingCode: '229', currency: 'XOF', phoneExample: '+229 01 90 12 34 56', utcOffsetMinutes: 60, mobileMoneyPSPs: MM_FCFA_WEST, cardPSPs: CARD_FCFA_WEST },
  TG: { name: 'Togo', nameFr: 'Togo', callingCode: '228', currency: 'XOF', phoneExample: '+228 90 12 34 56', utcOffsetMinutes: 0, mobileMoneyPSPs: MM_FCFA_WEST, cardPSPs: CARD_FCFA_WEST },
  NE: { name: 'Niger', nameFr: 'Niger', callingCode: '227', currency: 'XOF', phoneExample: '+227 93 12 34 56', utcOffsetMinutes: 60, mobileMoneyPSPs: MM_FCFA_WEST, cardPSPs: CARD_FCFA_WEST },
  GW: { name: 'Guinea-Bissau', nameFr: 'Guinée-Bissau', callingCode: '245', currency: 'XOF', phoneExample: '+245 955 012 345', utcOffsetMinutes: 0, mobileMoneyPSPs: MM_OTHER, cardPSPs: CARD_OTHER },
  // Others we price in
  NG: { name: 'Nigeria', nameFr: 'Nigéria', callingCode: '234', currency: 'NGN', phoneExample: '+234 803 123 4567', utcOffsetMinutes: 60, mobileMoneyPSPs: ['flutterwave', 'notchpay'], cardPSPs: ['flutterwave', 'notchpay'] },
  KE: { name: 'Kenya', nameFr: 'Kenya', callingCode: '254', currency: 'KES', phoneExample: '+254 712 345 678', utcOffsetMinutes: 180, mobileMoneyPSPs: ['flutterwave', 'notchpay'], cardPSPs: ['flutterwave', 'notchpay'] },
  GH: { name: 'Ghana', nameFr: 'Ghana', callingCode: '233', currency: 'GHS', phoneExample: '+233 24 123 4567', utcOffsetMinutes: 0, mobileMoneyPSPs: ['flutterwave', 'notchpay'], cardPSPs: ['flutterwave', 'notchpay'] },
};

/** Cameroon, FCFA: the product's home market and the fallback whenever the visitor's country is unknown or unsupported. */
export const DEFAULT_COUNTRY = 'CM';

/** Normalises any country code (header, body, cookie) to one we support; everything else becomes the default. */
export function supportedCountry(code: string | null | undefined): string {
  const c = (code ?? '').trim().toUpperCase();
  return COUNTRY_CONFIG[c] ? c : DEFAULT_COUNTRY;
}

export function currencyForCountry(country: string): Currency {
  return COUNTRY_CONFIG[supportedCountry(country)]!.currency;
}

/** "Cameroon (XAF)" — the country with its official currency, in the UI language. */
export function countryWithCurrency(country: string, locale: 'en' | 'fr' = 'en'): string {
  const c = COUNTRY_CONFIG[supportedCountry(country)]!;
  return `${locale === 'fr' ? c.nameFr : c.name} (${c.currency})`;
}

/** "+237" for CM. */
export const dialPrefix = (country: string): string => `+${COUNTRY_CONFIG[supportedCountry(country)]!.callingCode}`;
export const phoneExampleFor = (country: string): string => COUNTRY_CONFIG[supportedCountry(country)]!.phoneExample;

/**
 * Which PSPs we can attempt to charge for: ordered fee ranking. `fees` maps psp → method → percent and comes from
 * configuration (PSP_FEES); a PSP with no configured fee keeps its configured order and ranks after the ones with a known fee.
 */
export type PspFees = Partial<Record<PspName, Partial<Record<PaymentMethod, number>>>>;
export function rankByFee(psps: PspName[], method: PaymentMethod, fees: PspFees): PspName[] {
  const fee = (p: PspName) => fees[p]?.[method];
  return psps
    .map((p, i) => ({ p, i, f: fee(p) }))
    .sort((a, b) => (a.f === undefined && b.f === undefined ? a.i - b.i : a.f === undefined ? 1 : b.f === undefined ? -1 : a.f - b.f || a.i - b.i))
    .map((x) => x.p);
}

/** What each PSP can actually do — used to filter the failover chain. */
export const PSP_CAPABILITIES: Record<PspName, { countries: string[] | '*'; methods: PaymentMethod[]; currencies: Currency[] }> = {
  notchpay: { countries: ['CM', 'CI', 'SN', 'NG', 'GH', 'KE'], methods: ['mobile_money', 'card', 'bank_transfer'], currencies: ['XAF', 'XOF', 'NGN', 'USD', 'EUR'] },
  cinetpay: { countries: ['CI', 'SN', 'CM', 'ML', 'BF', 'BJ', 'TG', 'NE'], methods: ['mobile_money', 'card'], currencies: ['XOF', 'XAF', 'USD', 'EUR'] },
  campay: { countries: ['CM'], methods: ['mobile_money'], currencies: ['XAF'] },
  payunit: { countries: ['CM'], methods: ['mobile_money', 'card'], currencies: ['XAF', 'USD'] },
  flutterwave: { countries: '*', methods: ['mobile_money', 'card', 'bank_transfer'], currencies: ['XAF', 'XOF', 'NGN', 'KES', 'GHS', 'USD', 'EUR'] },
  mock: { countries: '*', methods: ['mobile_money', 'card', 'bank_transfer'], currencies: ['XAF', 'XOF', 'NGN', 'KES', 'GHS', 'USD', 'EUR'] },
};
