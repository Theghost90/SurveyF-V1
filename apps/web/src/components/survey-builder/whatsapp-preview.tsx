'use client';
import { Fragment, useMemo } from 'react';
import { Gift, List } from 'lucide-react';
import { TEMPLATE_DEFS, TEMPLATE_NAMES, buildQuestionMessage, buildThankYouMessage, estimateMinutes, type OutboundMessage } from '@surveyflow/shared';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import type { SurveyDraft } from './types';

/** WhatsApp's *bold* and _italic_ markup. Plain React nodes, never innerHTML. */
export function WaText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {line.split(/(\*[^*\n]+\*|_[^_\n]+_)/g).map((part, j) =>
            part.startsWith('*') && part.endsWith('*') && part.length > 2 ? <b key={j}>{part.slice(1, -1)}</b>
            : part.startsWith('_') && part.endsWith('_') && part.length > 2 ? <i key={j}>{part.slice(1, -1)}</i>
            : <Fragment key={j}>{part}</Fragment>,
          )}
        </Fragment>
      ))}
    </>
  );
}

const inBubble = 'self-start max-w-[88%] rounded-[4px_12px_12px_12px] bg-white px-3 py-2 text-[13px] leading-[1.4] shadow-sm';
const outBubble = 'self-end max-w-[80%] rounded-[12px_4px_12px_12px] bg-wa-out px-3 py-2 text-[13px] shadow-sm';

export function Bubble({ message }: { message: OutboundMessage }) {
  return (
    <div className="flex flex-col gap-1">
      <div className={inBubble}><WaText text={message.body} /></div>
      {message.kind === 'buttons' && (
        <div className="flex max-w-[88%] flex-col gap-1">{message.buttons.map((b) => <div key={b.id} className="rounded-lg bg-white py-2 text-center text-[13px] font-semibold text-[#0a7cc4] shadow-sm">{b.title}</div>)}</div>
      )}
      {message.kind === 'link' && (
        <div className="flex max-w-[88%] flex-col gap-1"><div className="rounded-lg bg-white py-2 text-center text-[13px] font-semibold text-[#0a7cc4] shadow-sm">{message.buttonLabel}</div></div>
      )}
      {message.kind === 'list' && (
        <>
          <div className="flex max-w-[88%] items-center justify-center gap-1.5 rounded-lg bg-white py-2 text-center text-[13px] font-semibold text-[#0a7cc4] shadow-sm"><List className="h-3.5 w-3.5" aria-hidden />{message.buttonLabel}</div>
        </>
      )}
    </div>
  );
}

/**
 * Live preview. It renders the SAME OutboundMessage objects the sender converts to Cloud API payloads
 * (shared/buildQuestionMessage), so what the owner sees is what participants receive.
 */
export function WhatsAppPreview({ draft, businessName, step, onStep }: { draft: SurveyDraft; businessName: string; step: number; onStep: (n: number) => void }) {
  const t = useT();
  const lang = draft.language;
  const total = draft.questions.length;
  const tpl = TEMPLATE_DEFS.find((d) => d.name === TEMPLATE_NAMES.invitation && d.language === lang)!;
  const invite = tpl.body.replace('{{1}}', lang === 'fr' ? 'Aïcha' : 'Aïcha').replace('{{2}}', businessName || 'Boulangerie Akwa').replace('{{3}}', String(estimateMinutes(total || 1)));

  // step 0 = invitation, 1..n = question n, n+1 = thank-you
  const lastStep = total + 1;
  const messages = useMemo(
    () => draft.questions.map((q, i) => buildQuestionMessage({ id: `p${i}`, text: q.text || '…', type: q.type, required: q.required, options: q.options.map((o) => ({ id: o.id, label: o.label || '…' })) }, i, total, lang)),
    [draft.questions, total, lang],
  );
  const gift = draft.gift;
  const thanks = buildThankYouMessage(
    { giftType: gift.giftType === 'custom' || gift.giftType === 'none' ? 'none' : gift.giftType, giftValue: gift.giftValue, customThankYou: draft.customThankYou, code: gift.giftType === 'discount' ? 'SF-AB3K-X7QM' : null },
    lang,
  );
  const sampleAnswer = (i: number) => {
    const q = draft.questions[i]!;
    if (q.type === 'text') return lang === 'fr' ? 'Livraison avant 8h svp' : 'Delivery before 8am please';
    if (q.type === 'rating') return '4';
    if (q.type === 'multi') return q.options.slice(0, 2).map((o) => o.label || '…').join(', ');
    return q.options[0]?.label || '…';
  };
  const chips = [{ n: 0, label: t('b.pv.invite') }, ...draft.questions.map((_, i) => ({ n: i + 1, label: `Q${i + 1}` })), { n: lastStep, label: t('b.pv.thanks') }];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t('b.pv.title')}>
        {chips.map((c) => (
          <button key={c.n} type="button" role="tab" aria-selected={step === c.n} onClick={() => onStep(c.n)} className={cn('min-h-[32px] rounded-full px-3 text-xs font-bold', step === c.n ? 'bg-ink text-white' : 'bg-white text-body ring-1 ring-line-2 hover:bg-mint/60')}>{c.label}</button>
        ))}
      </div>
      <div className="mx-auto w-full max-w-[330px] rounded-[34px] bg-ink p-2.5 shadow-phone">
        <div className="overflow-hidden rounded-[26px] bg-wa-bg">
          <div className="flex items-center gap-2.5 bg-wa-header px-4 py-3 text-white">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber text-xs font-bold text-ink">{(businessName || 'B').slice(0, 2).toUpperCase()}</div>
            <div className="flex flex-col leading-tight"><span className="text-sm font-semibold">{businessName || '—'}</span><span className="text-[11px] opacity-80">{t('b.pv.business')}</span></div>
          </div>
          <div className="flex h-[440px] flex-col gap-2 overflow-y-auto px-3 py-3 scrollbar-thin" aria-live="polite">
            {/* invitation (a template: this is what Meta sends first) */}
            <div className="flex flex-col gap-1">
              <div className={inBubble}>{invite}</div>
              <div className="flex max-w-[88%] gap-1">{tpl.buttons.map((b) => <div key={b} className="flex-1 rounded-lg bg-white py-2 text-center text-[13px] font-semibold text-[#0a7cc4] shadow-sm">{b}</div>)}</div>
            </div>
            {step >= 1 && <div className={outBubble}>{tpl.buttons[0]}</div>}
            {messages.slice(0, Math.min(step, total)).map((m, i) => (
              <Fragment key={i}>
                <Bubble message={m} />
                {(i < step - 1 || step === lastStep) && <div className={outBubble}>{sampleAnswer(i)}</div>}
              </Fragment>
            ))}
            {step === lastStep && (
              <div className="flex flex-col gap-1">
                <div className={cn(inBubble, 'flex flex-col gap-1')}><WaText text={thanks} /></div>
                {['airtime', 'momo'].includes(gift.giftType) && <div className="flex items-center gap-1.5 self-center rounded-[10px] bg-amber-soft px-3 py-2 text-xs font-semibold text-amber-ink"><Gift className="h-3.5 w-3.5" aria-hidden />{gift.giftValue || '—'}</div>}
              </div>
            )}
            {total === 0 && <p className="mt-6 text-center text-xs text-muted-foreground">{t('b.pv.empty')}</p>}
          </div>
        </div>
      </div>
      <p className="text-center text-xs text-muted-foreground">{t('b.pv.note')}</p>
    </div>
  );
}
