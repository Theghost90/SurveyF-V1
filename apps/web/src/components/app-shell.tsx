'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { AlertTriangle, ChevronDown, CreditCard, LogOut, Settings, Sparkles, Wallet } from 'lucide-react';
import { Logo } from '@/components/logo';
import { LanguageToggle } from '@/components/language-toggle';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useWallet } from '@/components/wallet/use-wallet';
import { useAccount } from '@/lib/account';
import { dateShort, fcfa } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

export function AppShell({ children, showSimulator }: { children: React.ReactNode; showSimulator: boolean }) {
  const t = useT();
  const locale = useLocale();
  const pathname = usePathname();
  const { account } = useAccount();
  const { wallet } = useWallet();

  const nav = [
    { href: '/dashboard', label: t('app.nav.dashboard') },
    { href: '/surveys', label: t('app.nav.surveys') },
    { href: '/contacts', label: t('app.nav.contacts') },
    { href: '/settings', label: t('app.nav.settings') },
    ...(showSimulator ? [{ href: '/simulator', label: t('app.nav.simulator') }] : []),
  ];

  const sub = account?.subscription;
  const banner =
    !sub ? null
    : sub.status === 'suspended' ? { tone: 'danger' as const, text: t('app.suspended'), cta: t('app.renew') }
    : sub.status === 'past_due' ? { tone: 'warn' as const, text: t('app.pastDue', { date: sub.graceEndsAt ? dateShort(sub.graceEndsAt, locale) : '' }), cta: t('app.renew') }
    : sub.status === 'trial' ? { tone: 'info' as const, text: sub.daysLeft === 1 ? t('app.trialLeftOne') : t('app.trialLeft', { n: sub.daysLeft }), cta: t('common.upgrade') }
    : null;

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2">{t('app.skipToContent')}</a>
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1344px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 sm:px-8">
          <Logo href="/dashboard" className="[&_span]:text-xl" />
          <nav aria-label={t('nav.main')} className="order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto sm:flex-1">
            {nav.map((n) => {
              const active = pathname === n.href || pathname.startsWith(n.href + '/');
              return (
                <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined} className={cn('whitespace-nowrap rounded-xl px-3.5 py-2.5 text-[15px] font-semibold no-underline transition-colors', active ? 'bg-ink text-white' : 'text-body hover:bg-mint/60')}>
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3 sm:ml-0">
            {account && <Link href="/billing" className="hidden sm:inline"><Badge variant={account.plan.key === 'trial' ? 'amber' : 'default'}>{t(`plan.${account.plan.key as 'trial'}`)}</Badge></Link>}
            {account?.plan.features.giftAutomation && wallet && (
              <Link href="/billing#wallet" className="hidden sm:inline" aria-label={`${t('w.title')}: ${fcfa(wallet.balanceFCFA, locale)} FCFA`}>
                <Badge variant={wallet.balanceFCFA === 0 ? 'amber' : 'neutral'}><Wallet className="mr-1 h-3.5 w-3.5" aria-hidden />{fcfa(wallet.balanceFCFA, locale)}</Badge>
              </Link>
            )}
            <LanguageToggle />
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-2 rounded-xl border border-line-2 bg-white py-1.5 pl-1.5 pr-3 text-sm font-semibold" aria-label={t('app.account')}>
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-bold text-ink">{(account?.user.name ?? '?').slice(0, 1).toUpperCase()}</span>
                <span className="hidden max-w-[120px] truncate sm:inline">{account?.user.businessName ?? <Skeleton className="h-4 w-20" />}</span>
                <ChevronDown className="h-4 w-4 opacity-60" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{account?.user.email}</DropdownMenuLabel>
                <DropdownMenuItem asChild><Link href="/billing"><CreditCard className="h-4 w-4" aria-hidden />{t('app.nav.billing')}</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><Link href="/settings"><Settings className="h-4 w-4" aria-hidden />{t('app.nav.settings')}</Link></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void signOut({ callbackUrl: '/' })}><LogOut className="h-4 w-4" aria-hidden />{t('app.signout')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {banner && (
        <div role="status" className={cn('border-b text-sm', banner.tone === 'danger' ? 'border-red-200 bg-red-50 text-red-900' : banner.tone === 'warn' ? 'border-amber/40 bg-amber-soft text-amber-ink' : 'border-mint-2/50 bg-mint/50 text-ink')}>
          <div className="mx-auto flex max-w-[1344px] flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 sm:px-8">
            {banner.tone === 'info' ? <Sparkles className="h-4 w-4 text-leaf" aria-hidden /> : <AlertTriangle className="h-4 w-4" aria-hidden />}
            <span className="font-medium">{banner.text}</span>
            <Link href="/billing" className={buttonVariants({ size: 'sm', variant: banner.tone === 'info' ? 'default' : 'dark', className: 'ml-auto h-8 rounded-lg px-3 text-[13px]' })}>{banner.cta}</Link>
          </div>
        </div>
      )}

      <main id="main" className="mx-auto max-w-[1344px] px-5 pb-20 pt-8 sm:px-8">{children}</main>
    </div>
  );
}
