'use client';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { FastForward, List as ListIcon, RefreshCw, Send } from 'lucide-react';
import { toast } from 'sonner';
import { TEMPLATE_DEFS, formatPhone, type OutboundMessage } from '@surveyflow/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/page-header';
import { OwnerSimulator } from '@/components/simulator-owner';
import { WaText } from '@/components/survey-builder/whatsapp-preview';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

interface ChatItem { id: string; at: string; direction: 'in' | 'out'; message?: OutboundMessage; template?: { name: string; language: string; bodyParams: string[]; buttonPayloads: string[]; urlParams?: string[] }; text?: string }
interface Snapshot { contact: { id: string; name: string; phone: string; optedOut: boolean }; chat: ChatItem[]; session: { surveyId: string; currentIndex: number } | null; recipients: Array<{ surveyId: string; title: string; status: string }> }

/** Plays the participant's phone against the real webhook code path (mock gateway only). */
export default function SimulatorPage() {
  const t = useT();
  const { data: contacts } = useSWR<{ items: Array<{ id: string; name: string; phone: string }> }>('/contacts?pageSize=100');
  const [who, setWho] = useState<'participant' | 'owner'>('participant');
  const [contactId, setContactId] = useState<string>('');
  const [text, setText] = useState('');
  const [listOpen, setListOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const { data: snap, error, mutate } = useSWR<Snapshot>(contactId ? `/dev/simulator/${contactId}` : null, { refreshInterval: 2500 });

  useEffect(() => { if (new URLSearchParams(window.location.search).get('mode') === 'owner') setWho('owner'); }, []);
  useEffect(() => { if (!contactId && contacts?.items[0]) setContactId(contacts.items[0].id); }, [contacts, contactId]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [snap?.chat.length]);

  async function send(body: object) {
    setBusy(true);
    try { await mutate(await api<Snapshot>(`/dev/simulator/${contactId}/send`, { body }), { revalidate: false }); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(false); }
  }
  async function act(path: string) {
    setBusy(true);
    try { await api(path, { method: 'POST' }); await mutate(); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(false); }
  }

  if (error instanceof ApiError && error.status === 404) return <Card className="p-8">{t('sim.unavailable')}</Card>;
  const template = (c: ChatItem) => {
    const def = TEMPLATE_DEFS.find((d) => d.name === c.template!.name && d.language === c.template!.language);
    const body = c.template!.bodyParams.reduce((s, v, i) => s.replace(`{{${i + 1}}}`, v), def?.body ?? c.template!.name);
    // URL buttons open the real link (the receipt PDF); through the site's proxy so the simulator works from the browser.
    const links = (def?.urlButtons ?? []).map((title, i) => ({ title, href: `/proxy/receipts/${c.template!.urlParams?.[i] ?? ''}` }));
    return { body, buttons: (def?.buttons ?? []).map((title, i) => ({ title, payload: c.template!.buttonPayloads[i] })), links };
  };
  const btn = 'rounded-lg bg-white py-2 text-center text-[13px] font-semibold text-[#0a7cc4] shadow-sm hover:bg-canvas disabled:opacity-60';

  return (
    <>
      <PageHeader title={t('sim.title')} sub={t('sim.sub')} actions={<Badge variant="amber">{t('common.demoOnly')}</Badge>} />
      <div className="mb-5 grid max-w-md grid-cols-2 gap-1 rounded-xl bg-canvas p-1" role="tablist" aria-label={t('sim.title')}>
        {(['participant', 'owner'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={who === k} onClick={() => setWho(k)} className={cn('min-h-[40px] rounded-lg px-3 text-sm font-bold', who === k ? 'bg-white text-ink shadow-sm' : 'text-muted-foreground hover:text-ink')}>{t(k === 'participant' ? 'sim.tabParticipant' : 'sim.tabOwner')}</button>
        ))}
      </div>
      {who === 'owner' ? <OwnerSimulator /> : null}
      {who === 'owner' ? null : !contacts ? <Skeleton className="h-96" /> : contacts.items.length === 0 ? <Card className="p-8 text-center text-muted-foreground">{t('sim.noContacts')}</Card> : (
        <div className="grid items-start gap-6 lg:grid-cols-[360px_1fr]">
          <div className="mx-auto w-full max-w-[360px] rounded-[34px] bg-ink p-2.5 shadow-phone">
            <div className="overflow-hidden rounded-[26px] bg-wa-bg">
              <div className="flex items-center gap-2.5 bg-wa-header px-4 py-3 text-white">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-xs font-bold">{(snap?.contact.name ?? '?').slice(0, 1)}</div>
                <div className="flex flex-col leading-tight"><span className="text-sm font-semibold">{snap?.contact.name ?? '…'}</span><span className="text-[11px] opacity-80">{snap ? formatPhone(snap.contact.phone) : ''}</span></div>
              </div>
              <div className="flex h-[480px] flex-col gap-2 overflow-y-auto px-3 py-3 scrollbar-thin" aria-live="polite" aria-label={t('sim.chat')}>
                {snap?.chat.length === 0 && <p className="mt-10 text-center text-xs text-muted-foreground">{t('sim.empty')}</p>}
                {snap?.chat.map((c) => c.direction === 'in' ? (
                  <div key={c.id} className="self-end max-w-[80%] rounded-[12px_4px_12px_12px] bg-wa-out px-3 py-2 text-[13px] shadow-sm">{c.text}</div>
                ) : c.template ? (
                  <div key={c.id} className="flex flex-col gap-1">
                    <div className="max-w-[88%] self-start rounded-[4px_12px_12px_12px] bg-white px-3 py-2 text-[13px] leading-[1.4] shadow-sm">{template(c).body}</div>
                    <div className="flex max-w-[88%] flex-col gap-1">{template(c).links.map((l) => <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className={cn(btn, 'text-center no-underline')}>{l.title}</a>)}</div>
                    <div className="flex max-w-[88%] gap-1">{template(c).buttons.map((b) => <button key={b.payload} type="button" disabled={busy} onClick={() => send({ type: 'template', payload: b.payload, title: b.title })} className={cn(btn, 'flex-1')}>{b.title}</button>)}</div>
                  </div>
                ) : c.message ? (
                  <div key={c.id} className="flex flex-col gap-1">
                    <div className="max-w-[88%] self-start rounded-[4px_12px_12px_12px] bg-white px-3 py-2 text-[13px] leading-[1.4] shadow-sm"><WaText text={c.message.body} /></div>
                    {c.message.kind === 'buttons' && <div className="flex max-w-[88%] flex-col gap-1">{c.message.buttons.map((b) => <button key={b.id} type="button" disabled={busy} onClick={() => send({ type: 'reply', id: b.id, title: b.title })} className={btn}>{b.title}</button>)}</div>}
                    {/* the same button as the template's URL button: opens the receipt, through the site's proxy */}
                    {c.message.kind === 'link' && <div className="flex max-w-[88%] flex-col gap-1"><a href={`/proxy/receipts/${c.message.url.split('/api/receipts/')[1] ?? ''}`} target="_blank" rel="noopener noreferrer" className={cn(btn, 'text-center no-underline')}>{c.message.buttonLabel}</a></div>}
                    {c.message.kind === 'list' && (
                      <>
                        <button type="button" onClick={() => setListOpen(listOpen === c.id ? null : c.id)} className={cn(btn, 'flex max-w-[88%] items-center justify-center gap-1.5')} aria-expanded={listOpen === c.id}><ListIcon className="h-3.5 w-3.5" aria-hidden />{c.message.buttonLabel}</button>
                        {listOpen === c.id && <ul className="max-w-[88%] divide-y divide-line overflow-hidden rounded-lg bg-white shadow-sm">{c.message.rows.map((r) => <li key={r.id}><button type="button" disabled={busy} onClick={() => { setListOpen(null); void send({ type: 'reply', id: r.id, title: r.title }); }} className="block w-full px-3 py-2 text-left text-[13px] hover:bg-canvas"><b>{r.title}</b>{r.description && <span className="block text-xs text-muted-foreground">{r.description}</span>}</button></li>)}</ul>}
                      </>
                    )}
                  </div>
                ) : null)}
                <div ref={bottom} />
              </div>
              <form className="flex items-center gap-2 bg-[#F0F2F5] p-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void send({ type: 'text', text }); setText(''); } }}>
                <label htmlFor="sim-text" className="sr-only">{t('sim.type')}</label>
                <Input id="sim-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('sim.type')} className="h-10 rounded-full" autoComplete="off" />
                <Button type="submit" size="icon" variant="brand" className="h-10 w-10 shrink-0 rounded-full" disabled={busy || !text.trim()} aria-label={t('sim.send')}><Send className="h-4 w-4" aria-hidden /></Button>
              </form>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <Card className="flex flex-col gap-4 p-6">
              <label className="text-sm font-semibold" htmlFor="sim-contact">{t('sim.participant')}</label>
              <Select value={contactId} onValueChange={setContactId}>
                <SelectTrigger id="sim-contact"><SelectValue /></SelectTrigger>
                <SelectContent>{contacts.items.map((c) => <SelectItem key={c.id} value={c.id}>{c.name} · {formatPhone(c.phone)}</SelectItem>)}</SelectContent>
              </Select>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={busy} onClick={() => act('/dev/jobs/run')}><RefreshCw className="h-4 w-4" aria-hidden />{t('sim.runQueue')}</Button>
                <Button variant="outline" size="sm" disabled={busy || !snap?.session} onClick={() => act(`/dev/simulator/${contactId}/expire`)}><FastForward className="h-4 w-4" aria-hidden />{t('sim.expire')}</Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('sim.help')}</p>
            </Card>
            <Card className="p-6">
              <h2 className="mb-3 font-display text-lg font-bold">{t('sim.status')}</h2>
              {snap?.recipients.length ? <ul className="flex flex-col gap-2">{snap.recipients.map((r) => <li key={r.surveyId} className="flex items-center justify-between gap-3 text-sm"><span className="font-semibold">{r.title}</span><Badge variant={r.status === 'completed' ? 'brand' : r.status === 'abandoned' ? 'warn' : 'neutral'}>{r.status}</Badge></li>)}</ul> : <p className="text-sm text-muted-foreground">{t('sim.notInvited')}</p>}
              {snap?.session && <p className="mt-3 text-xs text-muted-foreground">{t('sim.session', { n: snap.session.currentIndex + 1 })}</p>}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
