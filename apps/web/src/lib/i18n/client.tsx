'use client';
import { createContext, useContext, useMemo } from 'react';
import { makeT, type Locale, type TFn } from './index';

const Ctx = createContext<{ locale: Locale; t: TFn }>({ locale: 'en', t: makeT('en') });

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const value = useMemo(() => ({ locale, t: makeT(locale) }), [locale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useT = () => useContext(Ctx).t;
export const useLocale = () => useContext(Ctx).locale;
