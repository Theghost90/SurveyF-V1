'use client';
import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAccount } from '@/lib/account';
import { api } from '@/lib/api';
import { dateShort, money } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';

/**
 * We ran out of patience while the provider has still not said yes or no. That is NOT a failure: the customer may be about to approve, or
 * already did. Saying "you have not been charged" here would be a guess, and a wrong one would make them pay twice.
 */
export function StillPending({ reference, onCheckAgain, onClose }: { reference: string; onCheckAgain: () => void; onClose?: () => void }) {
  const t = useT();
  return (
    <div role="status" data-testid="pay-waiting" className="flex flex-col items-center gap-3 py-6 text-center">
      <Clock className="h-10 w-10 text-leaf" aria-hidden />
      <p className="font-display text-xl font-bold">{t('bill.stillPending')}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{t('bill.stillPendingHelp', { ref: reference })}</p>
      <div className="flex gap-2">
        {onClose && <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>}
        <Button onClick={onCheckAgain}>{t('bill.checkAgain')}</Button>
      </div>
    </div>
  );
}

interface Row { id: string; reference: string; purpose: string; plan: string | null; interval: string; amount: number; currency: string; status: string; createdAt: string }

/** Payments the customer started that are not decided yet, so a closed tab or a slow provider never leaves them guessing (or paying twice). */
export function PaymentsInProgress() {
  const t = useT();
  const locale = useLocale();
  const { mutate: mutateAccount } = useAccount();
  const { mutate: mutateGlobal } = useSWRConfig();
  const { data, mutate } = useSWR<{ items: Row[] }>('/payments', { refreshInterval: 20_000 });
  const [checking, setChecking] = useState<string | null>(null);
  const rows = (data?.items ?? []).filter((p) => ['pending', 'review'].includes(p.status) && Date.now() - new Date(p.createdAt).getTime() < 3 * 86_400_000);
  if (!rows.length) return null;

  async function check(id: string) {
    setChecking(id);
    try {
      const s = await api<{ status: string }>(`/payments/${id}`);
      await mutate();
      if (s.status === 'success') { void mutateAccount(); void mutateGlobal('/subscription'); void mutateGlobal('/wallet'); }
    } catch { /* the network blinked: the list refreshes by itself */ }
    finally { setChecking(null); }
  }

  return (
    <Card className="mb-6 p-5" data-testid="pay-inprogress">
      <h2 className="text-lg font-extrabold">{t('bill.inProgress')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('bill.inProgressSub')}</p>
      <ul className="divide-y divide-line">
        {rows.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{p.purpose === 'gift_topup' ? t('w.title') : `${t(`plan.${(p.plan ?? 'starter') as 'starter'}`)} · ${p.interval === 'annual' ? t('pricing.annual').split(' ·')[0] : t('pricing.monthly')}`} · <span className="tabular-nums">{money(p.amount, p.currency, locale)}</span></p>
              <p className="text-xs text-muted-foreground">{dateShort(p.createdAt, locale)} · <code>{p.reference}</code></p>
              {p.status === 'review' && <p className="mt-1 text-sm">{t('bill.reviewHelp', { ref: p.reference })}</p>}
            </div>
            <Badge variant={p.status === 'review' ? 'warn' : 'amber'}>{t(p.status === 'review' ? 'bill.st.review' : 'bill.st.waiting')}</Badge>
            {p.status === 'pending' && <Button size="sm" variant="outline" loading={checking === p.id} onClick={() => check(p.id)}>{t('bill.checkNow')}</Button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
