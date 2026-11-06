import type { Locale } from '../i18n';
import { privacyEn } from './privacy-en';
import { privacyFr } from './privacy-fr';
import { termsEn } from './terms-en';
import { termsFr } from './terms-fr';
import type { LegalContext, LegalDoc } from './types';

export type { Block, LegalContext, LegalDoc, LegalSection } from './types';
export { ENTITY, LEGAL_VERSION, contactLine, longDate } from './shared';

export const getPrivacy = (locale: Locale, ctx: LegalContext = {}): LegalDoc => (locale === 'fr' ? privacyFr(ctx) : privacyEn(ctx));
export const getTerms = (locale: Locale, ctx: LegalContext = {}): LegalDoc => (locale === 'fr' ? termsFr(ctx) : termsEn(ctx));

const EMAIL = /^[^\s@<>()[\]\\,;:"*]+@[^\s@<>()[\]\\,;:"*]+\.[^\s@<>()[\]\\,;:"*]+$/;

/** The address from SUPPORT_EMAIL, or undefined when it is not set or not an address: a legal page never prints a made-up or malformed contact. */
export function supportEmailFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const v = (env.SUPPORT_EMAIL ?? '').trim();
  return EMAIL.test(v) ? v : undefined;
}
