'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, FlaskConical, Home, Users } from 'lucide-react';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

/**
 * Phone navigation (below 640 px): a tab bar fixed at the thumb for the working screens (Home, Surveys, Contacts, and the Simulator where it exists).
 * Billing, Settings and Sign out are in the account menu at the top, the same place as on a larger screen: there is no second menu.
 */
export function MobileNav({ showSimulator }: { showSimulator: boolean }) {
  const t = useT();
  const pathname = usePathname();
  if (pathname.startsWith('/onboarding')) return null; // the wizard is a focused flow: no navigation until it is done
  const is = (href: string) => pathname === href || pathname.startsWith(href + '/');
  const tabs = [
    { href: '/dashboard', label: t('app.nav.home'), Icon: Home },
    { href: '/surveys', label: t('app.nav.surveys'), Icon: BarChart3 },
    { href: '/contacts', label: t('app.nav.contacts'), Icon: Users },
    ...(showSimulator ? [{ href: '/simulator', label: t('app.nav.simulator'), Icon: FlaskConical }] : []),
  ];

  return (
    <nav aria-label={t('nav.main')} className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] sm:hidden">
      <ul className="mx-auto flex max-w-md items-stretch px-1 pt-1.5 short:max-w-none short:pt-0.5">
        {tabs.map(({ href, label, Icon }) => (
          <li key={href} className="flex-1">
            <Link href={href} aria-current={is(href) ? 'page' : undefined} className={cn('flex min-h-[48px] flex-col items-center gap-0.5 py-1 text-[11px] font-bold no-underline short:min-h-[40px] short:flex-row short:justify-center short:gap-2 short:py-0.5', is(href) ? 'text-ink' : 'text-muted-foreground')}>
              <span className={cn('flex h-7 w-14 items-center justify-center rounded-full short:h-7 short:w-9', is(href) && 'bg-mint')}><Icon className="h-[19px] w-[19px]" aria-hidden /></span>
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
