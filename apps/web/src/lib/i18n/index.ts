import { en as marketingEn, fr as marketingFr } from './marketing';
import { en as appEn, fr as appFr } from './app';
import { en as builderEn, fr as builderFr } from './builder';
import { en as insightsEn, fr as insightsFr } from './insights';
import { en as accountEn, fr as accountFr } from './account';
import { en as walletEn, fr as walletFr } from './wallet';
import { en as securityEn, fr as securityFr } from './security';

export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'sf_lang';

const dictionaries = {
  en: { ...marketingEn, ...appEn, ...builderEn, ...insightsEn, ...accountEn, ...walletEn, ...securityEn },
  fr: { ...marketingFr, ...appFr, ...builderFr, ...insightsFr, ...accountFr, ...walletFr, ...securityFr },
} as const;

export type TKey = keyof (typeof dictionaries)['en'];
export type TFn = (key: TKey, params?: Record<string, string | number>) => string;

export function makeT(locale: Locale): TFn {
  const dict = dictionaries[locale] as Record<string, string>;
  return (key, params) => {
    let s = dict[key] ?? (dictionaries.en as Record<string, string>)[key] ?? key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}

export const isLocale = (v: unknown): v is Locale => v === 'en' || v === 'fr';

/** Picks fr when the browser prefers French, otherwise en. */
export function detectLocale(acceptLanguage: string | null | undefined): Locale {
  const first = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('fr') ? 'fr' : DEFAULT_LOCALE;
}
