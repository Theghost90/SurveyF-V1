import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, detectLocale, isLocale, makeT, type Locale } from './index';

export async function getLocale(): Promise<Locale> {
  const c = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(c)) return c;
  return detectLocale((await headers()).get('accept-language'));
}

export async function getT() {
  const locale = await getLocale();
  return { locale, t: makeT(locale) };
}
