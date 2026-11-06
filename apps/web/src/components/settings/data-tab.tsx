'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Download, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccount } from '@/lib/account';
import { ApiError, api, download, errorMessage } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n/client';

interface Status {
  deletionRequestedAt: string | null; deletionScheduledFor: string | null; graceDays: number;
  blockers: Array<{ code: 'wallet_balance' | 'gifts_in_flight' | 'payments_in_flight'; count?: number; amount?: number; currency?: string | null }>;
  retention: { financialYears: number; auditDays: number };
}

/** Settings, Your data (DAT-01): take everything out, or ask for the account to be erased, with the date and the way back. */
export function DataTab() {
  const t = useT();
  const locale = useLocale();
  const { mutate: refreshAccount } = useAccount();
  const { data, mutate } = useSWR<Status>('/account/data');
  const [busy, setBusy] = useState<'export' | 'delete' | 'cancel' | null>(null);
  const [word, setWord] = useState('');
  if (!data) return <Skeleton className="h-64" />;
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'long' });

  async function exportAll() {
    setBusy('export');
    try { await download('/account/export', 'surveyflow-account.json', { method: 'POST' }); toast.success(t('dt.exported')); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(null); }
  }
  async function requestDeletion() {
    setBusy('delete');
    try { await api('/account/delete', { method: 'POST', body: { confirm: 'DELETE' } }); setWord(''); await Promise.all([mutate(), refreshAccount()]); }
    catch (err) {
      if (err instanceof ApiError && err.code === 'account_delete_blocked') await mutate();
      toast.error(errorMessage(err, t));
    } finally { setBusy(null); }
  }
  async function cancel() {
    setBusy('cancel');
    try { await api('/account/delete/cancel', { method: 'POST' }); await Promise.all([mutate(), refreshAccount()]); toast.success(t('dt.cancelled')); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(null); }
  }
  const blockerText = (b: Status['blockers'][number]) =>
    b.code === 'wallet_balance' ? t('dt.b.wallet', { amount: `${b.amount} ${b.currency ?? ''}`.trim() }) : b.code === 'gifts_in_flight' ? t('dt.b.gifts', { n: b.count ?? 0 }) : t('dt.b.payments', { n: b.count ?? 0 });

  return (
    <div className="grid max-w-3xl gap-6">
      <Card>
        <CardHeader><CardTitle>{t('dt.exportTitle')}</CardTitle><CardDescription>{t('dt.exportText')}</CardDescription></CardHeader>
        <CardContent>
          <Button variant="outline" loading={busy === 'export'} onClick={exportAll} data-testid="dt-export"><Download className="h-4 w-4" aria-hidden />{t('dt.exportCta')}</Button>
          <p className="mt-3 text-xs text-muted-foreground">{t('dt.exportNote')}</p>
        </CardContent>
      </Card>

      <Card className={data.deletionScheduledFor ? 'border-red-200' : undefined}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5" aria-hidden />{t('dt.deleteTitle')}{data.deletionScheduledFor && <Badge variant="amber">{t('dt.scheduled')}</Badge>}</CardTitle>
          <CardDescription>{t('dt.deleteText', { days: data.graceDays })}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {data.deletionScheduledFor ? (
            <>
              <p className="rounded-xl bg-red-50 p-4 text-sm text-red-900" data-testid="dt-scheduled">{t('dt.scheduledOn', { date: date(data.deletionScheduledFor) })}</p>
              <div><Button loading={busy === 'cancel'} onClick={cancel} data-testid="dt-cancel">{t('dt.cancelCta')}</Button></div>
            </>
          ) : (
            <>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>{t('dt.l1')}</li><li>{t('dt.l2', { years: data.retention.financialYears })}</li><li>{t('dt.l3')}</li>
              </ul>
              {data.blockers.length > 0 && (
                <div className="rounded-xl border border-amber/40 bg-amber-soft p-4 text-sm text-amber-ink" data-testid="dt-blockers">
                  <p className="font-medium">{t('dt.blockedTitle')}</p>
                  <ul className="mt-1 list-disc pl-5">{data.blockers.map((b) => <li key={b.code}>{blockerText(b)}</li>)}</ul>
                </div>
              )}
              <Field label={t('dt.typeLabel')} htmlFor="dt-word" hint={t('dt.typeHint')}>
                <Input id="dt-word" value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" disabled={data.blockers.length > 0} />
              </Field>
              <div><Button variant="dark" loading={busy === 'delete'} disabled={word !== 'DELETE' || data.blockers.length > 0} onClick={requestDeletion} data-testid="dt-delete">{t('dt.deleteCta')}</Button></div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
