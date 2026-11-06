'use client';
import { Info, Tag } from 'lucide-react';
import { classifySurvey, type CategoryReason } from '@surveyflow/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import type { SurveyDraft } from './types';

/** The sentence for one reason a survey is marketing (or, for the Meta ones, a warning), in the owner's words. */
export function ReasonText({ reason }: { reason: CategoryReason }) {
  const t = useT();
  switch (reason.code) {
    case 'promo_wording': return <>{t('b.msg.r.promo_wording', { terms: reason.terms.join(', ') })}</>;
    case 'meta_will_recategorise': return <>{t('b.msg.r.meta_will_recategorise', { date: reason.at ? new Date(reason.at).toLocaleDateString() : '…' })}</>;
    default: return <>{t(`b.msg.r.${reason.code}` as 'b.msg.r.gift')}</>;
  }
}

/**
 * Which message the invitation is sent as, and what that costs (WA-03). The owner states whether the survey follows something the people did with the business;
 * everything else is decided from the survey itself, the same way the server decides it at the moment of sending (packages/shared/src/message-category.ts), so
 * what is shown here cannot be argued with at the end. The default is marketing: it costs more and breaks no rule.
 */
export function MessageType({ draft, onChange }: { draft: SurveyDraft; onChange: (d: SurveyDraft) => void }) {
  const t = useT();
  const { category, reasons } = classifySurvey({
    title: draft.title, description: draft.description, customThankYou: draft.customThankYou, followsTransaction: draft.followsTransaction, giftType: draft.gift.giftType,
    questions: draft.questions.map((q) => ({ text: q.text, options: q.options })),
  });
  const marketing = category === 'marketing';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Tag className="h-5 w-5 text-leaf" aria-hidden />{t('b.msg.title')}</CardTitle>
        <CardDescription>{t('b.msg.sub')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className={cn('flex items-start gap-4 rounded-2xl border p-4', draft.followsTransaction ? 'border-leaf bg-mint/30' : 'border-line')}>
          <div className="flex-1">
            <label htmlFor="follows-transaction" className="cursor-pointer text-[15px] font-bold">{t('b.msg.follows')}</label>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('b.msg.followsHint')}</p>
          </div>
          <Switch id="follows-transaction" checked={draft.followsTransaction} onCheckedChange={(v) => onChange({ ...draft, followsTransaction: v })} aria-label={t('b.msg.follows')} />
        </div>
        <div role="status" data-testid="message-category" data-category={category} className={cn('flex gap-3 rounded-2xl p-4 text-sm leading-snug', marketing ? 'bg-amber-soft text-amber-ink' : 'bg-mint/50 text-body')}>
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="flex flex-col gap-2">
            <p><Badge variant={marketing ? 'amber' : 'default'}>{t(marketing ? 'b.msg.marketing' : 'b.msg.utility')}</Badge></p>
            <p>{t(marketing ? 'b.msg.marketingText' : 'b.msg.utilityText')}</p>
            {reasons.length > 0 && (
              <div>
                <p className="font-semibold">{t('b.msg.why')}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">{reasons.map((r, i) => <li key={i}><ReasonText reason={r} /></li>)}</ul>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
