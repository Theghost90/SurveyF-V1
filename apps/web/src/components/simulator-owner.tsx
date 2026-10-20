'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { List as ListIcon, Send } from 'lucide-react';
import { toast } from 'sonner';
import type { OutboundMessage } from '@surveyflow/shared';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { OwnerChat } from '@/components/survey-builder/bot-preview';
import { WaText } from '@/components/survey-builder/whatsapp-preview';
import { useAccount } from '@/lib/account';
import { api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

interface Item { id: string; direction: 'in' | 'out'; text?: string; message?: OutboundMessage; template?: { name: string; language: string; bodyParams: string[]; buttonPayloads: string[] } }
interface OwnerSnap { from: string; platformPhone: string | null; linked: boolean; chat: Item[] }

/** Sample questions for the Explore view, where there is no real data to answer from: a typical customer-satisfaction survey. */
const SAMPLE = [
  { text: 'How satisfied are you with our service?', type: 'button', required: true, options: [{ label: 'Very satisfied' }, { label: 'Neutral' }, { label: 'Unsatisfied' }] },
  { text: 'How likely are you to recommend us?', type: 'rating', required: true, options: null },
  { text: 'What could we do better?', type: 'text', required: false, options: null },
];
const btn = 'rounded-lg bg-white py-2 text-center text-[13px] font-semibold text-[#0a7cc4] shadow-sm hover:bg-canvas disabled:opacity-60';

/** The simulator's "Owner" side. Paid plans: the real bot, through the real webhook. Explore: the same answers with example numbers, plus how to get them. */
export function OwnerSimulator() {
  const t = useT();
  const { account } = useAccount();
  const included = account?.plan.features.analyticsBot === true;
  if (!account) return null;
  return included ? <LiveOwner /> : (
    <div className="mx-auto grid w-full max-w-[760px] gap-4" data-testid="sim-owner-explore">
      <Card className="flex flex-col gap-3 p-5">
        <Badge variant="amber" className="w-fit">{t('ab.pv.locked')}</Badge>
        <p className="text-sm">{t('ab.locked')}</p>
        <Link href="/billing" className={cn(buttonVariants({ variant: 'brand', size: 'sm' }), 'w-fit')}>{t('ab.activate')}</Link>
      </Card>
      <OwnerChat title="Customer Satisfaction" questions={SAMPLE} />
    </div>
  );
}

function LiveOwner() {
  const t = useT();
  const { data: snap, mutate } = useSWR<OwnerSnap>('/dev/owner', { refreshInterval: 2500 });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [snap?.chat.length]);

  async function send(body: { text?: string; replyId?: string }) {
    setBusy(true);
    try { await mutate(await api<OwnerSnap>('/dev/owner/send', { body }), { revalidate: false }); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(false); }
  }
  async function link() {
    setBusy(true);
    try { const r = await api<{ code: string }>('/analytics-bot/link-code', { method: 'POST' }); await send({ text: `LINK ${r.code}` }); }
    catch (err) { toast.error(errorMessage(err, t)); setBusy(false); }
  }

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[360px_1fr]" data-testid="sim-owner-live">
      <div className="mx-auto w-full max-w-[360px] rounded-[34px] bg-ink p-2.5 shadow-phone">
        <div className="overflow-hidden rounded-[26px] bg-wa-bg">
          <div className="flex items-center gap-2.5 bg-wa-header px-4 py-3 text-white">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-leaf text-xs font-bold">SF</div>
            <div className="flex flex-col leading-tight"><span className="text-sm font-semibold">SurveyFlow Analytics</span><span className="text-[11px] opacity-80">{snap?.platformPhone ? `+${snap.platformPhone}` : ''}</span></div>
          </div>
          <div className="flex h-[480px] flex-col gap-2 overflow-y-auto px-3 py-3 scrollbar-thin" aria-live="polite" aria-label={t('sim.chat')}>
            {snap?.chat.length === 0 && <p className="mt-10 text-center text-xs text-muted-foreground">{t(snap.linked ? 'sim.ownerEmptyLinked' : 'sim.ownerEmpty')}</p>}
            {snap?.chat.map((c) => c.direction === 'in' ? (
              <div key={c.id} className="max-w-[80%] self-end rounded-[12px_4px_12px_12px] bg-wa-out px-3 py-2 text-[13px] shadow-sm">{c.text}</div>
            ) : c.template ? (
              <div key={c.id} className="flex flex-col gap-1">
                {/* an alert sent OUTSIDE the 24 h window: the approved template, with its two quick replies */}
                <div className="max-w-[88%] self-start rounded-[4px_12px_12px_12px] bg-white px-3 py-2 text-[13px] leading-[1.4] shadow-sm">{c.template.language === 'fr' ? 'Alerte SurveyFlow : ' : 'SurveyFlow alert: '}{c.template.bodyParams[0]}{c.template.language === 'fr' ? ' Touchez STATS pour le résumé complet.' : ' Tap STATS for the full summary.'}</div>
                <div className="flex max-w-[88%] gap-1">{c.template.buttonPayloads.map((p, i) => <button key={p} type="button" disabled={busy} onClick={() => send({ replyId: p })} className={cn(btn, 'flex-1')}>{i === 0 ? 'STATS' : c.template!.language === 'fr' ? 'Couper les alertes' : 'Mute alerts'}</button>)}</div>
              </div>
            ) : c.message ? (
              <div key={c.id} className="flex flex-col gap-1">
                <div className="max-w-[88%] self-start rounded-[4px_12px_12px_12px] bg-white px-3 py-2 text-[13px] leading-[1.4] shadow-sm"><WaText text={c.message.body} /></div>
                {c.message.kind === 'buttons' && <div className="flex max-w-[88%] flex-col gap-1">{c.message.buttons.map((b) => <button key={b.id} type="button" disabled={busy} onClick={() => send({ replyId: b.id })} className={btn}>{b.title}</button>)}</div>}
                {c.message.kind === 'link' && <div className="flex max-w-[88%] flex-col gap-1"><a href={c.message.url} target="_blank" rel="noopener noreferrer" className={cn(btn, 'no-underline')}>{c.message.buttonLabel}</a></div>}
                {c.message.kind === 'list' && (
                  <>
                    <button type="button" onClick={() => setOpen(open === c.id ? null : c.id)} className={cn(btn, 'flex max-w-[88%] items-center justify-center gap-1.5')} aria-expanded={open === c.id}><ListIcon className="h-3.5 w-3.5" aria-hidden />{c.message.buttonLabel}</button>
                    {open === c.id && <ul className="max-w-[88%] divide-y divide-line overflow-hidden rounded-lg bg-white shadow-sm">{c.message.rows.map((r) => <li key={r.id}><button type="button" disabled={busy} onClick={() => { setOpen(null); void send({ replyId: r.id }); }} className="block w-full px-3 py-2 text-left text-[13px] hover:bg-canvas"><b>{r.title}</b>{r.description && <span className="block text-xs text-muted-foreground">{r.description}</span>}</button></li>)}</ul>}
                  </>
                )}
              </div>
            ) : null)}
            <div ref={bottom} />
          </div>
          <form className="flex items-center gap-2 bg-[#F0F2F5] p-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void send({ text }); setText(''); } }}>
            <label htmlFor="sim-owner-text" className="sr-only">{t('sim.type')}</label>
            <Input id="sim-owner-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('sim.type')} className="h-10 rounded-full" autoComplete="off" />
            <Button type="submit" size="icon" variant="brand" className="h-10 w-10 shrink-0 rounded-full" disabled={busy || !text.trim()} aria-label={t('sim.send')}><Send className="h-4 w-4" aria-hidden /></Button>
          </form>
        </div>
      </div>
      <Card className="flex flex-col gap-3 p-6">
        <h2 className="font-display text-lg font-bold">{t('ab.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('sim.ownerHelp')}</p>
        {snap && !snap.linked && <Button className="w-fit" loading={busy} onClick={link}>{t('sim.ownerLink')}</Button>}
        {snap?.linked && <Badge variant="brand" className="w-fit">{t('sim.ownerLinked')}</Badge>}
      </Card>
    </div>
  );
}
