'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { AlertTriangle, ArrowLeft, Download, Gift, Lightbulb, RefreshCw, Send, Trophy } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { questionTypeLabel } from '@surveyflow/shared';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { SurveyStatusBadge } from '@/components/status-badge';
import { useWallet } from '@/components/wallet/use-wallet';
import { ApiError, api, download, errorMessage } from '@/lib/api';
import { dateTime, money, num } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

interface Dist { label: string; count: number; pct: number }
interface Analytics {
  survey: { id: string; title: string; status: string; giftType: string };
  totals: { sent: number; started: number; completed: number; abandoned: number; declined: number; noReply: number; optedOut: number; inProgress: number; failed: number; queued: number; completionRate: number; responseRate: number; avgCompletionSeconds: number | null };
  funnel: Array<{ key: string; label: string; count: number }>;
  perQuestion: Array<{ id: string; number: number; text: string; type: string; answered: number; skipped: number; abandonedHere: number; distribution: Dist[]; average: number | null; texts: Array<{ answer: string; name: string; phone: string; answeredAt: string }> }>;
  dropOff: { questionNumber: number; questionText: string; count: number; suggestion: string } | null;
  nonStarters: Array<{ recipientId: string; name: string; phone: string; status: string; sentAt: string | null }>;
  gifts: { pending: number; sent: number; failed: number; unfunded: number };
  /** The manual "Remind" buttons follow the automatic window: who can be reminded right now, and when the others become eligible. */
  remind: { noReply: { eligibleNow: number; waiting: number; nextAt: string | null }; abandoned: { eligibleNow: number; waiting: number; nextAt: string | null } };
  generatedAt: string;
}
interface GiftMoney {
  items: Array<{ id: string; value: string | null; status: string; sentAt: string | null; contact: string; receiptUrl: string | null }>;
  /** The owner's wallet currency: every amount in `money` and `items` is in it. */
  currency: string;
  money: { sent: { count: number; amount: number }; inFlight: { count: number; amount: number }; unfunded: { count: number; amount: number }; failedRefunded: number; needsCheck: { count: number; amount: number } };
}
interface NotStartedPage { total: number; page: number; pageSize: number; items: Array<{ recipientId: string; name: string; phone: string; status: string; sentAt: string | null }> }
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
  const [nsPage, setNsPage] = useState(1);
  const { data: ns } = useSWR<NotStartedPage>(`/surveys/${id}/not-started?page=${nsPage}&pageSize=10`, { keepPreviousData: true, refreshInterval: 10_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const paidGift = data?.survey.giftType === 'airtime' || data?.survey.giftType === 'momo';
  const { data: giftData, mutate: mutateGifts } = useSWR<GiftMoney>(paidGift ? `/surveys/${id}/gifts` : null, { refreshInterval: 10_000 });
  const { wallet, mutate: mutateWallet } = useWallet();

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
      const r = await api<{ requeued: number; insufficient: number }>(`/surveys/${id}/gifts/retry`, { method: 'POST' });
      if (r.insufficient > 0) toast.warning(t('w.a.retriedPartial', { n: r.requeued, m: r.insufficient }));
      else toast.success(t('w.a.retried', { n: r.requeued }));
      await Promise.all([mutate(), mutateGifts(), mutateWallet()]);
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }
  async function releaseGifts() {
    setBusy('release');
    try {
      const r = await api<{ released: number; remaining: number }>(`/surveys/${id}/gifts/release`, { method: 'POST' });
      if (r.released === 0) toast.error(t('w.a.releaseNone'));
      else if (r.remaining > 0) toast.warning(t('w.a.releasePartial', { n: r.released, m: r.remaining }));
      else toast.success(t('w.a.released', { n: r.released }));
      await Promise.all([mutate(), mutateGifts(), mutateWallet()]);
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }
  // The wallet must cover at least the first waiting gift for "pay these gifts" to do anything.
  const unfundedUnit = giftData && giftData.money.unfunded.count > 0 ? Math.ceil(giftData.money.unfunded.amount / giftData.money.unfunded.count) : 0;
  const canRelease = !!wallet && unfundedUnit > 0 && wallet.balance >= unfundedUnit;

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
        {t('a.footnote', { completed: tt.completed, declined: tt.declined, optedOut: tt.optedOut, abandoned: tt.abandoned, progress: tt.inProgress, failed: tt.failed, time: fmtDur(tt.avgCompletionSeconds) })}
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
          <Card id="not-started" className="scroll-mt-24">
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <div><CardTitle>{t('a.didntStart', { n: tt.noReply })}</CardTitle><CardDescription>{t('a.didntStartSub')}</CardDescription></div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" loading={busy === 'no_reply'} disabled={data.remind.noReply.eligibleNow === 0 || data.survey.status !== 'active'} onClick={() => remind('no_reply')}><Send className="h-4 w-4" aria-hidden />{t('a.remindNoReply')}{data.remind.noReply.eligibleNow > 0 ? ` (${data.remind.noReply.eligibleNow})` : ''}</Button>
                <Button size="sm" variant="outline" loading={busy === 'abandoned'} disabled={data.remind.abandoned.eligibleNow === 0 || data.survey.status !== 'active'} onClick={() => remind('abandoned')}><RefreshCw className="h-4 w-4" aria-hidden />{t('a.remindAbandoned', { n: data.remind.abandoned.eligibleNow })}</Button>
              </div>
            </CardHeader>
            <CardContent>
              {/* Nobody is chased too soon: a reminder opens 3 business days after the invitation (2 after someone stops, 24 h for a live event). */}
              <p className="mb-3 text-sm text-muted-foreground" data-testid="remind-rule">{t('a.remindRule')}</p>
              {([['noReply', 'a.waitNoReply'], ['abandoned', 'a.waitAbandoned']] as const).map(([k, key]) => data.remind[k].waiting > 0 && (
                <p key={k} role="status" className="mb-2 rounded-xl bg-amber-soft px-3.5 py-2.5 text-sm text-amber-ink" data-testid={`remind-wait-${k}`}>
                  {data.remind[k].nextAt ? t(key, { n: data.remind[k].waiting, date: dateTime(data.remind[k].nextAt!, locale) }) : t('a.waitNever', { n: data.remind[k].waiting })}
                </p>
              ))}
              {!ns ? <Skeleton className="h-24" /> : ns.total === 0 ? <p className="text-sm text-muted-foreground">{t('a.everyoneReplied')}</p> : (
                <>
                  {/* The one place with the COMPLETE numbers; the WhatsApp bot shows names with masked numbers and links here. */}
                  <ul className="divide-y divide-line rounded-xl border border-line" data-testid="not-started-list">
                    {ns.items.map((n) => (
                      <li key={n.recipientId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 px-3.5 py-2.5 text-sm">
                        <span className="font-semibold">{n.name}</span>
                        <span className="tabular-nums text-muted-foreground">{n.phone}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">{t('a.nsShowing', { from: (ns.page - 1) * ns.pageSize + 1, to: Math.min(ns.total, ns.page * ns.pageSize), total: ns.total })}</span>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" disabled={nsPage <= 1} onClick={() => setNsPage(nsPage - 1)}>{t('common.prev')}</Button>
                      <Button size="sm" variant="outline" disabled={nsPage * ns.pageSize >= ns.total} onClick={() => setNsPage(nsPage + 1)}>{t('common.next')}</Button>
                      <Button size="sm" variant="outline" onClick={() => download(`/surveys/${id}/not-started.csv`, 'not-started.csv').catch((err) => toast.error(errorMessage(err, t)))}><Download className="h-4 w-4" aria-hidden />{t('a.nsDownload')}</Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {data.survey.giftType !== 'none' && data.survey.giftType !== 'custom' && (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Gift className="h-5 w-5 text-leaf" aria-hidden />{t('a.gifts')}</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap items-center gap-3">
                <Badge variant="brand">{t('a.giftsSent', { n: data.gifts.sent })}</Badge>
                <Badge variant="warn">{t('a.giftsPending', { n: data.gifts.pending })}</Badge>
                {data.gifts.unfunded > 0 && <Badge variant="warn">{t('w.a.unfundedBadge', { n: data.gifts.unfunded })}</Badge>}
                <Badge variant={data.gifts.failed ? 'danger' : 'neutral'}>{t('a.giftsFailed', { n: data.gifts.failed })}</Badge>
                {giftData && giftData.money.failedRefunded > 0 && <Badge variant="neutral">{t('w.a.refunded', { n: giftData.money.failedRefunded })}</Badge>}
                {giftData && giftData.money.needsCheck.count > 0 && <Badge variant="danger">{t('w.a.needsCheck', { n: giftData.money.needsCheck.count })}</Badge>}
                <div className="ml-auto flex gap-2">
                  {giftData && giftData.money.failedRefunded > 0 && <Button size="sm" variant="outline" loading={busy === 'gifts'} onClick={retryGifts}>{t('w.a.retry')}</Button>}
                  {data.survey.giftType === 'prize_draw' && <Button size="sm" loading={busy === 'draw'} onClick={draw}><Trophy className="h-4 w-4" aria-hidden />{t('a.draw')}</Button>}
                </div>
                {giftData && (
                  <p className="basis-full text-sm text-muted-foreground" data-testid="gift-spent">
                    {t('w.a.spent', { amount: money(giftData.money.sent.amount + giftData.money.inFlight.amount + giftData.money.needsCheck.amount, giftData.currency, locale) })}
                  </p>
                )}
                {giftData && giftData.items.some((g) => g.receiptUrl) && (
                  <div className="basis-full" data-testid="gift-receipts">
                    <h3 className="mb-2 text-sm font-bold">{t('a.giftReceipts')}</h3>
                    <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto scrollbar-thin">
                      {giftData.items.filter((g) => g.receiptUrl).slice(0, 25).map((g) => (
                        <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-canvas px-3.5 py-2.5 text-sm">
                          <span className="font-semibold">{g.contact}</span>
                          <span className="text-muted-foreground">{g.value}{g.sentAt ? ` · ${dateTime(g.sentAt, locale)}` : ''}</span>
                          {/* Present only for a gift that was really delivered: the API sends null otherwise. */}
                          <a href={g.receiptUrl!} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1.5 font-semibold text-leaf hover:underline"><Download className="h-4 w-4" aria-hidden />{t('a.receipt')}</a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {giftData && giftData.money.unfunded.count > 0 && (
                  <div role="alert" className="flex basis-full flex-wrap items-center gap-3 rounded-xl bg-amber-soft px-4 py-3 text-sm text-amber-ink" data-testid="gift-unfunded">
                    <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="flex-1">{t('w.a.unfunded', { n: giftData.money.unfunded.count })}</span>
                    {canRelease
                      ? <Button size="sm" variant="brand" loading={busy === 'release'} onClick={releaseGifts}>{t('w.a.release', { amount: money(giftData.money.unfunded.amount, giftData.currency, locale) })}</Button>
                      : <Link href="/billing#wallet" className={buttonVariants({ size: 'sm', variant: 'brand' })}>{t('w.a.topupFirst')}</Link>}
                  </div>
                )}
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
              <CardTitle className="text-lg">Q{q.number}. {q.text} <span className="whitespace-nowrap text-sm font-medium text-muted-foreground" data-testid="q-type">({questionTypeLabel(q.type, locale)})</span></CardTitle>
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
