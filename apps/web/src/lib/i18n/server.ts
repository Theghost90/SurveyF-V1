import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, detectLocale, isLocale, makeT, type Locale } from './index';

export function getLocale(): Locale {
  const c = cookies().get(LOCALE_COOKIE)?.value;
  if (isLocale(c)) return c;
  return detectLocale(headers().get('accept-language'));
}

export function getT() {
  const locale = getLocale();
  return { locale, t: makeT(locale) };
}
