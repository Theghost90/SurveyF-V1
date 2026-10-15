'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Check, CreditCard, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { PAID_PLAN_KEYS, PLANS, formatPhone, phoneExampleFor, type PaidPlanKey } from '@surveyflow/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { PageHeader } from '@/components/page-header';
import { planFeatures } from '@/components/marketing/pricing-client';
import { WalletCard } from '@/components/wallet/wallet-card';
import type { Account } from '@/lib/account';
import { ApiError, api, errorMessage } from '@/lib/api';
import { dateShort, money, num } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

type SubscriptionData = Account & {
  /** What this owner is charged in (their currency at the live rate; FCFA when no fresh rate exists: `fallback`). */
  currency: string;
  requestedCurrency: string;
  fallback: boolean;
  quote: { rate: number; asOf: string | null; source: string };
  /** Mobile Money only exists in CFA francs: every other currency pays by card. */
  methods: Array<'mobile_money' | 'card'>;
  overagePer100: number;
  prices: Record<PaidPlanKey, { monthly: number; annual: number; currency: string }>;
  invoices: Array<{ id: string; plan: string; interval: string; method: string; psp: string; amount: number; currency: string; paidAt: string | null; reference: string }>;
};

export function SubscriptionPage({ initialPlan, initialInterval }: { initialPlan?: string; initialInterval?: string }) {
  const t = useT();
  const locale = useLocale();
  const { data, mutate } = useSWR<SubscriptionData>('/subscription');
  const [interval, setInterval_] = useState<'monthly' | 'annual'>(initialInterval === 'annual' ? 'annual' : 'monthly');
  const [checkout, setCheckout] = useState<PaidPlanKey | null>(PAID_PLAN_KEYS.includes(initialPlan as PaidPlanKey) ? (initialPlan as PaidPlanKey) : null);
  const [busy, setBusy] = useState(false);

  if (!data) return <div className="grid gap-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-48" /><Skeleton className="h-96" /></div>;
  const { subscription: sub, usage, plan } = data;
  const rank: Record<string, number> = { trial: 0, starter: 1, growth: 2, business: 3 };
  const paid = sub.amountFCFA > 0 && ['active', 'past_due'].includes(sub.status);

  async function cancel(kind: 'cancel' | 'reactivate') {
    setBusy(true);
    try { await api(`/subscription/${kind}`, { method: 'POST' }); await mutate(); toast.success(t('common.saved')); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(false); }
  }
  const meters = [
    { label: t('dash.activeSurveys'), used: usage.activeSurveys, max: plan.limits.activeSurveys },
    { label: t('dash.responses'), used: usage.responses, max: plan.limits.responsesPerMonth },
    { label: t('dash.messages'), used: usage.messages, max: plan.limits.messagesPerMonth },
  ];

  return (
    <>
      <PageHeader title={t('bill.title')} sub={t('bill.sub')} />

      <Card className="mb-8">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-3">{t(`plan.${plan.key as 'trial'}`)} <Badge variant={sub.status === 'active' ? 'brand' : sub.status === 'trial' ? 'amber' : sub.status === 'past_due' ? 'warn' : 'danger'}>{t(`bill.st.${sub.status}` as 'bill.st.active')}</Badge></CardTitle>
            <CardDescription>
              {sub.status === 'trial' ? t('bill.trialUntil', { date: dateShort(sub.currentPeriodEnd, locale) })
                : paid ? t(sub.cancelAtPeriodEnd ? 'bill.endsOn' : 'bill.renewsOn', { date: dateShort(sub.currentPeriodEnd, locale) })
                : sub.amountFCFA === 0 ? t('bill.freeTier') : t('bill.endedOn', { date: dateShort(sub.currentPeriodEnd, locale) })}
            </CardDescription>
          </div>
          {paid && (sub.cancelAtPeriodEnd
            ? <Button variant="outline" loading={busy} onClick={() => cancel('reactivate')}>{t('bill.keep')}</Button>
            : <Button variant="ghost" loading={busy} onClick={() => cancel('cancel')}>{t('bill.cancel')}</Button>)}
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-3">
          {meters.map((m) => (
            <div key={m.label} className="flex flex-col gap-2">
              <span className="text-sm font-semibold text-body">{m.label}</span>
              <span className="font-display text-2xl font-extrabold">{num(m.used, locale)}<span className="text-base text-muted-foreground"> / {m.max === null ? '∞' : num(m.max, locale)}</span></span>
              <Progress value={m.used} max={m.max} label={m.label} />
            </div>
          ))}
          {usage.responseOverageFCFA > 0 && <p className="rounded-xl bg-amber-soft p-3 text-sm text-amber-ink sm:col-span-3">{t('dash.overage', { n: money(usage.responseOverage, usage.overageCurrency, locale) })} {t('bill.overageNote', { amount: money(data.overagePer100, data.currency, locale) })}</p>}
        </CardContent>
      </Card>

      <WalletCard canUse={!!plan.features.giftAutomation} phone={data.user.phone} />

      <div id="plans" className="mb-4 flex scroll-mt-24 flex-wrap items-end justify-between gap-3">
        <h2 className="text-2xl font-extrabold tracking-[-0.02em]">{t('bill.choose')}</h2>
        <div className="flex rounded-full border border-line-2 bg-white p-[3px] text-[13px] font-semibold" role="group" aria-label={t('pricing.billing')}>
          {(['monthly', 'annual'] as const).map((v) => <button key={v} type="button" aria-pressed={interval === v} onClick={() => setInterval_(v)} className={cn('min-h-[34px] rounded-full px-3', interval === v ? 'bg-ink text-white' : 'text-muted-foreground')}>{v === 'monthly' ? t('pricing.monthly') : t('pricing.annual')}</button>)}
        </div>
      </div>
      <FxNote data={data} />
      <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(290px,1fr))]">
        {PAID_PLAN_KEYS.map((key) => {
          const price = data.prices[key];
          const current = plan.key === key && paid;
          const lower = paid && rank[key]! < rank[plan.key]!;
          const featured = key === 'growth';
          return (
            <Card key={key} className={cn('flex flex-col gap-4 p-6', featured && 'border-2 border-brand')}>
              <div className="flex items-center justify-between"><h3 className="font-display text-2xl font-bold">{t(`plan.${key}`)}</h3>{current && <Badge variant="brand">{t('bill.current')}</Badge>}</div>
              <p className="text-sm text-muted-foreground">{t(`plan.${key}Who`)}</p>
              <div className="flex items-baseline gap-1.5"><span className="font-display text-4xl font-extrabold tracking-tight">{num(interval === 'annual' ? price.annual : price.monthly, locale)}</span><span className="text-sm text-muted-foreground">{price.currency === 'XAF' || price.currency === 'XOF' ? 'FCFA' : price.currency} / {interval === 'annual' ? t('bill.year') : t('bill.month')}</span></div>
              <Button size="lg" variant={featured ? 'brand' : 'default'} disabled={lower} onClick={() => setCheckout(key)}>{current ? t('bill.renew') : lower ? t('bill.lower') : t('bill.select')}</Button>
              <ul className="flex flex-col gap-2 text-sm">
                {planFeatures(key, t, locale).map((f) => <li key={f.text} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-leaf" strokeWidth={2.6} aria-hidden /><span>{f.text}{f.soon && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold text-muted-foreground">{t('pricing.soon')}</span>}</span></li>)}
              </ul>
            </Card>
          );
        })}
      </div>

      <h2 className="mb-4 mt-10 text-2xl font-extrabold tracking-[-0.02em]">{t('bill.invoices')}</h2>
      {data.invoices.length === 0 ? <Card className="p-8 text-center text-muted-foreground">{t('bill.noInvoices')}</Card> : (
        <Table>
          <THead><tr><TH>{t('common.created')}</TH><TH>{t('app.plan')}</TH><TH>{t('bill.method')}</TH><TH className="text-right">{t('bill.amount')}</TH></tr></THead>
          <TBody>{data.invoices.map((i) => <TR key={i.id}><TD>{i.paidAt ? dateShort(i.paidAt, locale) : '—'}</TD><TD>{t(`plan.${i.plan as 'starter'}`)} · {i.interval === 'annual' ? t('pricing.annual').split(' ·')[0] : t('pricing.monthly')}</TD><TD>{i.method === 'card' ? t('bill.card') : t('bill.momo')} · {i.psp}</TD><TD className="text-right font-semibold tabular-nums">{money(i.amount, i.currency, locale)}</TD></TR>)}</TBody>
        </Table>
      )}

      <CheckoutDialog plan={checkout} interval={interval} data={data} onClose={() => setCheckout(null)} />
    </>
  );
}

function CheckoutDialog({ plan, interval, data, onClose }: { plan: PaidPlanKey | null; interval: 'monthly' | 'annual'; data: SubscriptionData; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [method, setMethod] = useState<'mobile_money' | 'card'>(data.methods[0] ?? 'card');
  const [phone, setPhone] = useState(formatPhone(data.user.phone));
  const example = phoneExampleFor(data.user.country);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string } | null>(null);

  if (!plan) return null;
  const price = data.prices[plan];
  const amount = interval === 'annual' ? price.annual : price.monthly;

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const tx = await api<{ id: string; reference: string; checkoutUrl: string | null; paymentToken: string | null }>('/subscription/upgrade', { method: 'PUT', body: { plan, interval, method, phone: method === 'mobile_money' ? phone : undefined } });
      if (tx.checkoutUrl) { window.location.href = tx.checkoutUrl; return; }
      setPending({ id: tx.id });
      poll(tx.id);
    } catch (err) {
      setError(errorMessage(err, t));
      setBusy(false);
    }
  }
  // Push-to-phone payments (Campay): the payer approves on their handset; we poll the verified status.
  function poll(id: string, n = 0) {
    setTimeout(async () => {
      try {
        const s = await api<{ status: string }>(`/payments/${id}`);
        if (s.status === 'success') { window.location.href = `/billing/return?ref=${id}`; return; }
        if (s.status === 'failed' || s.status === 'expired' || n > 60) { setPending(null); setBusy(false); setError(t('bill.payFailed')); return; }
      } catch { /* keep polling */ }
      poll(id, n + 1);
    }, 3000);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader>
          <DialogTitle>{t('bill.checkout', { plan: t(`plan.${plan}`) })}</DialogTitle>
          <DialogDescription>{interval === 'annual' ? t('pricing.annual') : t('pricing.monthly')} · {money(amount, price.currency, locale)}</DialogDescription>
        </DialogHeader>
        {pending ? (
          <div role="status" className="flex flex-col items-center gap-3 py-6 text-center">
            <Smartphone className="h-10 w-10 text-leaf" aria-hidden />
            <p className="font-display text-xl font-bold">{t('bill.approve')}</p>
            <p className="text-sm text-muted-foreground">{t('bill.approveHelp', { phone })}</p>
          </div>
        ) : (
          <>
            <RadioGroup value={method} onValueChange={(v) => setMethod(v as typeof method)} aria-label={t('bill.method')}>
              {data.methods.includes('mobile_money') && <label className={cn('flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3.5 font-medium', method === 'mobile_money' ? 'border-leaf bg-mint/40' : 'border-line')}><RadioGroupItem value="mobile_money" /><Smartphone className="h-5 w-5 text-leaf" aria-hidden />{t('bill.momo')}</label>}
              <label className={cn('flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3.5 font-medium', method === 'card' ? 'border-leaf bg-mint/40' : 'border-line')}><RadioGroupItem value="card" /><CreditCard className="h-5 w-5 text-leaf" aria-hidden />{t('bill.card')}</label>
            </RadioGroup>
            {method === 'mobile_money' && <Field label={t('bill.momoPhone')} htmlFor="pay-phone" hint={t('bill.momoHint')}><Input id="pay-phone" type="tel" placeholder={example} value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" /></Field>}
            {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
            <DialogFooter><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button size="lg" variant="brand" loading={busy} onClick={pay}>{t('bill.pay', { amount: money(amount, price.currency, locale) })}</Button></DialogFooter>
            <p className="text-xs text-muted-foreground">{t('bill.secure')}</p>
            <FxNote data={data} compact />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Says how a non-FCFA price was made (live rate, card payment) or why prices are in FCFA although the owner's currency is another. */
function FxNote({ data, compact = false }: { data: SubscriptionData; compact?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const converted = data.currency !== 'XAF' && data.currency !== 'XOF';
  if (!converted && !data.fallback) return null;
  const date = data.quote.asOf ? dateShort(data.quote.asOf, locale) : '';
  return (
    <p className={cn('text-muted-foreground', compact ? 'text-xs' : 'mb-5 text-sm')} data-testid="fx-note">
      {converted
        ? <>{t('pricing.rate', { currency: data.currency, rate: new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', { maximumSignificantDigits: 4 }).format(data.quote.rate), date: date || '—' })} {t('pricing.card')}{' '}
            <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer" className="underline">{t('pricing.ratesBy')}</a></>
        : t('pricing.rateDown', { currency: data.requestedCurrency })}
    </p>
  );
}
