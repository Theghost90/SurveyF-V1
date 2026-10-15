'use client';
import { SessionProvider } from 'next-auth/react';
import { SWRConfig } from 'swr';
import { Toaster } from '@/components/ui/sonner';
import { api } from '@/lib/api';
import { GeoProvider, type GeoValue } from '@/lib/geo-context';
import { LocaleProvider } from '@/lib/i18n/client';
import type { Locale } from '@/lib/i18n';

export function Providers({ locale, geo, children }: { locale: Locale; geo: GeoValue; children: React.ReactNode }) {
  return (
    <SessionProvider>
      <LocaleProvider locale={locale}>
        <GeoProvider value={geo}>
          <SWRConfig value={{ fetcher: (path: string) => api(path), revalidateOnFocus: false, shouldRetryOnError: false }}>
            {children}
            <Toaster />
          </SWRConfig>
        </GeoProvider>
      </LocaleProvider>
    </SessionProvider>
  );
}
