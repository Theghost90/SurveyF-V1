'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { ArrowLeft, ExternalLink, FileSpreadsheet, FileText, Lock, RefreshCw, Sheet } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/page-header';
import { useAccount } from '@/lib/account';
import { ApiError, api, download, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';

interface Sync { enabled: boolean; autoSync?: boolean; spreadsheetUrl?: string; lastSyncedAt?: string | null; rowsSynced?: number }

export default function ExportPage({ params }: { params: { id: string } }) {
  const t = useT();
  const locale = useLocale();
  const { id } = params;
  const { account } = useAccount();
  const { data: survey } = useSWR<{ title: string }>(`/surveys/${id}`);
  const { data: google, mutate: refreshGoogle } = useSWR<{ configured: boolean; connected: boolean; email: string | null }>('/integrations/google');
  const { data: sync, mutate: refreshSync } = useSWR<Sync>(`/surveys/${id}/sync`);
  const [busy, setBusy] = useState<string | null>(null);
  const allowed = !!account?.plan.features.googleSheets;

  async function dl(kind: 'pdf' | 'excel') {
    setBusy(kind);
    try {
      await download(`/surveys/${id}/export/${kind}`, `surveyflow.${kind === 'pdf' ? 'pdf' : 'xlsx'}`);
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }
  async function connect() {
    setBusy('connect');
    try {
      const { url } = await api<{ url: string }>('/integrations/google/auth-url');
      sessionStorage.setItem('sf_google_return', `/surveys/${id}/export`);
      window.location.href = url;
    } catch (err) {
      toast.error(errorMessage(err, t));
      setBusy(null);
    }
  }
  async function runSync(autoSync: boolean) {
    setBusy('sync');
    try {
      await api(`/surveys/${id}/sync/google-sheets`, { body: { autoSync } });
      await refreshSync();
      toast.success(t('x.synced'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'google_reauth_required') void refreshGoogle();
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Link href={`/surveys/${id}/analytics`} className="mb-4 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden />{t('x.back')}</Link>
      <PageHeader title={t('x.title')} sub={survey?.title} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t('x.download')}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Button size="lg" variant="outline" className="h-14 justify-start" loading={busy === 'pdf'} onClick={() => dl('pdf')}><FileText className="h-5 w-5 text-leaf" aria-hidden />{t('x.pdf')}</Button>
              <p className="text-sm text-muted-foreground">{t('x.pdfText')}</p>
            </div>
            <div className="flex flex-col gap-2">
              <Button size="lg" variant="outline" className="h-14 justify-start" loading={busy === 'excel'} onClick={() => dl('excel')}><FileSpreadsheet className="h-5 w-5 text-leaf" aria-hidden />{t('x.excel')}</Button>
              <p className="text-sm text-muted-foreground">{t('x.excelText')}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Sheet className="h-5 w-5 text-leaf" aria-hidden />{t('x.sheets')}{!allowed && <Badge variant="neutral"><Lock className="h-3 w-3" aria-hidden />Growth</Badge>}</CardTitle>
            <CardDescription>{t('x.sheetsText')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!google || !sync ? <Skeleton className="h-24" /> : !allowed ? (
              <p className="rounded-xl bg-amber-soft p-4 text-sm text-amber-ink">{t('x.sheetsLocked')} <Link href="/billing" className="font-bold underline">{t('common.upgrade')}</Link></p>
            ) : !google.configured ? (
              <p className="rounded-xl bg-canvas p-4 text-sm text-muted-foreground">{t('x.sheetsNotConfigured')}</p>
            ) : !google.connected ? (
              <>
                <p className="rounded-xl bg-canvas p-4 text-sm text-body">{t('x.sheetsAuth')}</p>
                <Button loading={busy === 'connect'} onClick={connect} className="self-start">{t('x.connect')}</Button>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{t('x.connectedAs', { email: google.email ?? '' })}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" loading={busy === 'sync'} onClick={() => runSync(!!sync.autoSync)}><RefreshCw className="h-4 w-4" aria-hidden />{sync.enabled ? t('x.syncNow') : t('x.copyToSheets')}</Button>
                  {sync.spreadsheetUrl && <a href={sync.spreadsheetUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center gap-2 rounded-xl px-4 text-[15px] font-semibold text-leaf hover:underline">{t('x.openSheet')}<ExternalLink className="h-4 w-4" aria-hidden /></a>}
                </div>
                <label className="flex items-center justify-between gap-4 rounded-xl border border-line p-4 text-sm font-semibold">
                  <span>{t('x.autoSync')}<span className="block text-xs font-normal text-muted-foreground">{sync.lastSyncedAt ? t('x.lastSync', { time: dateTime(sync.lastSyncedAt, locale), n: sync.rowsSynced ?? 0 }) : t('x.autoSyncHint')}</span></span>
                  <Switch checked={!!sync.autoSync} disabled={busy === 'sync'} onCheckedChange={(v) => runSync(v)} aria-label={t('x.autoSync')} />
                </label>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>{t('x.alerts')}</CardTitle><CardDescription>{t('x.alertsText')}</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {(['x.daily', 'x.half'] as const).map((k) => (
              <label key={k} className="flex items-center justify-between gap-4 rounded-xl border border-line p-4 text-sm font-semibold opacity-70">
                <span>{t(k)}<Badge variant="neutral" className="ml-2">{t('common.soon')}</Badge></span>
                <Switch disabled aria-label={t(k)} />
              </label>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
