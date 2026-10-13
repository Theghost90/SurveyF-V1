'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { AlertTriangle, ArrowLeft, Download, Gift, Lightbulb, RefreshCw, Send, Trophy } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { SurveyStatusBadge } from '@/components/status-badge';
import { ApiError, api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

interface Dist { label: string; count: number; pct: number }
interface Analytics {
  survey: { id: string; title: string; status: string; giftType: string };
  totals: { sent: number; started: number; completed: number; abandoned: number; declined: number; noReply: number; inProgress: number; failed: number; queued: number; completionRate: number; responseRate: number; avgCompletionSeconds: number | null };
  funnel: Array<{ key: string; label: string; count: number }>;
  perQuestion: Array<{ id: string; number: number; text: string; type: string; answered: number; skipped: number; abandonedHere: number; distribution: Dist[]; average: number | null; texts: Array<{ answer: string; name: string; phone: string; answeredAt: string }> }>;
  dropOff: { questionNumber: number; questionText: string; count: number; suggestion: string } | null;
  nonStarters: Array<{ recipientId: string; name: string; phone: string; status: string; sentAt: string | null }>;
  gifts: { pending: number; sent: number; failed: number };
  generatedAt: string;
}
interface ResponsesPage { total: number; page: number; pageSize: number; questions: Array<{ id: string; number: number; text: string }>; items: Array<{ contactId: string; name: string; phone: string; status: string; completedAt: string | null; abandonedAtQuestion: number | null; answers: Record<string, string> }> }

const COLORS = ['#0F7A40', '#2BD46E', '#E9A23B', '#4CC584', '#0B2B22', '#9FD9B4', '#6B4A10', '#7BE0A0', '#12392E', '#C9D3CC'];

function Metric({ value, label, tone }: { value: React.ReactNode; label: string; tone?: 'brand' }) {
  return (
    <div className={cn('flex flex-col gap-1 rounded-2xl border p-5', tone === 'brand' ? 'border-transparent bg-ink text-white' : 'border-line bg-white')}>
      <span className="font-display text-[34px] font-extrabold leading-none tracking-tight tabular-nums">{value}</span>
      <span className={cn('text-sm font-semibold', tone === 'brand' ? 'text-[#B5C9BD]' : 'text-muted-foreground')}>{label}</span>
    </div>
  );
}

export function AnalyticsDashboard({ id }: { id: string }) {
  const t = useT();
  const locale = useLocale();
  const { data, error, mutate, isValidating } = useSWR<Analytics>(`/surveys/${id}/analytics`, { refreshInterval: 10_000 });
  const [page, setPage] = useState(1);
  const { data: rows } = useSWR<ResponsesPage>(`/surveys/${id}/responses?page=${page}&pageSize=10`, { keepPreviousData: true, refreshInterval: 10_000 });
  const [busy, setBusy] = useState<string | null>(null);

  if (error) return <Card className="p-8 text-center"><p className="mb-3">{errorMessage(error, t)}</p><Button onClick={() => mutate()}>{t('common.retry')}</Button></Card>;
  if (!data) return <div className="grid gap-4"><Skeleton className="h-14 w-96" /><div className="grid gap-4 sm:grid-cols-5"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div><Skeleton className="h-64" /></div>;

  const { totals: tt } = data;
  const fmtDur = (s: number | null) => (s === null ? '—' : s < 90 ? `${s}s` : `${Math.round(s / 60)} min`);

  async function remind(target: 'abandoned' | 'no_reply') {
    setBusy(target);
    try {
      const r = await api<{ queued: number }>(`/surveys/${id}/remind`, { body: { target } });
      toast.success(t('a.reminded', { n: r.queued }));
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }
  async function draw() {
    setBusy('draw');
    try {
      const r = await api<{ winner: { name: string; phone: string } }>(`/surveys/${id}/draw`, { method: 'POST' });
      toast.success(t('a.winner', { name: r.winner.name, phone: r.winner.phone }), { duration: 15_000 });
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }
  async function retryGifts() {
    setBusy('gifts');
    try {
      const r = await api<{ requeued: number }>(`/surveys/${id}/gifts/retry`, { method: 'POST' });
      toast.success(t('a.giftsRequeued', { n: r.requeued }));
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }
  const abandonedEligible = data.totals.abandoned;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link href={`/surveys/${id}`} className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden />{t('a.backToSurvey')}</Link>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground"><span className={cn('h-2 w-2 rounded-full bg-brand', isValidating && 'animate-pulse')} aria-hidden />{t('common.refreshing')}</span>
      </div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[clamp(26px,3vw,38px)] font-extrabold leading-tight tracking-[-0.03em]">{data.survey.title}</h1>
          <div className="mt-2 flex items-center gap-2"><SurveyStatusBadge status={data.survey.status} /><span className="text-sm text-muted-foreground">{t('a.updated', { time: dateTime(data.generatedAt, locale) })}</span></div>
        </div>
        <Link href={`/surveys/${id}/export`} className={buttonVariants({})}><Download className="h-4 w-4" aria-hidden />{t('a.export')}</Link>
      </div>

      <section aria-label={t('a.metrics')} className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]">
        <Metric value={tt.sent} label={t('a.sent')} />
        <Metric value={tt.started} label={t('a.started')} />
        <Metric value={`${tt.completionRate}%`} label={t('a.completionRate')} tone="brand" />
        <Metric value={tt.abandoned} label={t('a.abandoned')} />
        <Metric value={tt.noReply} label={t('a.noReply')} />
      </section>
      <p className="mt-3 text-xs text-muted-foreground">
        {t('a.footnote', { completed: tt.completed, declined: tt.declined, progress: tt.inProgress, failed: tt.failed, time: fmtDur(tt.avgCompletionSeconds) })}
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t('a.funnel')}</CardTitle><CardDescription>{t('a.funnelSub')}</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3">
            {data.funnel.map((f, i) => {
              const max = Math.max(1, data.funnel[0]?.count ?? 1);
              return (
                <div key={f.key} className="grid grid-cols-[120px_1fr_44px] items-center gap-3 text-sm">
                  <span className="truncate font-medium">{f.key === 'sent' ? t('a.f.sent') : f.key === 'started' ? t('a.f.started') : f.key === 'completed' ? t('a.f.completed') : t('a.f.answered', { n: f.key.slice(1) })}</span>
                  <div className="h-5 overflow-hidden rounded-md bg-muted" role="img" aria-label={`${f.count} / ${max}`}><div className="h-full rounded-md bg-leaf" style={{ width: `${(f.count / max) * 100}%`, opacity: 1 - i * 0.04 }} /></div>
                  <span className="text-right font-bold tabular-nums">{f.count}</span>
                </div>
              );
            })}
            {data.dropOff && (
              <div role="note" className="mt-2 flex gap-3 rounded-xl bg-amber-soft p-4 text-sm text-amber-ink">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <div>
                  <p className="font-bold">{t('a.dropAlert', { n: data.dropOff.count, q: data.dropOff.questionNumber })}</p>
                  <p>“{data.dropOff.questionText}”</p>
                  <p className="mt-1 flex items-start gap-1.5"><Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{t(`a.sug.${data.dropOff.suggestion}` as 'a.sug.shorten')}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <div><CardTitle>{t('a.didntStart', { n: tt.noReply })}</CardTitle><CardDescription>{t('a.didntStartSub')}</CardDescription></div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" loading={busy === 'no_reply'} disabled={tt.noReply === 0 || data.survey.status !== 'active'} onClick={() => remind('no_reply')}><Send className="h-4 w-4" aria-hidden />{t('a.remindNoReply')}</Button>
                <Button size="sm" variant="outline" loading={busy === 'abandoned'} disabled={abandonedEligible === 0 || data.survey.status !== 'active'} onClick={() => remind('abandoned')}><RefreshCw className="h-4 w-4" aria-hidden />{t('a.remindAbandoned', { n: abandonedEligible })}</Button>
              </div>
            </CardHeader>
            <CardContent>
              {data.nonStarters.length === 0 ? <p className="text-sm text-muted-foreground">{t('a.everyoneReplied')}</p> : (
                <ul className="flex max-h-44 flex-wrap gap-2 overflow-y-auto scrollbar-thin">
                  {data.nonStarters.map((n) => <li key={n.recipientId} className="rounded-full bg-canvas px-3 py-1.5 text-sm"><span className="font-semibold">{n.name}</span> <span className="text-muted-foreground">{n.phone}</span></li>)}
                </ul>
              )}
            </CardContent>
          </Card>

          {data.survey.giftType !== 'none' && data.survey.giftType !== 'custom' && (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Gift className="h-5 w-5 text-leaf" aria-hidden />{t('a.gifts')}</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap items-center gap-3">
                <Badge variant="brand">{t('a.giftsSent', { n: data.gifts.sent })}</Badge>
                <Badge variant="warn">{t('a.giftsPending', { n: data.gifts.pending })}</Badge>
                <Badge variant={data.gifts.failed ? 'danger' : 'neutral'}>{t('a.giftsFailed', { n: data.gifts.failed })}</Badge>
                <div className="ml-auto flex gap-2">
                  {data.gifts.failed > 0 && <Button size="sm" variant="outline" loading={busy === 'gifts'} onClick={retryGifts}>{t('a.retryGifts')}</Button>}
                  {data.survey.giftType === 'prize_draw' && <Button size="sm" loading={busy === 'draw'} onClick={draw}><Trophy className="h-4 w-4" aria-hidden />{t('a.draw')}</Button>}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <h2 className="mb-4 mt-10 text-2xl font-extrabold tracking-[-0.02em]">{t('a.results')}</h2>
      <div className="grid gap-6 lg:grid-cols-2">
        {data.perQuestion.map((q) => (
          <Card key={q.id} className="lg:[&:nth-child(odd):last-child]:col-span-2">
            <CardHeader>
              <CardTitle className="text-lg">Q{q.number}. {q.text}</CardTitle>
              <CardDescription>
                {t('a.answered', { n: q.answered })}{q.skipped > 0 && ` · ${t('a.skipped', { n: q.skipped })}`}{q.abandonedHere > 0 && ` · ${t('a.leftHere', { n: q.abandonedHere })}`}{q.average !== null && ` · ${t('a.average', { n: q.average })}`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {q.type === 'text' ? (
                q.texts.length === 0 ? <p className="text-sm text-muted-foreground">{t('a.noAnswers')}</p> : (
                  <ul className="flex flex-col gap-2">
                    {q.texts.slice(0, 6).map((x, i) => (
                      <li key={i} className="rounded-xl bg-canvas px-4 py-3 text-sm"><span>“{x.answer}”</span> <span className="text-muted-foreground">— {x.name} ({x.phone})</span></li>
                    ))}
                  </ul>
                )
              ) : q.distribution.length === 0 ? null : (
                <div className="h-[220px] w-full" role="img" aria-label={q.distribution.map((d) => `${d.label}: ${d.count} (${d.pct}%)`).join(', ')}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={q.distribution} layout={q.type === 'rating' ? 'horizontal' : 'vertical'} margin={{ left: 8, right: 32, top: 18, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E3E9E5" horizontal={q.type === 'rating'} vertical={q.type !== 'rating'} />
                      {q.type === 'rating' ? <><XAxis dataKey="label" tickLine={false} /><YAxis allowDecimals={false} width={28} /></> : <><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="label" width={120} tick={{ fontSize: 12 }} tickLine={false} /></>}
                      <Tooltip formatter={(v: number, _n, p) => [`${v} (${(p.payload as Dist).pct}%)`, '']} separator="" cursor={{ fill: 'rgba(15,122,64,0.06)' }} />
                      <Bar dataKey="count" radius={[4, 4, 4, 4]} isAnimationActive={false}>
                        {q.distribution.map((_, i) => <Cell key={i} fill={q.type === 'rating' ? '#E9A23B' : COLORS[i % COLORS.length]} />)}
                        <LabelList dataKey="count" position={q.type === 'rating' ? 'top' : 'right'} formatter={(v: number) => (v > 0 ? v : '')} style={{ fontSize: 12, fontWeight: 700, fill: '#0B2B22' }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <h2 className="mb-4 mt-10 text-2xl font-extrabold tracking-[-0.02em]">{t('a.responses')}</h2>
      {!rows ? <Skeleton className="h-40" /> : rows.items.length === 0 ? <Card className="p-8 text-center text-muted-foreground">{t('a.noResponses')}</Card> : (
        <>
          <Table className="min-w-[760px]">
            <THead><tr><TH>{t('common.name')}</TH><TH>{t('common.status')}</TH>{rows.questions.map((q) => <TH key={q.id} title={q.text}>Q{q.number}</TH>)}</tr></THead>
            <TBody>
              {rows.items.map((r) => (
                <TR key={r.contactId}>
                  <TD><div className="font-semibold">{r.name}</div><div className="text-xs text-muted-foreground">{r.phone}</div></TD>
                  <TD><Badge variant={r.status === 'completed' ? 'brand' : r.status === 'abandoned' ? 'warn' : 'neutral'}>{t(`a.st.${r.status}` as 'a.st.completed')}{r.status === 'abandoned' && r.abandonedAtQuestion ? ` Q${r.abandonedAtQuestion}` : ''}</Badge></TD>
                  {rows.questions.map((q) => <TD key={q.id} className="max-w-[220px] truncate">{r.answers[q.id] || <span className="text-muted-foreground">—</span>}</TD>)}
                </TR>
              ))}
            </TBody>
          </Table>
          {rows.total > rows.pageSize && (
            <div className="mt-3 flex items-center justify-between text-sm">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('common.prev')}</Button>
              <span className="text-muted-foreground">{t('common.page', { n: page, total: Math.ceil(rows.total / rows.pageSize) })} · {rows.total}</span>
              <Button size="sm" variant="outline" disabled={page * rows.pageSize >= rows.total} onClick={() => setPage(page + 1)}>{t('common.next')}</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
