'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { Copy, MessageCircle, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';

interface BotState { included: boolean; available: boolean; platformPhone: string | null; maxPhones: number; phones: Array<{ id: string; phone: string; alerts: boolean; createdAt: string }> }
interface LinkCode { code: string; expiresAt: string; waLink: string }

/** Settings → Analytics on WhatsApp: link up to 3 phones with a one-time code, remove them, or (Explore) see what it is and where to try it. */
export function AnalyticsBotCard() {
  const t = useT();
  const { data, mutate } = useSWR<BotState>('/analytics-bot');
  const [code, setCode] = useState<LinkCode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return <Skeleton className="h-48" />;

  async function createCode() {
    setBusy('code');
    try { setCode(await api<LinkCode>('/analytics-bot/link-code', { method: 'POST' })); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(null); }
  }
  async function remove(id: string) {
    setBusy(id);
    try { await api(`/analytics-bot/phones/${id}`, { method: 'DELETE' }); toast.success(t('ab.removed')); await mutate(); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(null); }
  }
  async function setAlerts(id: string, alerts: boolean) {
    try { await api(`/analytics-bot/phones/${id}`, { method: 'PATCH', body: { alerts } }); await mutate(); }
    catch (err) { toast.error(errorMessage(err, t)); }
  }
  const message = code ? `LINK ${code.code}` : '';
  const full = data.phones.length >= data.maxPhones;

  return (
    <Card data-testid="analytics-bot-card">
      <CardHeader><CardTitle className="flex items-center gap-2"><MessageCircle className="h-5 w-5 text-leaf" aria-hidden />{t('ab.title')}</CardTitle><CardDescription>{t('ab.intro')}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-5">
        {!data.included ? (
          <div className="flex flex-col gap-3 rounded-xl bg-canvas p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="ab-locked">
            <p className="text-sm">{t('ab.locked')}</p>
            <div className="flex flex-wrap gap-2">
              <Link href="/simulator?mode=owner" className={buttonVariants({ variant: 'outline', size: 'sm' })}>{t('ab.seeIt')}</Link>
              <Link href="/billing" className={buttonVariants({ variant: 'brand', size: 'sm' })}>{t('ab.activate')}</Link>
            </div>
          </div>
        ) : !data.available ? <p className="rounded-xl bg-canvas p-4 text-sm text-muted-foreground">{t('ab.unavailable')}</p> : (
          <>
            <div>
              <h3 className="mb-2 text-sm font-bold">{t('ab.phones', { n: data.phones.length, max: data.maxPhones })}</h3>
              {data.phones.length === 0 ? <p className="text-sm text-muted-foreground">{t('ab.noPhones')}</p> : (
                <ul className="divide-y divide-line rounded-xl border border-line" data-testid="ab-phones">
                  {data.phones.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm">
                      <span className="font-semibold tabular-nums">{p.phone}</span>
                      <label className="ml-auto flex items-center gap-2 text-xs font-semibold text-muted-foreground"><Switch checked={p.alerts} onCheckedChange={(v) => void setAlerts(p.id, v)} aria-label={`${t('ab.alerts')} ${p.phone}`} />{t('ab.alerts')}</label>
                      <Button size="sm" variant="ghost" loading={busy === p.id} onClick={() => remove(p.id)} aria-label={`${t('ab.remove')} ${p.phone}`}><Trash2 className="h-4 w-4" aria-hidden />{t('ab.remove')}</Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {data.phones.length > 0 && <p className="-mt-3 text-xs text-muted-foreground">{t('ab.alertsHelp')}</p>}
            {code ? (
              <div className="flex flex-col gap-3 rounded-xl border border-line p-4" data-testid="ab-code">
                <p className="text-sm">{t('ab.step1', { phone: data.platformPhone ?? '' })}</p>
                <code className="w-fit select-all rounded-lg bg-ink px-3.5 py-2 text-lg font-bold tracking-wider text-white">{message}</code>
                <div className="flex flex-wrap gap-2">
                  <a href={code.waLink} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'brand', size: 'sm' })}>{t('ab.open')}</a>
                  <Button size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(message).then(() => toast.success(t('ab.copied')))}><Copy className="h-4 w-4" aria-hidden />{t('ab.copy')}</Button>
                </div>
                <p className="text-sm text-muted-foreground">{t('ab.step2')}</p>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button loading={busy === 'code'} disabled={full} onClick={createCode}>{t('ab.link')}</Button>
                {full && <span className="text-sm text-muted-foreground">{t('ab.linkFull', { max: data.maxPhones })}</span>}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('ab.why')}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
