'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import * as D from '@radix-ui/react-dialog';
import { BarChart3, CreditCard, FlaskConical, Home, LogOut, MessageCircle, MoreHorizontal, Settings, Users } from 'lucide-react';
import { LanguageToggle } from '@/components/language-toggle';
import { Badge } from '@/components/ui/badge';
import { useAccount } from '@/lib/account';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

/**
 * Phone navigation (below 640 px): five fixed tabs at the thumb, and a "More" sheet for the rest.
 * The fourth tab is the Simulator where it exists (demo mode) and Settings otherwise; Settings is always reachable from the sheet.
 */
export function MobileNav({ showSimulator }: { showSimulator: boolean }) {
  const t = useT();
  const pathname = usePathname();
  const { account } = useAccount();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  if (pathname.startsWith('/onboarding')) return null; // the wizard is a focused flow: no navigation until it is done
  const is = (href: string) => pathname === href || pathname.startsWith(href + '/');
  const fourth = showSimulator ? { href: '/simulator', label: t('app.nav.simulator'), Icon: FlaskConical } : { href: '/settings', label: t('app.nav.settings'), Icon: Settings };
  const tabs = [
    { href: '/dashboard', label: t('app.nav.home'), Icon: Home },
    { href: '/surveys', label: t('app.nav.surveys'), Icon: BarChart3 },
    { href: '/contacts', label: t('app.nav.contacts'), Icon: Users },
    fourth,
  ];
  const moreActive = is('/billing') || (showSimulator && is('/settings'));
  const item = 'flex min-h-[48px] items-center gap-3 border-t border-line-3 px-1 py-3 text-[15px] font-semibold text-ink no-underline first:border-t-0';
  const icon = 'flex h-9 w-9 items-center justify-center rounded-xl bg-mint text-leaf';

  return (
    <>
      <nav aria-label={t('nav.main')} className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] sm:hidden">
        <ul className="mx-auto flex max-w-md items-stretch px-1 pt-1.5">
          {tabs.map(({ href, label, Icon }) => (
            <li key={href} className="flex-1">
              <Link href={href} aria-current={is(href) ? 'page' : undefined} className={cn('flex flex-col items-center gap-0.5 py-1 text-[11px] font-bold no-underline', is(href) ? 'text-ink' : 'text-muted-foreground')}>
                <span className={cn('flex h-7 w-14 items-center justify-center rounded-full', is(href) && 'bg-mint')}><Icon className="h-[19px] w-[19px]" aria-hidden /></span>
                {label}
              </Link>
            </li>
          ))}
          <li className="flex-1">
            <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} className={cn('flex w-full flex-col items-center gap-0.5 py-1 text-[11px] font-bold', moreActive || open ? 'text-ink' : 'text-muted-foreground')}>
              <span className={cn('flex h-7 w-14 items-center justify-center rounded-full', (moreActive || open) && 'bg-mint')}><MoreHorizontal className="h-[19px] w-[19px]" aria-hidden /></span>
              {t('app.nav.more')}
            </button>
          </li>
        </ul>
      </nav>

      <D.Root open={open} onOpenChange={setOpen}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-50 bg-ink/50 sm:hidden" />
          <D.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-[26px] bg-white px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 shadow-float sm:hidden" aria-describedby={undefined}>
            <D.Title className="sr-only">{t('app.nav.more')}</D.Title>
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-2" aria-hidden />
            <Link href="/billing" className={item}>
              <span className={icon}><CreditCard className="h-[18px] w-[18px]" aria-hidden /></span>{t('app.nav.billingWallet')}
              {account && <Badge className="ml-auto" variant={account.plan.key === 'trial' ? 'amber' : 'default'}>{t(`plan.${account.plan.key as 'trial'}`)}</Badge>}
            </Link>
            {showSimulator && <Link href="/settings" className={item}><span className={icon}><Settings className="h-[18px] w-[18px]" aria-hidden /></span>{t('app.nav.settings')}</Link>}
            <Link href="/settings?tab=analytics" className={item}><span className={icon}><MessageCircle className="h-[18px] w-[18px]" aria-hidden /></span>{t('ab.title')}</Link>
            <div className={cn(item, 'justify-between')}><span className="flex items-center gap-3"><span className={icon}><span className="text-base" aria-hidden>🌐</span></span>{t('nav.language')}</span><LanguageToggle /></div>
            <button type="button" onClick={() => void signOut({ callbackUrl: '/' })} className={cn(item, 'w-full text-left text-destructive')}>
              <span className={cn(icon, 'bg-red-50 text-destructive')}><LogOut className="h-[18px] w-[18px]" aria-hidden /></span>{t('app.signout')}
            </button>
          </D.Content>
        </D.Portal>
      </D.Root>
    </>
  );
}
