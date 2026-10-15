'use client';
import Link from 'next/link';
import useSWR from 'swr';
import { ArrowRight, Check, Circle, Plus } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/page-header';
import { SurveyStatusBadge } from '@/components/status-badge';
import { useAccount } from '@/lib/account';
import { dateShort, money, num } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';

interface SurveyRow { id: string; title: string; status: string; sent: number; completed: number; questionCount: number; createdAt: string }

export default function DashboardPage() {
  const t = useT();
  const locale = useLocale();
  const { account } = useAccount();
  const { data } = useSWR<{ items: SurveyRow[] }>('/surveys');

  if (!account) return <div className="grid gap-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;

  const { usage, plan, onboarding } = account;
  const meters = [
    { label: t('dash.activeSurveys'), used: usage.activeSurveys, max: plan.limits.activeSurveys },
    { label: t('dash.responses'), used: usage.responses, max: plan.limits.responsesPerMonth },
    { label: t('dash.messages'), used: usage.messages, max: plan.limits.messagesPerMonth },
  ];
  const steps = [
    { done: onboarding.whatsappConnected, label: t('dash.stepWhatsapp'), href: '/settings?tab=whatsapp' },
    { done: onboarding.hasContacts, label: t('dash.stepContacts'), href: '/contacts' },
    { done: onboarding.hasSurvey, label: t('dash.stepSurvey'), href: '/surveys/new' },
    { done: onboarding.paidPlan, label: t('dash.stepPlan'), href: '/billing' },
  ];
  const incomplete = steps.some((s) => !s.done);
  const recent = data?.items.slice(0, 5) ?? [];

  return (
    <>
      <PageHeader
        title={t('dash.hello', { name: account.user.name.split(' ')[0] ?? '' })}
        sub={t('dash.sub')}
        actions={<Link href="/surveys/new" className={buttonVariants({})}><Plus className="h-4 w-4" aria-hidden />{t('surveys.new')}</Link>}
      />

      <div className={incomplete ? 'grid gap-6 lg:grid-cols-[1.6fr_1fr]' : 'grid gap-6'}>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader className="flex-row items-baseline justify-between gap-3">
              <CardTitle>{t('dash.usage')}</CardTitle>
              <span className="text-sm text-muted-foreground">{t('dash.usageUntil', { date: dateShort(usage.periodEnd, locale) })}</span>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-3">
              {meters.map((m) => (
                <div key={m.label} className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-body">{m.label}</span>
                  <span className="font-display text-3xl font-extrabold tracking-tight">
                    {num(m.used, locale)}<span className="text-lg font-bold text-muted-foreground"> / {m.max === null ? '∞' : num(m.max, locale)}</span>
                  </span>
                  <Progress value={m.used} max={m.max} label={m.label} />
                </div>
              ))}
              {usage.responseOverageFCFA > 0 && <p className="rounded-xl bg-amber-soft p-3 text-sm text-amber-ink sm:col-span-3">{t('dash.overage', { n: money(usage.responseOverage, usage.overageCurrency, locale) })}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between"><CardTitle>{t('dash.recent')}</CardTitle><Link href="/surveys" className="text-sm font-semibold text-leaf hover:underline">{t('surveys.title')} <ArrowRight className="inline h-3.5 w-3.5" aria-hidden /></Link></CardHeader>
            <CardContent>
              {!data ? <Skeleton className="h-28" /> : recent.length === 0 ? (
                <div className="flex flex-col items-start gap-3 rounded-2xl bg-canvas p-6">
                  <p className="font-semibold">{t('dash.empty')}</p>
                  <p className="text-sm text-muted-foreground">{t('dash.emptyHint')}</p>
                  <Link href="/surveys/new" className={buttonVariants({ size: 'sm' })}>{t('surveys.new')}</Link>
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {recent.map((s) => (
                    <li key={s.id}>
                      <Link href={s.status === 'draft' ? `/surveys/${s.id}` : `/surveys/${s.id}/analytics`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3.5 no-underline hover:bg-canvas/60">
                        <span className="min-w-0 flex-1 truncate font-semibold">{s.title}</span>
                        <SurveyStatusBadge status={s.status} />
                        <span className="w-40 text-right text-sm text-muted-foreground">{s.sent} {t('dash.sent')} · {s.completed} {t('dash.completed')}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {incomplete && (
          <Card className="h-fit bg-ink text-white">
            <CardHeader><CardTitle className="text-white">{t('dash.checklist')}</CardTitle></CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-2.5">
                {steps.map((s) => (
                  <li key={s.label}>
                    <Link href={s.href} className="flex items-center gap-3 rounded-xl bg-ink-2 px-4 py-3.5 text-[15px] font-medium no-underline hover:bg-ink-3">
                      {s.done ? <Check className="h-5 w-5 text-brand" aria-hidden /> : <Circle className="h-5 w-5 text-brand-3" aria-hidden />}
                      <span className={s.done ? 'text-[#B5C9BD] line-through' : ''}>{s.label}</span>
                      {s.done && <span className="sr-only">{t('dash.done')}</span>}
                    </Link>
                  </li>
                ))}
              </ol>
              {!onboarding.done && <Link href="/onboarding" className={buttonVariants({ variant: 'brand', className: 'mt-5 w-full' })}>{t('app.finishSetup')}</Link>}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
