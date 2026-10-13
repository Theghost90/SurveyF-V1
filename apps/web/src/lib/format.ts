import type { Locale } from './i18n';

export const fcfa = (n: number, locale: Locale = 'en') => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'fr' ? ' ' : ',');

export const dateShort = (d: string | Date, locale: Locale) =>
  new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d));

export const dateTime = (d: string | Date, locale: Locale) =>
  new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d));

export const money = (amount: number, currency: string, locale: Locale) =>
  `${fcfa(amount, locale)} ${currency === 'XAF' || currency === 'XOF' ? 'FCFA' : currency}`;
