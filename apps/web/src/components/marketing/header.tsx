import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { Logo } from '@/components/logo';
import { LanguageToggle } from '@/components/language-toggle';
import { MobileMenu } from '@/components/marketing/mobile-menu';
import { buttonVariants } from '@/components/ui/button';
import { authOptions } from '@/lib/auth';
import { getT } from '@/lib/i18n/server';
import { cn } from '@/lib/utils';

/**
 * The public site's menu bar. It sticks to the top while the page scrolls (all widths).
 * From 640 px: logo, text links, language switch, "Sign in" and the call to action in ONE row that must fit in English and in French at every width. So it
 * grows in steps (measured, see scripts/e2e-landscape.mjs): from 640 px the logo mark, three links and a short button label; from 800 px the wordmark;
 * from 1024 px the fourth link ("For agencies & NGOs", always in the footer too); from 1280 px roomier gaps and the full button label.
 * Below 640 px: logo, language switch, "Explore free" and a hamburger (side menu) in one row, so both stay visible without a second line.
 */
export async function MarketingHeader({ current }: { current?: 'pricing' }) {
  const { t } = getT();
  const live = await getServerSession(authOptions).then((s) => !!s && !s.error); // a cookie that has run past its end is not a sign-in
  const link = 'text-[15px] font-medium text-ink no-underline hover:text-leaf';
  const links = [
    { href: '/#how', label: t('nav.how') },
    { href: '/#gifts', label: t('nav.gifts') },
    { href: '/#agencies', label: t('nav.agencies'), wide: true },
    { href: '/pricing', label: t('nav.pricing'), current: current === 'pricing' },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1344px] items-center gap-x-2 px-4 py-2.5 max-[299px]:gap-x-1 max-[299px]:px-3 short:py-1 sm:gap-x-3 sm:px-6 sm:py-3.5 short:sm:py-1 xl:gap-x-6 xl:px-8">
        {/* the wordmark gives way below 480 px and from 640 to 799 px, so that the switch and the call to action always fit on one line */}
        <Logo className="shrink-0 gap-2 max-[299px]:[&_svg]:h-7 max-[299px]:[&_svg]:w-7 [&_svg]:h-8 [&_svg]:w-8 short:[&_svg]:h-8 short:[&_svg]:w-8 sm:[&_svg]:h-9 sm:[&_svg]:w-9 [&_span]:hidden min-[480px]:max-sm:[&_span]:inline min-[800px]:[&_span]:inline [&_span]:text-[19px] xl:[&_span]:text-[22px]" />
        <nav aria-label={t('nav.main')} className="hidden min-w-0 flex-1 justify-center gap-x-4 sm:flex xl:gap-x-7">
          {links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={l.current ? 'page' : undefined} className={cn(link, 'whitespace-nowrap text-sm xl:text-[15px]', l.wide && 'hidden lg:inline', l.current && 'font-bold text-leaf')}>{l.label}</Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5 min-[360px]:gap-2 sm:ml-0 sm:gap-3 xl:gap-4">
          <LanguageToggle className="[&_button]:px-2 max-[299px]:[&_button]:px-1.5 min-[360px]:[&_button]:px-3" />
          {live ? (
            <Link href="/dashboard" className={buttonVariants({ className: 'h-10 rounded-xl px-2.5 text-sm max-[299px]:px-1.5 max-[299px]:text-xs short:h-9 min-[360px]:px-3.5 sm:h-[42px] short:sm:h-9 sm:px-4 xl:px-5 xl:text-[15px]' })}>{t('nav.dashboard')}</Link>
          ) : (
            <>
              <Link href="/login" className="hidden whitespace-nowrap text-sm font-semibold text-ink no-underline hover:text-leaf sm:inline xl:text-[15px]">{t('nav.signin')}</Link>
              <Link href="/register" className={buttonVariants({ className: 'h-10 rounded-xl px-2.5 text-sm short:h-9 min-[360px]:px-3.5 sm:h-[42px] short:sm:h-9 sm:px-4 xl:px-5 xl:text-[15px]' })}>
                <span className="xl:hidden">{t('nav.trialShort')}</span>
                <span className="hidden xl:inline">{t('nav.trial')}</span>
              </Link>
            </>
          )}
          <MobileMenu
            links={links}
            signedIn={live}
            labels={{ open: t('nav.openMenu'), close: t('nav.closeMenu'), menu: t('nav.menu'), signin: t('nav.signin'), trial: t('nav.trial'), dashboard: t('nav.dashboard'), privacy: t('footer.privacy'), terms: t('footer.terms') }}
          />
        </div>
      </div>
    </header>
  );
}
