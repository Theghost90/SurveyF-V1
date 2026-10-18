'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { AlertTriangle, ChevronDown, CreditCard, LogOut, Settings, Sparkles, Wallet } from 'lucide-react';
import { Logo } from '@/components/logo';
import { LanguageToggle } from '@/components/language-toggle';
import { MobileNav } from '@/components/mobile-nav';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { WhatsAppRequiredDialog } from '@/components/whatsapp-gate';
import { useWallet } from '@/components/wallet/use-wallet';
import { useAccount } from '@/lib/account';
import { dateShort, money, num } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import { useEffect } from 'react';

export function AppShell({ children, showSimulator }: { children: React.ReactNode; showSimulator: boolean }) {
  const t = useT();
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const { account } = useAccount();
  const { wallet } = useWallet();

  // The customer segment is the one required answer of setup. Anyone without it (new sign-up that skipped the wizard, or an
  // account created before this question existed) is taken to the onboarding step that asks it, and nowhere else until answered.
  const needsSegment = !!account && !account.user.segment && pathname !== '/onboarding';
  useEffect(() => { if (needsSegment) router.replace('/onboarding'); }, [needsSegment, router]);

  const nav = [
    { href: '/dashboard', label: t('app.nav.dashboard') },
    { href: '/surveys', label: t('app.nav.surveys') },
    { href: '/contacts', label: t('app.nav.contacts') },
    ...(showSimulator ? [{ href: '/simulator', label: t('app.nav.simulator') }] : []),
  ];

  const inAccount = ['/settings', '/billing'].some((h) => pathname === h || pathname.startsWith(h + '/'));

  const sub = account?.subscription;
  const banner =
    !sub ? null
    : sub.status === 'suspended' ? { tone: 'danger' as const, text: t('app.suspended'), cta: t('app.renew') }
    : sub.status === 'past_due' ? { tone: 'warn' as const, text: t('app.pastDue', { date: sub.graceEndsAt ? dateShort(sub.graceEndsAt, locale) : '' }), cta: t('app.renew') }
    : sub.status === 'active' && sub.amountFCFA > 0 && sub.daysLeft <= 5 ? { tone: 'warn' as const, text: t(sub.cancelAtPeriodEnd ? 'app.endsSoon' : 'app.renewsSoon', { n: sub.daysLeft }), cta: sub.cancelAtPeriodEnd ? t('common.upgrade') : t('app.renew') }
    : account && account.plan.key === 'trial' && account.plan.limits.recipients !== null ? (() => {
        // Explore: no countdown, a number of people. Say how many are left, and offer the plan without nagging while plenty remain.
        const max = account.plan.limits.recipients, left = Math.max(0, max - account.usage.recipients);
        return { tone: left === 0 ? 'warn' as const : 'info' as const, text: left === 0 ? t('app.exploreFull', { max }) : t('app.exploreLeft', { left, max }), cta: t('app.activate') };
      })()
    : null;

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2">{t('app.skipToContent')}</a>
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1344px] items-center gap-x-3 px-4 py-3 sm:flex-wrap sm:gap-x-6 sm:gap-y-2 sm:px-8">
          <Logo href="/dashboard" className="[&_span]:text-lg sm:[&_span]:text-xl" />
          <nav aria-label={t('nav.main')} className="hidden sm:flex sm:flex-1 sm:gap-1">
            {nav.map((n) => {
              const active = pathname === n.href || pathname.startsWith(n.href + '/');
              return (
                <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined} className={cn('whitespace-nowrap rounded-xl px-3.5 py-2.5 text-[15px] font-semibold no-underline transition-colors', active ? 'bg-ink text-white' : 'text-body hover:bg-mint/60')}>
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2 sm:ml-0 sm:gap-3">
            {account && <Link href="/billing" className="hidden sm:inline"><Badge variant={account.plan.key === 'trial' ? 'amber' : 'default'}>{t(`plan.${account.plan.key as 'trial'}`)}</Badge></Link>}
            {account?.plan.features.giftAutomation && wallet && (
              <Link href="/billing#wallet" className="hidden sm:inline" aria-label={`${t('w.title')}: ${money(wallet.balance, wallet.currency, locale)}`}>
                <Badge variant={wallet.balance === 0 ? 'amber' : 'neutral'}><Wallet className="mr-1 h-3.5 w-3.5" aria-hidden />{num(wallet.balance, locale)}</Badge>
              </Link>
            )}
            <LanguageToggle />
            <DropdownMenu>
              <DropdownMenuTrigger className={cn('flex min-h-[44px] items-center gap-2 rounded-xl border bg-white py-1.5 pl-1.5 pr-1.5 text-sm font-semibold sm:pr-3', inAccount ? 'border-ink' : 'border-line-2')} aria-label={t('app.account')}>
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-bold text-ink">{(account?.user.name ?? '?').slice(0, 1).toUpperCase()}</span>
                <span className="hidden max-w-[120px] truncate sm:inline">{account?.user.businessName ?? <Skeleton className="h-4 w-20" />}</span>
                <ChevronDown className="hidden h-4 w-4 opacity-60 sm:block" aria-hidden />
              </DropdownMenuTrigger>
              {/* Billing and Settings live here only (not in the menu bar). The plan and the wallet balance show in the bar from 640 px; on a phone they show here. */}
              <DropdownMenuContent align="end" className="min-w-[220px]">
                <DropdownMenuLabel className="sm:hidden">{account?.user.businessName}</DropdownMenuLabel>
                <DropdownMenuLabel className="font-normal text-muted-foreground">{account?.user.email}</DropdownMenuLabel>
                <DropdownMenuItem asChild className="min-h-[44px]">
                  <Link href="/billing"><CreditCard className="h-4 w-4" aria-hidden />{t('app.nav.billing')}
                    {account && <Badge className="ml-auto sm:hidden" variant={account.plan.key === 'trial' ? 'amber' : 'default'}>{t(`plan.${account.plan.key as 'trial'}`)}</Badge>}
                  </Link>
                </DropdownMenuItem>
                {account?.plan.features.giftAutomation && wallet && (
                  <DropdownMenuItem asChild className="min-h-[44px] sm:hidden">
                    <Link href="/billing#wallet"><Wallet className="h-4 w-4" aria-hidden />{t('w.title')}<Badge className="ml-auto" variant={wallet.balance === 0 ? 'amber' : 'neutral'}>{num(wallet.balance, locale)}</Badge></Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild className="min-h-[44px]"><Link href="/settings"><Settings className="h-4 w-4" aria-hidden />{t('app.nav.settings')}</Link></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="min-h-[44px]" onSelect={() => void signOut({ callbackUrl: '/' })}><LogOut className="h-4 w-4" aria-hidden />{t('app.signout')}</DropdownMenuItem>
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

      <main id="main" className="mx-auto max-w-[1344px] px-5 pb-28 pt-8 sm:px-8 sm:pb-20">{needsSegment ? <Skeleton className="h-64" /> : children}</main>
      <MobileNav showSimulator={showSimulator} />
      <WhatsAppRequiredDialog />
    </div>
  );
}
