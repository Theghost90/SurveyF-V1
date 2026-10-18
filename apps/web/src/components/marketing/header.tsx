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
 * From 640 px: logo, text links, language switch, "Sign in" and the call to action in one row. From 640 to 767 px that row is tight, so the wordmark and
 * the longest link ("For agencies & NGOs", still in the footer and on the home page) give way; from 768 px everything shows.
 * Below 640 px: logo, language switch, "Explore free" and a hamburger (side menu) in one row, so both stay visible without a second line.
 */
export async function MarketingHeader({ current }: { current?: 'pricing' }) {
  const { t } = getT();
  const session = await getServerSession(authOptions);
  const link = 'text-[15px] font-medium text-ink no-underline hover:text-leaf';
  const links = [
    { href: '/#how', label: t('nav.how') },
    { href: '/#gifts', label: t('nav.gifts') },
    { href: '/#agencies', label: t('nav.agencies'), wide: true },
    { href: '/pricing', label: t('nav.pricing'), current: current === 'pricing' },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1344px] items-center gap-x-2 px-4 py-2.5 sm:gap-x-4 sm:px-6 sm:py-3.5 md:gap-x-6 md:px-8">
        {/* the wordmark gives way below 480 px (so the language switch and the call to action fit on one line) and from 640 to 767 px */}
        <Logo className="shrink-0 gap-2 [&_svg]:h-8 [&_svg]:w-8 sm:[&_svg]:h-9 sm:[&_svg]:w-9 [&_span]:hidden min-[480px]:max-sm:[&_span]:inline md:[&_span]:inline [&_span]:text-[19px] md:[&_span]:text-[22px]" />
        <nav aria-label={t('nav.main')} className="hidden min-w-0 flex-1 justify-center gap-x-4 sm:flex md:gap-x-7">
          {links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={l.current ? 'page' : undefined} className={cn(link, 'whitespace-nowrap text-sm md:text-[15px]', l.wide && 'hidden md:inline', l.current && 'font-bold text-leaf')}>{l.label}</Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5 min-[360px]:gap-2 sm:ml-0 sm:gap-3 md:gap-4">
          <LanguageToggle className="[&_button]:px-2 min-[360px]:[&_button]:px-3" />
          {session ? (
            <Link href="/dashboard" className={buttonVariants({ className: 'h-10 rounded-xl px-2.5 text-sm min-[360px]:px-3.5 sm:h-[42px] sm:px-5 sm:text-[15px]' })}>{t('nav.dashboard')}</Link>
          ) : (
            <>
              <Link href="/login" className="hidden whitespace-nowrap text-sm font-semibold text-ink no-underline hover:text-leaf sm:inline md:text-[15px]">{t('nav.signin')}</Link>
              <Link href="/register" className={buttonVariants({ className: 'h-10 rounded-xl px-2.5 text-sm min-[360px]:px-3.5 sm:h-[42px] sm:px-5 sm:text-[15px]' })}>
                <span className="sm:hidden">{t('nav.trialShort')}</span>
                <span className="hidden sm:inline">{t('nav.trial')}</span>
              </Link>
            </>
          )}
          <MobileMenu
            links={links}
            signedIn={!!session}
            labels={{ open: t('nav.openMenu'), close: t('nav.closeMenu'), menu: t('nav.menu'), signin: t('nav.signin'), trial: t('nav.trial'), dashboard: t('nav.dashboard'), privacy: t('footer.privacy'), terms: t('footer.terms') }}
          />
        </div>
      </div>
    </header>
  );
}
