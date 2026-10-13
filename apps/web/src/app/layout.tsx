import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { getLocale } from '@/lib/i18n/server';

export const metadata: Metadata = {
  title: { default: 'SurveyFlow — WhatsApp surveys for Cameroon', template: '%s · SurveyFlow' },
  description: 'Build a survey, send it on WhatsApp, and turn every answer into a decision — without your customers leaving the chat.',
  icons: { icon: '/icon.svg' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0B2B22' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = getLocale();
  return (
    <html lang={locale}>
      <body>
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
