'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { BarChart3, Copy, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { PageHeader } from '@/components/page-header';
import { SurveyStatusBadge } from '@/components/status-badge';
import { ApiError, api, errorMessage } from '@/lib/api';
import { dateShort } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { useRouter } from 'next/navigation';

interface Row { id: string; title: string; status: string; sent: number; started: number; completed: number; questionCount: number; createdAt: string; language: string }

export default function SurveysPage() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { data, mutate } = useSWR<{ items: Row[] }>('/surveys');
  const [toDelete, setToDelete] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!toDelete) return;
    setBusy(true);
    try {
      await api(`/surveys/${toDelete.id}`, { method: 'DELETE' });
      toast.success(t('surveys.deleted'));
      setToDelete(null);
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }
  async function duplicate(id: string) {
    try {
      const copy = await api<{ id: string }>(`/surveys/${id}/duplicate`, { method: 'POST' });
      router.push(`/surveys/${copy.id}`);
    } catch (err) {
      toast.error(errorMessage(err, t));
    }
  }

  return (
    <>
      <PageHeader title={t('surveys.title')} sub={t('surveys.sub')} actions={<Link href="/surveys/new" className={buttonVariants({})}><Plus className="h-4 w-4" aria-hidden />{t('surveys.new')}</Link>} />
      {!data ? <Skeleton className="h-48" /> : data.items.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-12 text-center">
          <h2 className="text-2xl font-bold">{t('surveys.empty')}</h2>
          <p className="max-w-md text-muted-foreground">{t('dash.emptyHint')}</p>
          <Link href="/surveys/new" className={buttonVariants({})}>{t('surveys.new')}</Link>
        </Card>
      ) : (
        <>
        <ul className="flex flex-col gap-3 sm:hidden" data-testid="survey-cards">
          {data.items.map((s) => (
            <li key={s.id}>
              <Card className="relative p-4">
                <div className="flex items-start justify-between gap-3">
                  <SurveyStatusBadge status={s.status} />
                  <DropdownMenu>
                    <DropdownMenuTrigger className="relative z-10 -m-2 rounded-lg p-2 hover:bg-mint/60" aria-label={`${t('common.actions')}: ${s.title}`}><MoreHorizontal className="h-5 w-5" aria-hidden /></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild><Link href={`/surveys/${s.id}`}><Pencil className="h-4 w-4" aria-hidden />{t('surveys.open')}</Link></DropdownMenuItem>
                      {s.status !== 'draft' && <DropdownMenuItem asChild><Link href={`/surveys/${s.id}/analytics`}><BarChart3 className="h-4 w-4" aria-hidden />{t('surveys.analytics')}</Link></DropdownMenuItem>}
                      <DropdownMenuItem onSelect={() => void duplicate(s.id)}><Copy className="h-4 w-4" aria-hidden />{t('surveys.duplicate')}</DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onSelect={() => setToDelete(s)}><Trash2 className="h-4 w-4" aria-hidden />{t('common.delete')}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <Link href={s.status === 'draft' ? `/surveys/${s.id}` : `/surveys/${s.id}/analytics`} className="mt-2 block text-ink no-underline after:absolute after:inset-0 after:content-['']">
                  <span className="block font-display text-[17px] font-bold leading-snug">{s.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{t('surveys.questionsN', { n: s.questionCount })} · {s.language.toUpperCase()} · {dateShort(s.createdAt, locale)}</span>
                  <span className="mt-3 flex border-t border-line-3 pt-3">
                    <span className="flex-1"><b className="block font-display text-xl font-extrabold tabular-nums">{s.sent}</b><small className="text-xs text-muted-foreground">{t('surveys.col.sent')}</small></span>
                    <span className="flex-1"><b className="block font-display text-xl font-extrabold tabular-nums">{s.completed}</b><small className="text-xs text-muted-foreground">{t('surveys.col.completed')}</small></span>
                    <span className="flex-1"><b className="block font-display text-xl font-extrabold tabular-nums">{s.sent > 0 ? `${Math.round((s.completed / s.sent) * 100)}%` : '—'}</b><small className="text-xs text-muted-foreground">{t('surveys.col.rate')}</small></span>
                  </span>
                </Link>
              </Card>
            </li>
          ))}
        </ul>
        <div className="hidden sm:block">
        <Table>
          <THead><tr><TH>{t('surveys.col.title')}</TH><TH>{t('common.status')}</TH><TH className="text-right">{t('surveys.col.sent')}</TH><TH className="text-right">{t('surveys.col.completed')}</TH><TH>{t('common.created')}</TH><TH><span className="sr-only">{t('common.actions')}</span></TH></tr></THead>
          <TBody>
            {data.items.map((s) => (
              <TR key={s.id}>
                <TD>
                  <Link href={s.status === 'draft' ? `/surveys/${s.id}` : `/surveys/${s.id}/analytics`} className="font-semibold text-ink no-underline hover:text-leaf">{s.title}</Link>
                  <div className="text-xs text-muted-foreground">{t('surveys.questionsN', { n: s.questionCount })} · {s.language.toUpperCase()}</div>
                </TD>
                <TD><SurveyStatusBadge status={s.status} /></TD>
                <TD className="text-right tabular-nums">{s.sent}</TD>
                <TD className="text-right tabular-nums">{s.completed}</TD>
                <TD className="whitespace-nowrap text-muted-foreground">{dateShort(s.createdAt, locale)}</TD>
                <TD className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger className="rounded-lg p-2 hover:bg-mint/60" aria-label={`${t('common.actions')}: ${s.title}`}><MoreHorizontal className="h-5 w-5" aria-hidden /></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild><Link href={`/surveys/${s.id}`}><Pencil className="h-4 w-4" aria-hidden />{t('surveys.open')}</Link></DropdownMenuItem>
                      {s.status !== 'draft' && <DropdownMenuItem asChild><Link href={`/surveys/${s.id}/analytics`}><BarChart3 className="h-4 w-4" aria-hidden />{t('surveys.analytics')}</Link></DropdownMenuItem>}
                      <DropdownMenuItem onSelect={() => void duplicate(s.id)}><Copy className="h-4 w-4" aria-hidden />{t('surveys.duplicate')}</DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onSelect={() => setToDelete(s)}><Trash2 className="h-4 w-4" aria-hidden />{t('common.delete')}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
        </div>
        </>
      )}

      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader><DialogTitle>{t('surveys.deleteTitle')}</DialogTitle><DialogDescription>{t('surveys.deleteText')}</DialogDescription></DialogHeader>
          <p className="font-semibold">{toDelete?.title}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" loading={busy} onClick={remove}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
