'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import {
  asOfLabel, botAlertMessage, botDropMessage, botResultsMessages, botHelpMessage, botListMessages, botStartedNote, botStatsMessage, exampleBotStats, maskPhone, toBotStats,
  type AnalyticsLike, type BotListKind, type BotListRow, type BotLocale, type OutboundMessage,
} from '@surveyflow/shared';
import { useAccount } from '@/lib/account';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import { Bubble } from './whatsapp-preview';

type Cmd = 'STATS' | 'RESULTS' | 'DROP' | 'NONRESP' | 'STARTED' | 'COMPLETED' | 'HELP' | 'ALERT';
const CMDS: Cmd[] = ['STATS', 'RESULTS', 'DROP', 'NONRESP', 'STARTED', 'COMPLETED', 'HELP', 'ALERT'];
const WORD: Record<BotLocale, Record<Cmd, string>> = {
  en: { STATS: 'STATS', RESULTS: 'RESULTS', ALERT: '🔔', DROP: 'DROP', NONRESP: 'NONRESP', STARTED: 'STARTED', COMPLETED: 'COMPLETED', HELP: 'HELP' },
  fr: { STATS: 'STATS', RESULTS: 'RÉSULTATS', ALERT: '🔔', DROP: 'ABANDONS', NONRESP: 'SANS RÉPONSE', STARTED: 'COMMENCÉS', COMPLETED: 'TERMINÉS', HELP: 'AIDE' },
};
const outBubble = 'self-end max-w-[80%] rounded-[12px_4px_12px_12px] bg-wa-out px-3 py-2 text-[13px] shadow-sm';

/** Fictional people for the example numbers: the real list needs real recipients. */
const EXAMPLE_ROWS: BotListRow[] = [
  { name: 'Aïcha', phone: maskPhone('+237677123401') }, { name: 'Jean-Paul', phone: maskPhone('+237699123402') }, { name: 'Mireille', phone: maskPhone('+237655123403') },
  { name: 'Brice', phone: maskPhone('+237670123404') }, { name: 'Nadège', phone: maskPhone('+237690123405') },
];

interface Props {
  title: string;
  questions: Array<{ text: string; type: string; required: boolean; options?: unknown[] | null }>;
  /** Present once the survey exists and has been sent: the preview then shows ITS live numbers. */
  surveyId?: string;
  /** Frame (phone chrome) is drawn by the caller; this renders chips + chat. */
  height?: number;
}
interface ListPage { total: number; items: Array<{ name: string; phone: string }> }
interface RespPage { total: number; items: Array<{ name: string; phone: string; status: string; abandonedAtQuestion: number | null }> }

/**
 * "Your analytics on WhatsApp": the owner's side of the chat, built by the SAME formatters the real bot answers with (shared/analytics-bot).
 * A draft (or a survey nobody was invited to) shows labelled example numbers built from its questions; a survey with invitations shows its live ones.
 */
export function OwnerChat({ title, questions, surveyId, height = 440 }: Props) {
  const t = useT();
  const locale = useLocale() as BotLocale;
  const { account } = useAccount();
  const [shown, setShown] = useState<Cmd[]>(['STATS']);
  const { data: live } = useSWR<AnalyticsLike & { totals: { sent: number } }>(surveyId ? `/surveys/${surveyId}/analytics` : null, { refreshInterval: 15_000, shouldRetryOnError: false });
  const isLive = !!live && live.totals.sent > 0;
  const { data: nonresp } = useSWR<ListPage>(isLive ? `/surveys/${surveyId}/not-started?pageSize=10` : null, { refreshInterval: 15_000 });
  const { data: resp } = useSWR<RespPage>(isLive ? `/surveys/${surveyId}/responses?pageSize=100` : null, { refreshInterval: 15_000 });
  const offset = -new Date().getTimezoneOffset();
  const asOf = asOfLabel(new Date(), offset);
  const stats = useMemo(() => (isLive ? toBotStats(live!) : exampleBotStats(title, questions)), [isLive, live, title, questions]);
  const openUrl = surveyId ? `/surveys/${surveyId}/analytics#not-started` : null;

  function reply(cmd: Cmd): OutboundMessage[] {
    if (cmd === 'HELP') return [botHelpMessage(locale)];
    if (cmd === 'STATS') return [botStatsMessage(stats, locale, asOf)];
    if (cmd === 'DROP') return [botDropMessage(stats, locale, asOf)];
    if (cmd === 'RESULTS') return botResultsMessages(stats, locale, asOf, openUrl);
    if (cmd === 'ALERT') return [botAlertMessage('milestone', { title: stats.title, n: 100, rate: stats.totals.completionRate }, locale)];
    const kind: BotListKind = cmd === 'NONRESP' ? 'nonresp' : cmd === 'STARTED' ? 'started' : 'completed';
    let rows: BotListRow[]; let total: number;
    if (!isLive) {
      rows = kind === 'nonresp' ? EXAMPLE_ROWS : kind === 'started' ? EXAMPLE_ROWS.slice(0, 3).map((r, i) => ({ ...r, note: botStartedNote(i < 2 ? 'abandoned' : 'started', Math.min(2 + i, Math.max(1, questions.length)), locale) })) : EXAMPLE_ROWS.slice(0, 4);
      total = kind === 'nonresp' ? stats.totals.noReply : kind === 'started' ? stats.totals.abandoned + stats.totals.inProgress : stats.totals.completed;
    } else if (kind === 'nonresp') {
      rows = (nonresp?.items ?? []).map((r) => ({ name: r.name, phone: maskPhone(r.phone) })); total = nonresp?.total ?? 0;
    } else {
      const want = kind === 'completed' ? ['completed'] : ['abandoned', 'started'];
      const mine = (resp?.items ?? []).filter((r) => want.includes(r.status));
      rows = mine.slice(0, 10).map((r) => ({ name: r.name, phone: r.phone, ...(kind === 'started' ? { note: botStartedNote(r.status, r.abandonedAtQuestion, locale) } : {}) }));
      total = kind === 'completed' ? stats.totals.completed : stats.totals.abandoned + stats.totals.inProgress;
    }
    return botListMessages(kind, stats.title, rows, total, 0, locale, asOf, openUrl);
  }
  const included = account?.plan.features.analyticsBot !== false;

  return (
    <div className="flex flex-col gap-3" data-testid="owner-chat">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('ab.pv.chips')}>
        {CMDS.map((c) => (
          <button key={c} type="button" onClick={() => setShown((s) => (s.at(-1) === c ? s : [...s, c].slice(-4)))} aria-label={c === 'ALERT' ? t('ab.pv.alert') : undefined} title={c === 'ALERT' ? t('ab.pv.alert') : undefined} className="min-h-[32px] rounded-full bg-white px-3 text-xs font-bold text-body ring-1 ring-line-2 hover:bg-mint/60">{WORD[locale][c]}</button>
        ))}
      </div>
      <div className="mx-auto w-full max-w-[330px] rounded-[34px] bg-ink p-2.5 shadow-phone">
        <div className="overflow-hidden rounded-[26px] bg-wa-bg">
          <div className="flex items-center gap-2.5 bg-wa-header px-4 py-3 text-white">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-leaf text-xs font-bold text-white">SF</div>
            <div className="flex flex-col leading-tight"><span className="text-sm font-semibold">SurveyFlow Analytics</span><span className="text-[11px] opacity-80">{t('b.pv.business')}</span></div>
          </div>
          <div className="flex flex-col gap-2 overflow-y-auto px-3 py-3 scrollbar-thin" style={{ height }} aria-live="polite">
            {shown.map((c, i) => (
              <div key={`${c}${i}`} className="flex flex-col gap-2">
                {c !== 'ALERT' && <div className={outBubble}>{WORD[locale][c]}</div>}
                {reply(c).map((m, j) => <Bubble key={j} message={m} />)}
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="text-center text-xs font-semibold" data-testid="owner-chat-note">
        {isLive ? t('ab.pv.live', { time: asOf }) : t('ab.pv.example')}
      </p>
      {!included && (
        <p className="rounded-xl bg-amber-soft px-3.5 py-2.5 text-center text-xs text-amber-ink" data-testid="owner-chat-locked">
          {t('ab.pv.locked')} <Link href="/billing" className="font-bold underline">{t('ab.activate')}</Link>
        </p>
      )}
    </div>
  );
}
