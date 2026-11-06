import type { Locale } from '../i18n';
import type { LegalContext } from './types';

/** The contracting company and controller, as the owner adopted it. The registration (RCCM) and tax numbers are added here when the company has them. */
export const ENTITY = { name: 'SurveyFlow Sarl', place: 'Bonamoussadi, Douala, Cameroon' } as const;

/** The date of this version of both documents. Change it whenever the text changes in a way a customer must be told about. */
export const LEGAL_VERSION = '2026-11-06';

const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
} as const;

/** "6 November 2026" / "6 novembre 2026" from an ISO date. */
export function longDate(iso: string, locale: Locale): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d}${locale === 'fr' && d === 1 ? 'er' : ''} ${MONTHS[locale][m - 1]} ${y}`;
}

/** The contact line shared by both documents: the postal address always, the e-mail only when it is set. */
export function contactLine(locale: Locale, ctx: LegalContext): string {
  const post = `**${ENTITY.name}**, ${ENTITY.place}.`;
  if (!ctx.supportEmail) return post;
  return `${post} ${locale === 'fr' ? 'E-mail :' : 'E-mail:'} [${ctx.supportEmail}](mailto:${ctx.supportEmail}).`;
}
