'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { AlertTriangle, ChevronDown, CreditCard, LogOut, Settings, Sparkles, Users, Wallet } from 'lucide-react';
import useSWR from 'swr';
import { Logo } from '@/components/logo';
import { LanguageToggle } from '@/components/language-toggle';
import { MobileNav } from '@/components/mobile-nav';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { DeletionBanner } from '@/components/deletion-banner';
import { VerifyBanner } from '@/components/verify-banner';
import { WhatsAppRequiredDialog } from '@/components/whatsapp-gate';
import { useWallet } from '@/components/wallet/use-wallet';
import { useAccount } from '@/lib/account';
import { dateShort, money, num } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import { currentWorkspace, setWorkspace } from '@/lib/workspace';
import { useEffect } from 'react';

export function AppShell({ children, showSimulator }: { children: React.ReactNode; showSimulator: boolean }) {
  const t = useT();
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const { account } = useAccount();
  const { wallet } = useWallet();
  // BIZ-04: a team member inside an owner's workspace sees the surveys (and, as an editor, the participants), never the owner's billing, wallet or connections.
  const member = account?.member;
  const { data: workspaces } = useSWR<{ items: Array<{ workspaceId: string; businessName: string; role: 'viewer' | 'editor' }> }>('/team/workspaces');
  const switchTo = (id: string | null) => { setWorkspace(id); window.location.assign('/dashboard'); };

  // The customer segment is the one required answer of setup. Anyone without it (new sign-up that skipped the wizard, or an
  // account created before this question existed) is taken to the onboarding step that asks it, and nowhere else until answered.
  const needsSegment = !!account && !account.user.segment && pathname !== '/onboarding';
  useEffect(() => { if (needsSegment) router.replace('/onboarding'); }, [needsSegment, router]);

  const nav = [
    { href: '/dashboard', label: t('app.nav.dashboard') },
    { href: '/surveys', label: t('app.nav.surveys') },
    ...(!member || member.role === 'editor' ? [{ href: '/contacts', label: t('app.nav.contacts') }] : []),
    ...(showSimulator && !member ? [{ href: '/simulator', label: t('app.nav.simulator') }] : []),
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
        <div className="mx-auto flex max-w-[1344px] items-center gap-x-3 px-4 py-3 short:py-1 sm:gap-x-3 sm:px-6 xl:gap-x-6 xl:px-8">
          {/* ONE row that fits in English and in French at every width, so it grows in steps (measured, see scripts/e2e-landscape.mjs):
              from 640 px logo mark, four links, language switch, account button (initial only); from 800 px the wordmark; from 1024 px the plan and wallet
              badges; from 1280 px the business name and roomier links. Below 340 px the wordmark gives way too (a folded phone is 280 px wide);
              on a short (landscape) screen the bar is slimmer. */}
          <Logo href="/dashboard" className="shrink-0 [&_span]:hidden min-[340px]:max-sm:[&_span]:inline min-[800px]:[&_span]:inline [&_span]:text-lg xl:[&_span]:text-xl [&_svg]:h-8 [&_svg]:w-8 short:[&_svg]:h-8 short:[&_svg]:w-8" />
          <nav aria-label={t('nav.main')} className="hidden min-w-0 sm:flex sm:flex-1 sm:gap-1">
            {nav.map((n) => {
              const active = pathname === n.href || pathname.startsWith(n.href + '/');
              return (
                <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined} className={cn('whitespace-nowrap rounded-xl px-2.5 py-2.5 text-sm font-semibold no-underline transition-colors short:py-2 xl:px-3.5 xl:text-[15px]', active ? 'bg-ink text-white' : 'text-body hover:bg-mint/60')}>
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0 sm:gap-3">
            {account && !member && <Link href="/billing" className="hidden lg:inline"><Badge variant={account.plan.key === 'trial' ? 'amber' : 'default'}>{t(`plan.${account.plan.key as 'trial'}`)}</Badge></Link>}
            {!member && account?.plan.features.giftAutomation && wallet && (
              <Link href="/billing#wallet" className="hidden lg:inline" aria-label={`${t('w.title')}: ${money(wallet.balance, wallet.currency, locale)}`}>
                <Badge variant={wallet.balance === 0 ? 'amber' : 'neutral'}><Wallet className="mr-1 h-3.5 w-3.5" aria-hidden />{num(wallet.balance, locale)}</Badge>
              </Link>
            )}
            <LanguageToggle className="[&_button]:px-2 min-[360px]:[&_button]:px-3" />
            <DropdownMenu>
              <DropdownMenuTrigger className={cn('flex min-h-[44px] items-center gap-2 rounded-xl border bg-white py-1.5 pl-1.5 pr-1.5 text-sm font-semibold short:min-h-[40px] short:py-1 xl:pr-3', inAccount ? 'border-ink' : 'border-line-2')} aria-label={t('app.account')}>
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-bold text-ink">{(account?.user.name ?? '?').slice(0, 1).toUpperCase()}</span>
                <span className="hidden max-w-[120px] truncate xl:inline">{account?.user.businessName ?? <Skeleton className="h-4 w-20" />}</span>
                <ChevronDown className="hidden h-4 w-4 opacity-60 xl:block" aria-hidden />
              </DropdownMenuTrigger>
              {/* Billing and Settings live here only (not in the menu bar). The plan and the wallet balance show in the bar from 1024 px, the business name from 1280 px; below that they show here. */}
              <DropdownMenuContent align="end" className="min-w-[220px]">
                <DropdownMenuLabel className="short:hidden xl:hidden">{account?.user.businessName}</DropdownMenuLabel>
                <DropdownMenuLabel className="font-normal text-muted-foreground">{account?.user.email}</DropdownMenuLabel>
                {!member && <DropdownMenuItem asChild className="min-h-[44px] short:min-h-[36px]">
                  <Link href="/billing"><CreditCard className="h-4 w-4" aria-hidden />{t('app.nav.billing')}
                    {account && <Badge className="ml-auto lg:hidden" variant={account.plan.key === 'trial' ? 'amber' : 'default'}>{t(`plan.${account.plan.key as 'trial'}`)}</Badge>}
                  </Link>
                </DropdownMenuItem>}
                {!member && account?.plan.features.giftAutomation && wallet && (
                  <DropdownMenuItem asChild className="min-h-[44px] short:min-h-[36px] lg:hidden">
                    <Link href="/billing#wallet"><Wallet className="h-4 w-4" aria-hidden />{t('w.title')}<Badge className="ml-auto" variant={wallet.balance === 0 ? 'amber' : 'neutral'}>{num(wallet.balance, locale)}</Badge></Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild className="min-h-[44px] short:min-h-[36px]"><Link href="/settings"><Settings className="h-4 w-4" aria-hidden />{t('app.nav.settings')}</Link></DropdownMenuItem>
                {(member || (workspaces?.items.length ?? 0) > 0) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('tm.workspaces')}</DropdownMenuLabel>
                    {member && <DropdownMenuItem className="min-h-[44px] short:min-h-[36px]" onSelect={() => switchTo(null)}><Users className="h-4 w-4" aria-hidden />{t('tm.mine')}</DropdownMenuItem>}
                    {workspaces?.items.filter((w) => w.workspaceId !== currentWorkspace()).map((w) => (
                      <DropdownMenuItem key={w.workspaceId} className="min-h-[44px] short:min-h-[36px]" onSelect={() => switchTo(w.workspaceId)}><Users className="h-4 w-4" aria-hidden />{w.businessName}<Badge className="ml-auto" variant="neutral">{t(`tm.role.${w.role}`)}</Badge></DropdownMenuItem>
                    ))}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="min-h-[44px] short:min-h-[36px]" onSelect={() => void signOut({ callbackUrl: '/' })}><LogOut className="h-4 w-4" aria-hidden />{t('app.signout')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {member && (
        <div role="status" data-testid="member-banner" className="border-b border-mint-2/50 bg-mint/50 text-sm text-ink">
          <div className="mx-auto flex max-w-[1344px] flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 sm:px-8">
            <Users className="h-4 w-4 text-leaf" aria-hidden />
            <span className="font-medium">{t('tm.banner', { business: account?.user.businessName ?? '', role: t(`tm.role.${member.role}`) })}</span>
            <button type="button" onClick={() => switchTo(null)} className={buttonVariants({ size: 'sm', variant: 'dark', className: 'ml-auto h-8 rounded-lg px-3 text-[13px]' })}>{t('tm.back')}</button>
          </div>
        </div>
      )}
      {account?.user.deletionScheduledFor && <DeletionBanner scheduledFor={account.user.deletionScheduledFor} />}
      {account && account.user.emailVerified === false && <VerifyBanner email={account.user.email} />}
      {banner && (
        <div role="status" className={cn('border-b text-sm', banner.tone === 'danger' ? 'border-red-200 bg-red-50 text-red-900' : banner.tone === 'warn' ? 'border-amber/40 bg-amber-soft text-amber-ink' : 'border-mint-2/50 bg-mint/50 text-ink')}>
          <div className="mx-auto flex max-w-[1344px] flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 sm:px-8">
            {banner.tone === 'info' ? <Sparkles className="h-4 w-4 text-leaf" aria-hidden /> : <AlertTriangle className="h-4 w-4" aria-hidden />}
            <span className="font-medium">{banner.text}</span>
            <Link href="/billing" className={buttonVariants({ size: 'sm', variant: banner.tone === 'info' ? 'default' : 'dark', className: 'ml-auto h-8 rounded-lg px-3 text-[13px]' })}>{banner.cta}</Link>
          </div>
        </div>
      )}

      <main id="main" className="mx-auto max-w-[1344px] px-5 pb-28 pt-8 short:pb-20 short:pt-4 sm:px-8 sm:pb-20">{needsSegment ? <Skeleton className="h-64" /> : children}</main>
      <MobileNav showSimulator={showSimulator} />
      <WhatsAppRequiredDialog />
    </div>
  );
}
