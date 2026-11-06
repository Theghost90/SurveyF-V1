'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { api, errorMessage } from '@/lib/api';
import { dateShort, money } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';

interface Invoice { id: string; period: string; plan: string; allowance: number; responses: number; units: number; amountFCFA: number; status: string; dueAt: string; paidAt: string | null }
interface Overage { optIn: boolean; optInAt: string | null; per100: number; block: number; invoices: Invoice[] }

/** Responses beyond the plan (PAY-09): the owner's agreement, and the invoices to pay. Nothing is ever taken from the owner: they press Pay. */
export function OverageCard({ currency, methods }: { currency: string; methods: Array<'mobile_money' | 'card'> }) {
  const t = useT();
  const locale = useLocale();
  const { data, mutate } = useSWR<Overage>('/subscription/overage');
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const cur = currency === 'XAF' || currency === 'XOF' ? 'FCFA' : currency;

  async function toggle(on: boolean) {
    setBusy(true);
    try { await mutate(await api<Overage>('/subscription/overage', { method: 'PUT', body: { optIn: on } }), { revalidate: false }); } catch (err) { toast.error(errorMessage(err, t)); } finally { setBusy(false); }
  }
  async function pay(inv: Invoice) {
    setBusy(true);
    try {
      const tx = await api<{ checkoutUrl: string | null }>(`/subscription/overage/${inv.id}/pay`, { method: 'POST', body: { method: methods[0] ?? 'card' } });
      if (tx.checkoutUrl) { window.location.href = tx.checkoutUrl; return; }
      toast.message(t('ov.pay', { amount: money(inv.amountFCFA, 'XAF', locale) }));
    } catch (err) { toast.error(errorMessage(err, t) || t('ov.payFailed')); } finally { setBusy(false); }
  }

  return (
    <Card className="mt-8" data-testid="overage-card">
      <CardHeader>
        <CardTitle className="text-lg">{t('ov.title')}</CardTitle>
        <CardDescription>{t('ov.sub', { rate: `${data.per100.toLocaleString('en')} ${cur === 'FCFA' ? 'FCFA' : 'FCFA'}`, block: data.block })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label className="flex items-center gap-3 text-sm font-semibold"><Checkbox checked={data.optIn} disabled={busy} onCheckedChange={(v) => toggle(!!v)} data-testid="overage-optin" />{t('ov.agree')}</label>
        {data.optIn && data.optInAt && <p className="-mt-2 text-xs text-muted-foreground">{t('ov.agreed', { date: dateShort(data.optInAt, locale) })}</p>}
        {data.invoices.length === 0 ? <p className="text-sm text-muted-foreground">{t('ov.none')}</p> : (
          <ul className="divide-y divide-line text-sm">
            {data.invoices.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="overage-invoice">
                <div><div className="font-semibold">{t('ov.invoice', { period: dateShort(i.period, locale), over: i.responses - i.allowance, allowance: i.allowance })}</div>
                  <div className="text-xs text-muted-foreground">{i.status === 'paid' ? t('ov.paid') : t('ov.due', { date: dateShort(i.dueAt, locale) })} · {money(i.amountFCFA, 'XAF', locale)}</div></div>
                {i.status === 'paid' ? <Badge variant="brand">{t('ov.paid')}</Badge> : i.status === 'open' ? <Button size="sm" disabled={busy} onClick={() => pay(i)} data-testid="overage-pay">{t('ov.open')}</Button> : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
