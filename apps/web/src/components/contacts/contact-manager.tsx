'use client';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Plus, Tag, Trash2, Upload, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { formatPhone } from '@surveyflow/shared';
import { Badge } from '@/components/ui/badge';
import { useWhatsAppGate } from '@/components/whatsapp-gate';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { PageHeader } from '@/components/page-header';
import { api, errorMessage } from '@/lib/api';
import { dateShort } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { AddContactDialog, ImportDialog } from './contact-dialogs';

interface Contact { id: string; name: string; phone: string; tags: string[]; createdAt: string; consentAt: string | null; optedOut: boolean }
interface Page { total: number; page: number; pageSize: number; tags: string[]; items: Contact[] }
const ALL = '__all__';

export function ContactManager({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState(ALL);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const gate = useWhatsAppGate();
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [newTag, setNewTag] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { const id = setTimeout(() => { setQ(search); setPage(1); }, 300); return () => clearTimeout(id); }, [search]);
  const key = `/contacts?page=${page}&pageSize=25${q ? `&search=${encodeURIComponent(q)}` : ''}${tag !== ALL ? `&tag=${encodeURIComponent(tag)}` : ''}`;
  const { data, mutate } = useSWR<Page>(key, { keepPreviousData: true });
  const items = data?.items ?? [];
  const allSelected = items.length > 0 && items.every((c) => selected.has(c.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function bulk(kind: 'delete' | 'tag') {
    setBusy(true);
    try {
      const ids = [...selected];
      if (kind === 'delete') await api('/contacts/bulk-delete', { body: { ids } });
      else await api('/contacts/bulk-tag', { body: { ids, add: [newTag.trim()] } });
      toast.success(kind === 'delete' ? t('c.deleted', { n: ids.length }) : t('c.tagged', { n: ids.length }));
      setSelected(new Set()); setDelOpen(false); setTagOpen(false); setNewTag('');
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  const actions = (
    <>
      <Button variant="outline" onClick={() => gate.require() && setImportOpen(true)}><Upload className="h-4 w-4" aria-hidden />{t('c.import')}</Button>
      <Button onClick={() => gate.require() && setAddOpen(true)}><Plus className="h-4 w-4" aria-hidden />{t('c.add')}</Button>
    </>
  );

  return (
    <>
      {embedded ? <div className="mb-4 flex flex-wrap justify-end gap-2.5">{actions}</div> : <PageHeader title={t('c.title')} sub={t('c.sub')} actions={actions} />}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-[220px] flex-1 sm:max-w-sm"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('c.search')} aria-label={t('c.search')} type="search" /></div>
        {data && data.tags.length > 0 && (
          <div className="w-48">
            <Select value={tag} onValueChange={(v) => { setTag(v); setPage(1); }}>
              <SelectTrigger aria-label={t('c.tags')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('c.allTags')}</SelectItem>{data.tags.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        )}
        {selected.size > 0 && (
          <div className="ml-auto flex items-center gap-2 rounded-xl bg-ink px-3 py-1.5 text-sm font-semibold text-white" role="status">
            {t('c.selected', { n: selected.size })}
            <Button size="sm" variant="dark" onClick={() => setTagOpen(true)}><Tag className="h-4 w-4" aria-hidden />{t('c.addTag')}</Button>
            <Button size="sm" variant="dark" onClick={() => setDelOpen(true)}><Trash2 className="h-4 w-4" aria-hidden />{t('common.delete')}</Button>
          </div>
        )}
      </div>

      {!data ? <Skeleton className="h-64" /> : data.total === 0 && !q && tag === ALL ? (
        <Card className="flex flex-col items-center gap-3 p-12 text-center">
          <UserRound className="h-10 w-10 text-leaf" aria-hidden />
          <h2 className="text-2xl font-bold">{t('c.empty')}</h2>
          <p className="max-w-md text-muted-foreground">{t('c.emptyHint')}</p>
          <div className="flex gap-2">{actions}</div>
        </Card>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH className="w-10"><Checkbox checked={allSelected} onCheckedChange={(v) => setSelected(v ? new Set(items.map((c) => c.id)) : new Set())} aria-label={t('c.selectAll')} /></TH>
                <TH>{t('common.name')}</TH><TH>{t('common.phone')}</TH><TH>{t('c.tags')}</TH><TH>{t('common.status')}</TH><TH>{t('c.added')}</TH>
              </tr>
            </THead>
            <TBody>
              {items.map((c) => (
                <TR key={c.id}>
                  <TD><Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} aria-label={c.name} /></TD>
                  <TD className="font-semibold">{c.name}</TD>
                  <TD className="whitespace-nowrap tabular-nums">{formatPhone(c.phone)}</TD>
                  <TD><div className="flex flex-wrap gap-1">{c.tags.map((x) => <Badge key={x} variant="default">{x}</Badge>)}</div></TD>
                  <TD>{c.optedOut ? <Badge variant="danger">{t('c.optedOut')}</Badge> : c.consentAt ? <Badge variant="neutral">{t('c.consented')}</Badge> : <Badge variant="warn">{t('c.noConsent')}</Badge>}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{dateShort(c.createdAt, locale)}</TD>
                </TR>
              ))}
              {items.length === 0 && <TR><TD colSpan={6} className="py-10 text-center text-muted-foreground">{t('c.noMatch')}</TD></TR>}
            </TBody>
          </Table>
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('c.total', { n: data.total })}</span>
            {data.total > data.pageSize && (
              <div className="flex items-center gap-3">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('common.prev')}</Button>
                <span>{t('common.page', { n: page, total: Math.ceil(data.total / data.pageSize) })}</span>
                <Button size="sm" variant="outline" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>{t('common.next')}</Button>
              </div>
            )}
          </div>
        </>
      )}

      <AddContactDialog open={addOpen} onOpenChange={setAddOpen} onDone={() => void mutate()} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onDone={() => void mutate()} />

      <Dialog open={tagOpen} onOpenChange={setTagOpen}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader><DialogTitle>{t('c.addTag')}</DialogTitle><DialogDescription>{t('c.selected', { n: selected.size })}</DialogDescription></DialogHeader>
          <Field label={t('c.tag')} htmlFor="bulk-tag"><Input id="bulk-tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} maxLength={40} /></Field>
          <DialogFooter><Button variant="outline" onClick={() => setTagOpen(false)}>{t('common.cancel')}</Button><Button loading={busy} disabled={!newTag.trim()} onClick={() => bulk('tag')}>{t('common.add')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={delOpen} onOpenChange={setDelOpen}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader><DialogTitle>{t('c.deleteTitle', { n: selected.size })}</DialogTitle><DialogDescription>{t('c.deleteText')}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setDelOpen(false)}>{t('common.cancel')}</Button><Button variant="destructive" loading={busy} onClick={() => bulk('delete')}>{t('common.delete')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
