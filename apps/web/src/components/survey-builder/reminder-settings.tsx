'use client';
import { BellRing, Info } from 'lucide-react';
import { EVENT_WINDOW_DAYS } from '@surveyflow/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import type { DraftErrors, SurveyDraft } from './types';

interface Props {
  draft: SurveyDraft;
  onChange: (d: SurveyDraft) => void;
  errors: DraftErrors;
  /** "UTC+1" style label of the owner's time zone, shown next to the deadline. */
  zone: string;
  /** Local calendar date today, YYYY-MM-DD, so the date picker cannot offer the past. */
  today: string;
}

/**
 * One switch per audience. Switching one ON shows exactly what SurveyFlow will send and when, in the owner's words: the rules are
 * fixed by the product (they exist so that nobody gets chased aggressively), the owner only decides whether to use them.
 */
function ReminderSwitch({ id, on, onChange, label, text, explain, note }: { id: string; on: boolean; onChange: (v: boolean) => void; label: string; text: string; explain: string; note: string }) {
  return (
    <div className={cn('rounded-2xl border p-4 transition-colors', on ? 'border-leaf bg-mint/30' : 'border-line')}>
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <label htmlFor={id} className="cursor-pointer text-[15px] font-bold">{label}</label>
          <p className="mt-0.5 text-sm text-muted-foreground">{text}</p>
        </div>
        <Switch id={id} checked={on} onCheckedChange={onChange} aria-label={label} />
      </div>
      {on && (
        <div role="status" className="mt-3 flex gap-2.5 rounded-xl bg-white/80 px-3.5 py-3 text-sm leading-snug text-body">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-leaf" aria-hidden />
          <div className="flex flex-col gap-1.5"><p>{explain}</p><p className="text-muted-foreground">{note}</p></div>
        </div>
      )}
    </div>
  );
}

export function ReminderSettings({ draft, onChange, errors, zone, today }: Props) {
  const t = useT();
  const set = (patch: Partial<SurveyDraft>) => onChange({ ...draft, ...patch });
  const event = draft.kind === 'event';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><BellRing className="h-5 w-5 text-leaf" aria-hidden />{t('b.rem.title')}</CardTitle>
        <CardDescription>{t('b.rem.sub')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">{t('b.rem.kind')}</legend>
          <RadioGroup value={draft.kind} onValueChange={(v) => set({ kind: v as 'general' | 'event' })} aria-label={t('b.rem.kind')} className="gap-2 sm:grid-cols-2">
            {(['general', 'event'] as const).map((k) => (
              <label key={k} className={cn('flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3', draft.kind === k ? 'border-leaf bg-mint/40' : 'border-line')}>
                <RadioGroupItem value={k} className="mt-1" />
                <span className="flex flex-col"><span className="text-[15px] font-medium">{t(k === 'general' ? 'b.rem.general' : 'b.rem.event')}</span><span className="text-xs text-muted-foreground">{t(k === 'general' ? 'b.rem.generalText' : 'b.rem.eventText')}</span></span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>

        <Field label={t(event ? 'b.rem.deadlineEvent' : 'b.rem.deadlineOpt')} htmlFor="deadline" hint={t('b.rem.deadlineHint', { zone })} error={errors.deadline}>
          <Input id="deadline" type="date" min={today} value={draft.deadline} onChange={(e) => set({ deadline: e.target.value })} aria-invalid={!!errors.deadline} className="max-w-[240px]" />
        </Field>
        {event && <p className="-mt-3 text-xs text-muted-foreground">{t('b.rem.deadlineRule', { n: EVENT_WINDOW_DAYS })}</p>}

        <div className="flex flex-col gap-3">
          <ReminderSwitch
            id="auto-nonresp" on={draft.autoRemindNonResponders} onChange={(v) => set({ autoRemindNonResponders: v })}
            label={t('b.rem.nonResp')} text={t('b.rem.nonRespText')} explain={t('b.rem.nonRespOn')} note={t('b.rem.nonRespNote')}
          />
          <ReminderSwitch
            id="auto-aband" on={draft.autoRemindAbandoners} onChange={(v) => set({ autoRemindAbandoners: v })}
            label={t('b.rem.aband')} text={t('b.rem.abandText')} explain={t('b.rem.abandOn')} note={t('b.rem.abandNote')}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('b.rem.rules')}</p>
      </CardContent>
    </Card>
  );
}
