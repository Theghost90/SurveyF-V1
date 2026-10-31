'use client';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { LOCALE_COOKIE, type Locale } from '@/lib/i18n';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

/** FR / EN switch, styled like the design's pill. Stores the choice in a cookie and re-renders server components. */
export function LanguageToggle({ className, dark }: { className?: string; dark?: boolean }) {
  const locale = useLocale();
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();

  const set = (l: Locale) => {
    if (l === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    start(() => router.refresh());
  };
  return (
    <div role="group" aria-label={t('nav.language')} className={cn('flex rounded-full border p-[3px] text-[13px] font-semibold', dark ? 'border-ink-line' : 'border-line-2', pending && 'opacity-70', className)}>
      {(['fr', 'en'] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => set(l)}
          aria-pressed={locale === l}
          lang={l}
          className={cn('min-h-[32px] rounded-full px-3 transition-colors', locale === l ? (dark ? 'bg-white text-ink' : 'bg-ink text-white') : dark ? 'text-white/70' : 'text-muted-foreground hover:text-ink')}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
