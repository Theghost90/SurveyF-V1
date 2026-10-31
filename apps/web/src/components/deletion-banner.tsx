'use client';
import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

/** While the owner's erasure is scheduled the account only reads: say so on every screen, with the date and the way back. */
export function DeletionBanner({ scheduledFor }: { scheduledFor: string }) {
  const t = useT();
  const locale = useLocale();
  const date = new Date(scheduledFor).toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'long' });
  return (
    <div role="status" data-testid="deletion-banner" className="border-b border-red-200 bg-red-50 text-sm text-red-900">
      <div className="mx-auto flex max-w-[1344px] flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 sm:px-8">
        <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
        <span className="font-medium">{t('dt.banner', { date })}</span>
        <Link href="/settings?tab=data" className={cn(buttonVariants({ size: 'sm', variant: 'dark' }), 'ml-auto h-8 rounded-lg px-3 text-[13px]')}>{t('dt.cancelCta')}</Link>
      </div>
    </div>
  );
}
