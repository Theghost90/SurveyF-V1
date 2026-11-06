import { currencyLabel } from '@surveyflow/shared';
import type { Locale } from './i18n';

/** A plain number with thousands separators; up to two decimals only for small non-whole values (e.g. 0.86). */
export const num = (n: number, locale: Locale = 'en') => {
  const sep = locale === 'fr' ? ' ' : ',';
  const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  if (Number.isInteger(n) || Math.abs(n) >= 100) return group(Math.round(n).toString());
  const [i, d] = n.toFixed(2).split('.');
  return `${group(i!)}${locale === 'fr' ? ',' : '.'}${d}`;
};

export const dateShort = (d: string | Date, locale: Locale) =>
  new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d));

export const dateTime = (d: string | Date, locale: Locale) =>
  new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d));

/** "14,500 FCFA" / "35,200 NGN": an amount with its currency's label (both CFA francs read FCFA). */
export const money = (amount: number, currency: string, locale: Locale) => `${num(amount, locale)} ${currencyLabel(currency)}`;
