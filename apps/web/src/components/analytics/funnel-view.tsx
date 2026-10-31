'use client';
import { useState } from 'react';
import { Funnel, FunnelChart, LabelList, ResponsiveContainer, Tooltip } from 'recharts';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

export interface FunnelStep { key: string; label: string; count: number }

/**
 * The funnel as a Recharts funnel chart (FUT-05), with the plain bars one click away.
 *
 * Why both: a funnel is the right picture for "where do people drop off" with a handful of steps, and a poor one for exact counts over many (a long survey makes thin
 * slices); the bars read exactly. So the chart is the default and the bars are a switch, not a replacement. For anyone who cannot see a chart, a real table with the same
 * numbers (people, share of those invited, and the loss from the step before) is always in the page, hidden from the eye and not from a screen reader.
 *
 * The step that lost the most people, in relative terms, is drawn in amber in both views: it is what the drop-off alert next to it is about. Nothing is invented here:
 * the steps and their counts are exactly what the API returned.
 */
const GREEN = '#0F7A40';
const AMBER = '#E9A23B';

/** The step that lost the largest share of the people at the step before it; -1 when nobody was lost. Ties go to the earlier step. The first step has no step before it. */
export function worstStepIndex(counts: number[]): number {
  const lost = counts.map((c, i) => (i === 0 || counts[i - 1]! <= 0 ? 0 : (counts[i - 1]! - c) / counts[i - 1]!));
  const max = Math.max(0, ...lost);
  return max > 0 ? lost.indexOf(max) : -1;
}

export function FunnelView({ steps }: { steps: FunnelStep[] }) {
  const t = useT();
  const locale = useLocale();
  const [view, setView] = useState<'chart' | 'bars'>('chart');
  const first = Math.max(1, steps[0]?.count ?? 1);
  const worst = worstStepIndex(steps.map((s) => s.count));
  const pct = (n: number) => `${Math.round((n / first) * 100)}%`;
  const fmt = (n: number) => n.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-GB');
  const data = steps.map((s, i) => ({ name: s.label, value: s.count, fill: i === worst ? AMBER : GREEN, key: s.key, share: pct(s.count) }));
  const summary = steps.map((s) => `${s.label}: ${s.count}`).join(', ');

  return (
    <div data-testid="funnel" data-view={view}>
      <div className="mb-3 flex justify-end gap-1" role="group" aria-label={t('a.funnelView')}>
        {(['chart', 'bars'] as const).map((v) => (
          <button key={v} type="button" aria-pressed={view === v} data-testid={`funnel-view-${v}`} onClick={() => setView(v)}
            className={cn('rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors', view === v ? 'bg-ink text-white' : 'bg-muted text-body hover:bg-mint/60')}>
            {t(v === 'chart' ? 'a.funnelChart' : 'a.funnelBars')}
          </button>
        ))}
      </div>

      {view === 'chart' ? (
        <div role="img" aria-label={`${t('a.funnel')}. ${summary}`} data-testid="funnel-chart" style={{ height: Math.max(260, steps.length * 46) }}>
          <ResponsiveContainer width="100%" height="100%">
            <FunnelChart margin={{ top: 4, right: 130, bottom: 4, left: 4 }}>
              <Tooltip formatter={(v: number, _n, item) => [`${fmt(v)} (${(item?.payload as { share?: string })?.share ?? ''})`, t('a.funnelPeople')]} />
              <Funnel dataKey="value" data={data} isAnimationActive={false} stroke="#fff">
                <LabelList position="center" dataKey="value" fill="#fff" stroke="none" fontSize={13} fontWeight={700} />
                <LabelList position="right" dataKey="name" fill="#3F534A" stroke="none" fontSize={12} />
              </Funnel>
            </FunnelChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="funnel-bars">
          {steps.map((f, i) => (
            <div key={f.key} className="grid grid-cols-[120px_1fr_44px] items-center gap-3 text-sm">
              <span className="truncate font-medium">{f.label}</span>
              <div className="h-5 overflow-hidden rounded-md bg-muted" role="img" aria-label={`${f.count} / ${first}`}><div className="h-full rounded-md" style={{ width: `${(f.count / first) * 100}%`, background: i === worst ? AMBER : GREEN }} /></div>
              <span className="text-right font-bold tabular-nums">{f.count}</span>
            </div>
          ))}
        </div>
      )}

      <Table className="sr-only" data-testid="funnel-table">
        <caption>{t('a.funnel')}</caption>
        <THead><TR><TH>{t('a.funnelStep')}</TH><TH>{t('a.funnelPeople')}</TH><TH>{t('a.funnelShare')}</TH><TH>{t('a.funnelLost')}</TH></TR></THead>
        <TBody>
          {steps.map((s, i) => (
            <TR key={s.key}><TD>{s.label}</TD><TD>{s.count}</TD><TD>{pct(s.count)}</TD><TD>{i === 0 ? '' : Math.max(0, steps[i - 1]!.count - s.count)}</TD></TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
