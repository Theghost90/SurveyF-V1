'use client';
import { SessionProvider } from 'next-auth/react';
import { SWRConfig } from 'swr';
import { Toaster } from '@/components/ui/sonner';
import { api } from '@/lib/api';
import { LocaleProvider } from '@/lib/i18n/client';
import type { Locale } from '@/lib/i18n';

export function Providers({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return (
    <SessionProvider>
      <LocaleProvider locale={locale}>
        <SWRConfig value={{ fetcher: (path: string) => api(path), revalidateOnFocus: false, shouldRetryOnError: false }}>
          {children}
          <Toaster />
        </SWRConfig>
      </LocaleProvider>
    </SessionProvider>
  );
}
