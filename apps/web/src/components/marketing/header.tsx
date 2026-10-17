import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { Logo } from '@/components/logo';
import { LanguageToggle } from '@/components/language-toggle';
import { buttonVariants } from '@/components/ui/button';
import { authOptions } from '@/lib/auth';
import { getT } from '@/lib/i18n/server';
import { cn } from '@/lib/utils';

export async function MarketingHeader({ current }: { current?: 'pricing' }) {
  const { t } = getT();
  const session = await getServerSession(authOptions);
  const link = 'text-[15px] font-medium text-ink no-underline hover:text-leaf';
  return (
    <header className="mx-auto flex max-w-[1344px] flex-wrap items-center gap-x-6 gap-y-3 px-5 py-6 sm:px-8">
      <Logo />
      <nav aria-label={t('nav.main')} className="order-last flex w-full flex-wrap justify-center gap-x-7 gap-y-1 sm:order-none sm:w-auto sm:flex-1">
        <Link href="/#how" className={link}>{t('nav.how')}</Link>
        <Link href="/#gifts" className={link}>{t('nav.gifts')}</Link>
        <Link href="/#agencies" className={link}>{t('nav.agencies')}</Link>
        <Link href="/pricing" aria-current={current === 'pricing' ? 'page' : undefined} className={cn(link, current === 'pricing' && 'font-bold text-leaf')}>{t('nav.pricing')}</Link>
      </nav>
      <div className="ml-auto flex flex-wrap items-center gap-4 sm:ml-0">
        <LanguageToggle />
        {session ? (
          <Link href="/dashboard" className={buttonVariants({ className: 'h-[42px] rounded-xl px-5 text-[15px]' })}>{t('nav.dashboard')}</Link>
        ) : (
          <>
            <Link href="/login" className="hidden text-[15px] font-semibold text-ink no-underline hover:text-leaf sm:inline">{t('nav.signin')}</Link>
            <Link href="/register" className={buttonVariants({ className: 'h-[42px] rounded-xl px-5 text-[15px]' })}>{t('nav.trial')}</Link>
          </>
        )}
      </div>
    </header>
  );
}
