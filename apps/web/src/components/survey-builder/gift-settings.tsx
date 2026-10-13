'use client';
import Link from 'next/link';
import { Gift, Lock } from 'lucide-react';
import type { GiftType } from '@surveyflow/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import type { DraftErrors, SurveyDraft } from './types';

const OPTIONS: Array<{ value: GiftType; key: 'b.gift.none' | 'b.gift.airtime' | 'b.gift.momo' | 'b.gift.discount' | 'b.gift.draw' | 'b.gift.custom'; auto: boolean }> = [
  { value: 'none', key: 'b.gift.none', auto: false },
  { value: 'airtime', key: 'b.gift.airtime', auto: true },
  { value: 'momo', key: 'b.gift.momo', auto: true },
  { value: 'discount', key: 'b.gift.discount', auto: true },
  { value: 'prize_draw', key: 'b.gift.draw', auto: true },
  { value: 'custom', key: 'b.gift.custom', auto: false },
];

export function GiftSettings({ draft, onChange, errors, canAutomate }: { draft: SurveyDraft; onChange: (d: SurveyDraft) => void; errors: DraftErrors; canAutomate: boolean }) {
  const t = useT();
  const g = draft.gift;
  const set = (patch: Partial<SurveyDraft['gift']>) => onChange({ ...draft, gift: { ...g, ...patch } });
  const money = g.giftType === 'airtime' || g.giftType === 'momo';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Gift className="h-5 w-5 text-leaf" aria-hidden />{t('b.gift.title')}</CardTitle>
        <CardDescription>{t('b.gift.sub')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <RadioGroup value={g.giftType} onValueChange={(v) => set({ giftType: v as GiftType })} aria-label={t('b.gift.type')} className="grid-cols-1 gap-2 sm:grid-cols-2">
          {OPTIONS.map((o) => {
            const locked = o.auto && !canAutomate;
            return (
              <label key={o.value} className={cn('flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-[15px] font-medium', g.giftType === o.value ? 'border-leaf bg-mint/40' : 'border-line', locked && 'cursor-not-allowed opacity-60')}>
                <RadioGroupItem value={o.value} disabled={locked} />
                <span className="flex-1">{t(o.key)}</span>
                {locked && <Lock className="h-4 w-4 text-muted-foreground" aria-label={t('b.gift.locked')} />}
              </label>
            );
          })}
        </RadioGroup>
        {!canAutomate && (
          <p className="rounded-xl bg-amber-soft px-4 py-3 text-sm text-amber-ink">
            {t('b.gift.upgrade')} <Link href="/billing" className="font-bold underline">{t('common.upgrade')}</Link>
          </p>
        )}

        {g.giftType !== 'none' && (
          <div className="grid gap-4 sm:grid-cols-2">
            {g.giftType !== 'custom' && (
              <Field label={t('b.gift.value')} htmlFor="giftValue" hint={t('b.gift.valueHint')} error={errors.gift.giftValue} className={money ? '' : 'sm:col-span-2'}>
                <Input id="giftValue" value={g.giftValue} onChange={(e) => set({ giftValue: e.target.value })} maxLength={120} placeholder={g.giftType === 'discount' ? '10% off your next order' : g.giftType === 'prize_draw' ? 'a smartphone' : '500 MB MTN data bundle'} aria-invalid={!!errors.gift.giftValue} />
              </Field>
            )}
            {money && (
              <Field label={t('b.gift.amount')} htmlFor="giftAmount" hint={t('b.gift.amountHint')} error={errors.gift.giftAmountFCFA}>
                <Input id="giftAmount" type="number" inputMode="numeric" min={100} max={20000} step={50} value={g.giftAmountFCFA} onChange={(e) => set({ giftAmountFCFA: e.target.value })} aria-invalid={!!errors.gift.giftAmountFCFA} />
              </Field>
            )}
            {money && (
              <fieldset className="flex flex-col gap-2 sm:col-span-2">
                <legend className="mb-1 text-sm font-semibold">{t('b.gift.delivery')}</legend>
                <RadioGroup value={g.giftDeliveryMode} onValueChange={(v) => set({ giftDeliveryMode: v as 'immediate' | 'batch' })} className="gap-2 sm:grid-cols-2">
                  {(['immediate', 'batch'] as const).map((m) => (
                    <label key={m} className={cn('flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium', g.giftDeliveryMode === m ? 'border-leaf bg-mint/40' : 'border-line')}>
                      <RadioGroupItem value={m} />{t(m === 'immediate' ? 'b.gift.immediate' : 'b.gift.batch')}
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>
            )}
            {g.giftType !== 'custom' && (
              <Field label={t('b.gift.max')} htmlFor="giftMax" hint={t('b.gift.maxHint')} error={errors.gift.giftMaxCount}>
                <Input id="giftMax" type="number" inputMode="numeric" min={1} value={g.giftMaxCount} onChange={(e) => set({ giftMaxCount: e.target.value })} placeholder={t('common.unlimited')} aria-invalid={!!errors.gift.giftMaxCount} />
              </Field>
            )}
          </div>
        )}

        <Field label={t('b.thanks.label')} htmlFor="thanks" hint={t('b.thanks.hint')}>
          <Textarea id="thanks" rows={2} maxLength={500} value={draft.customThankYou} onChange={(e) => onChange({ ...draft, customThankYou: e.target.value })} placeholder={t('b.thanks.placeholder')} />
        </Field>
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Badge variant="neutral">{t('b.gift.onlyComplete')}</Badge></p>
      </CardContent>
    </Card>
  );
}
