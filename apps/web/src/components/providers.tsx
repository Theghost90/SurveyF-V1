'use client';
import { SWRConfig } from 'swr';
import { StepUpHost } from '@/components/step-up-dialog';
import { Toaster } from '@/components/ui/sonner';
import { api } from '@/lib/api';
import { GeoProvider, type GeoValue } from '@/lib/geo-context';
import { LocaleProvider } from '@/lib/i18n/client';
import type { Locale } from '@/lib/i18n';

/**
 * No NextAuth SessionProvider on purpose: it polls /api/auth/session, and that endpoint writes the session cookie back from whatever it just read. The proxy
 * rotates the refresh token inside that same cookie, so a late answer from the poll would put the OLD refresh token back and, 30 seconds later, look like a
 * stolen cookie. Nothing here needs the session on the client: the proxy answers 401 when it ends and the middleware redirects pages.
 */
export function Providers({ locale, geo, children }: { locale: Locale; geo: GeoValue; children: React.ReactNode }) {
  return (
    <LocaleProvider locale={locale}>
      <GeoProvider value={geo}>
        <SWRConfig value={{ fetcher: (path: string) => api(path), revalidateOnFocus: false, shouldRetryOnError: false }}>
          {children}
          <StepUpHost />
          <Toaster />
        </SWRConfig>
      </GeoProvider>
    </LocaleProvider>
  );
}
