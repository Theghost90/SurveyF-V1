'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { AlertTriangle, CalendarClock, Send } from 'lucide-react';
import { toast } from 'sonner';
import { TEMPLATE_NAMES } from '@surveyflow/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccount } from '@/lib/account';
import { api, errorMessage, ApiError } from '@/lib/api';
import { fcfa } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import { formatPhone } from '@surveyflow/shared';

interface ContactRow { id: string; name: string; phone: string; tags: string[]; optedOut: boolean }
interface Contacts { total: number; tags: string[]; items: ContactRow[] }
interface Accounts { items: Array<{ id: string; status: string; displayPhone: string | null; templates: Array<{ name: string; language: string; status: string }> }> }

export function SendPanel({ surveyId, status, language, onPublish, publishing, dirty }: { surveyId: string; status: string; language: string; onPublish: () => void; publishing: boolean; dirty: boolean }) {
  const t = useT();
  const locale = useLocale();
  const { account, mutate: refreshAccount } = useAccount();
  const [mode, setMode] = useState<'all' | 'select' | 'tags'>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [schedule, setSchedule] = useState(false);
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ queued: number } | null>(null);

  const { data: wa } = useSWR<Accounts>('/whatsapp/accounts');
  const { data: contacts } = useSWR<Contacts>(`/contacts?pageSize=100${search ? `&search=${encodeURIComponent(search)}` : ''}`, { keepPreviousData: true });
  const { data: all } = useSWR<Contacts>('/contacts?pageSize=1');

  const acct = wa?.items[0];
  const invitation = acct?.templates.find((x) => x.name === TEMPLATE_NAMES.invitation && x.language === language);
  const waProblem = !wa ? null : !acct ? 'none' : acct.status !== 'active' ? 'error' : invitation && invitation.status !== 'APPROVED' ? 'template' : null;

  const selection = useMemo(() => (mode === 'all' ? { all: true } : mode === 'select' ? { contactIds: [...selected] } : { tags: [...tags] }), [mode, selected, tags]);
  const empty = mode === 'select' ? selected.size === 0 : mode === 'tags' ? tags.size === 0 : false;
  // Exact count from the server: it knows who is already invited, opted out, or without consent.
  const { data: audience } = useSWR<{ eligible: number; messagesRemaining: number }>(status === 'active' && !empty ? [`/surveys/${surveyId}/audience`, JSON.stringify(selection), result?.queued ?? 0] : null, ([url]: [string]) => api(url, { body: selection }));
  const remaining = audience?.messagesRemaining ?? (account ? Math.max(0, account.plan.limits.messagesPerMonth - account.usage.messages) : null);
  const target = empty ? 0 : (audience?.eligible ?? 0);

  async function send() {
    setBusy(true);
    try {
      const res = await api<{ queued: number }>(`/surveys/${surveyId}/send`, { body: { ...selection, ...(schedule && when ? { scheduledAt: new Date(when).toISOString() } : {}) } });
      setResult(res);
      toast.success(t('b.send.queued', { n: res.queued }));
      void refreshAccount();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'plan_limit') toast.error(t('b.send.overQuota', { requested: err.details?.requested ?? '', remaining: err.details?.remaining ?? 0 }));
      else toast.error(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (set: Set<string>, id: string, fn: (s: Set<string>) => void) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); fn(n); };

  return (
    <Card id="send">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Send className="h-5 w-5 text-leaf" aria-hidden />{t('b.send.title')}</CardTitle>
        <CardDescription>{t('b.send.sub')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {status !== 'active' ? (
          <div className="flex flex-col items-start gap-3 rounded-2xl bg-canvas p-5">
            <p className="text-sm text-body">{status === 'draft' ? t('b.send.publishFirst') : t('b.send.notActive', { status: t(`status.${status}` as 'status.draft') })}</p>
            {status === 'draft' && <Button onClick={onPublish} loading={publishing}>{t('b.publish')}</Button>}
          </div>
        ) : !wa ? <Skeleton className="h-24" /> : (
          <>
            {waProblem && (
              <div role="alert" className="flex items-start gap-3 rounded-xl bg-amber-soft p-4 text-sm text-amber-ink">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{waProblem === 'none' ? t('b.send.noWa') : waProblem === 'error' ? t('b.send.waError') : t('b.send.tplPending')} <Link href="/settings?tab=whatsapp" className="font-bold underline">{t('b.send.fix')}</Link></span>
              </div>
            )}
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as typeof mode)} className="gap-2" aria-label={t('b.send.who')}>
              <label className={cn('flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-[15px] font-medium', mode === 'all' ? 'border-leaf bg-mint/40' : 'border-line')}><RadioGroupItem value="all" />{t('b.send.all', { n: all?.total ?? '…' })}</label>
              {contacts && contacts.tags.length > 0 && <label className={cn('flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-[15px] font-medium', mode === 'tags' ? 'border-leaf bg-mint/40' : 'border-line')}><RadioGroupItem value="tags" />{t('b.send.byTag')}</label>}
              <label className={cn('flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-[15px] font-medium', mode === 'select' ? 'border-leaf bg-mint/40' : 'border-line')}><RadioGroupItem value="select" />{t('b.send.select')}</label>
            </RadioGroup>

            {mode === 'tags' && contacts && (
              <div className="flex flex-wrap gap-2">
                {contacts.tags.map((tg) => (
                  <label key={tg} className={cn('flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold', tags.has(tg) ? 'border-leaf bg-mint' : 'border-line-2')}>
                    <Checkbox checked={tags.has(tg)} onCheckedChange={() => toggle(tags, tg, setTags)} />{tg}
                  </label>
                ))}
              </div>
            )}
            {mode === 'select' && (
              <div className="flex flex-col gap-2">
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('common.search')} aria-label={t('common.search')} />
                <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-xl border border-line scrollbar-thin">
                  {contacts?.items.map((c) => (
                    <li key={c.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm hover:bg-canvas">
                        <Checkbox checked={selected.has(c.id)} disabled={c.optedOut} onCheckedChange={() => toggle(selected, c.id, setSelected)} />
                        <span className="flex-1 font-medium">{c.name}</span>
                        <span className="text-muted-foreground">{formatPhone(c.phone)}</span>
                        {c.optedOut && <span className="text-xs font-bold text-destructive">STOP</span>}
                      </label>
                    </li>
                  ))}
                  {contacts?.items.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t('c.empty')}</li>}
                </ul>
                <div className="flex gap-2 text-sm"><Button size="sm" variant="outline" onClick={() => setSelected(new Set(contacts?.items.filter((c) => !c.optedOut).map((c) => c.id)))}>{t('b.send.selectAll')}</Button><Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{t('b.send.clear')}</Button></div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-3 text-sm font-semibold"><Checkbox checked={schedule} onCheckedChange={(v) => setSchedule(!!v)} /><CalendarClock className="h-4 w-4 text-leaf" aria-hidden />{t('b.send.schedule')}</label>
              {schedule && <Input type="datetime-local" value={when} min={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)} onChange={(e) => setWhen(e.target.value)} aria-label={t('b.send.schedule')} className="max-w-xs" />}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <p className="text-sm text-muted-foreground">
                {target === 0 && !empty && audience ? t('b.send.nobody') : remaining !== null && t('b.send.quota', { n: target, remaining: fcfa(remaining, locale) })}
              </p>
              <Button size="lg" onClick={send} loading={busy} disabled={!!waProblem || dirty || target === 0 || (schedule && !when)} className="h-12">
                <Send className="h-4 w-4" aria-hidden />{t('b.send.cta')}
              </Button>
            </div>
            {dirty && <p className="text-xs text-amber-ink">{t('b.send.saveFirst')}</p>}
            {result && <p role="status" className="rounded-xl bg-mint/60 p-3 text-sm font-semibold text-leaf">{t('b.send.queued', { n: result.queued })} <Link href={`/surveys/${surveyId}/analytics`} className="underline">{t('b.analytics')}</Link></p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
