import Link from 'next/link';
import { Logo } from '@/components/logo';
import { getT } from '@/lib/i18n/server';

export async function MarketingFooter() {
  const { t } = await getT();
  return (
    <footer className="border-t border-line bg-white">
      <div className="mx-auto flex max-w-[1344px] flex-wrap items-start justify-between gap-8 px-5 py-10 sm:px-8">
        <div className="max-w-xs">
          <Logo />
          <p className="mt-3 text-sm text-muted-foreground">{t('footer.tagline')}</p>
        </div>
        <div className="flex flex-wrap gap-12 text-sm">
          <div className="flex flex-col gap-2">
            <span className="font-bold">{t('footer.product')}</span>
            <Link className="text-body hover:text-leaf" href="/#how">{t('nav.how')}</Link>
            <Link className="text-body hover:text-leaf" href="/#gifts">{t('nav.gifts')}</Link>
            <Link className="text-body hover:text-leaf" href="/#agencies">{t('nav.agencies')}</Link>
            <Link className="text-body hover:text-leaf" href="/pricing">{t('nav.pricing')}</Link>
          </div>
          <div className="flex flex-col gap-2">
            <span className="font-bold">{t('footer.legal')}</span>
            <Link className="text-body hover:text-leaf" href="/privacy">{t('footer.privacy')}</Link>
            <Link className="text-body hover:text-leaf" href="/terms">{t('footer.terms')}</Link>
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-[1344px] px-5 pb-8 text-xs text-muted-foreground sm:px-8">{t('footer.rights', { year: new Date().getFullYear() })}</div>
    </footer>
  );
}
