'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { PAID_PLAN_KEYS, PLANS, currencyLabel, formatFCFA, isCfa, recommendPlan, type PaidPlanKey } from '@surveyflow/shared';
import type { PricingData } from '@/lib/pricing';
import { useLocale, useT } from '@/lib/i18n/client';
import type { TFn } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Pricing A — "How many voices?" The design places the tick labels 100 / 500 / 3,000 / 15,000 at even spacing under a
 * LINEAR slider, so "3,000" would sit at 66% while the thumb reaches 3,000 at 19% — the labels lie. Here the slider is
 * piecewise-linear with each tier boundary at an even third, so ticks and thumb agree.
 */
const STOPS = [100, 500, 3000, 15000] as const;
const POS_MAX = 300;

function posToResponses(pos: number): number {
  const seg = Math.min(2, Math.floor(pos / 100));
  const frac = (pos - seg * 100) / 100;
  const raw = STOPS[seg]! + (STOPS[seg + 1]! - STOPS[seg]!) * frac;
  const step = seg === 0 ? 10 : seg === 1 ? 50 : 250;
  return Math.max(100, Math.min(15000, Math.round(raw / step) * step));
}
function responsesToPos(r: number): number {
  for (let seg = 0; seg < 3; seg++) {
    if (r <= STOPS[seg + 1]!) return seg * 100 + ((r - STOPS[seg]!) / (STOPS[seg + 1]! - STOPS[seg]!)) * 100;
  }
  return POS_MAX;
}

export function planFeatures(plan: PaidPlanKey, t: TFn, locale: 'en' | 'fr') {
  const p = PLANS[plan];
  const n = (v: number) => formatFCFA(v, locale);
  const list: Array<{ text: string; soon?: boolean }> = [
    { text: p.limits.activeSurveys === null ? t('feat.surveysUnlimited') : t('feat.surveys', { n: p.limits.activeSurveys }) },
    { text: t('feat.responses', { n: n(p.limits.responsesPerMonth) }) },
    { text: t('feat.messages', { n: n(p.limits.messagesPerMonth) }) },
    { text: t('feat.export') },
  ];
  list.push(p.features.giftAutomation ? { text: t('feat.gifts') } : { text: t('feat.noGifts') });
  if (p.features.googleSheets) list.push({ text: t('feat.sheets') });
  if (p.features.prioritySupport) list.push({ text: t('feat.support') });
  if (p.limits.teamMembers > 1) list.push({ text: t('feat.team', { n: p.limits.teamMembers }), soon: true });
  if (p.features.apiAccess) list.push({ text: t('feat.api'), soon: true });
  if (p.features.whiteLabel) list.push({ text: t('feat.whitelabel'), soon: true });
  return list;
}

export function PricingClient({ pricing, initial = 1200 }: { pricing: PricingData; initial?: number }) {
  const t = useT();
  const locale = useLocale();
  const { currency } = pricing;
  const label = currencyLabel(currency);
  const [pos, setPos] = useState(Math.round(responsesToPos(initial)));
  const [annual, setAnnual] = useState(false);
  const responses = useMemo(() => posToResponses(pos), [pos]);
  const fit = recommendPlan(responses);
  const per = pricing.plans[fit].monthly / Math.max(1, Math.min(responses, PLANS[fit].limits.responsesPerMonth));
  const perText = new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: per >= 10 ? 0 : per >= 1 ? 1 : 2, minimumFractionDigits: per >= 10 ? 0 : per >= 1 ? 1 : 2 }).format(per);

  return (
    <>
      <section aria-label={t('pricing.finder')} className="mx-auto max-w-[924px] px-5 pb-9 pt-2 sm:px-8">
        <div className="flex flex-col gap-[18px] rounded-3xl bg-white px-6 py-7 shadow-card sm:px-8">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <label htmlFor="voices" className="text-base font-semibold text-body">{t('pricing.responses')}</label>
            <output htmlFor="voices" className="font-display text-[44px] font-extrabold tracking-[-0.02em]">{formatFCFA(responses, locale)}</output>
          </div>
          <input
            id="voices"
            type="range"
            min={0}
            max={POS_MAX}
            step={1}
            value={pos}
            onChange={(e) => setPos(Number(e.target.value))}
            aria-valuetext={`${formatFCFA(responses, locale)} ${t('pricing.responses').toLowerCase()}`}
            className="h-8 w-full cursor-pointer"
          />
          <div className="relative h-5 text-[13px] text-muted-foreground" aria-hidden>
            {STOPS.map((s, i) => (
              <span key={s} className="absolute -translate-x-1/2" style={{ left: `${(i / 3) * 100}%`, transform: i === 0 ? 'none' : i === 3 ? 'translateX(-100%)' : 'translateX(-50%)' }}>{formatFCFA(s, locale)}</span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-7 gap-y-3 border-t border-line-3 pt-[18px]">
            <span className="text-base">{t('pricing.bestFit')} <b className="text-leaf">{t(`plan.${fit}`)}</b></span>
            <span className="text-base">{t('pricing.perAnswer', { n: `${perText} ${label}` })}</span>
            <fieldset className="ml-auto flex rounded-full border border-line-2 p-[3px] text-[13px] font-semibold">
              <legend className="sr-only">{t('pricing.billing')}</legend>
              {[false, true].map((v) => (
                <button key={String(v)} type="button" aria-pressed={annual === v} onClick={() => setAnnual(v)} className={cn('min-h-[34px] rounded-full px-3', annual === v ? 'bg-ink text-white' : 'text-muted-foreground')}>
                  {v ? t('pricing.annual') : t('pricing.monthly')}
                </button>
              ))}
            </fieldset>
          </div>
        </div>
      </section>

      <section aria-label={t('pricing.plans')} className="mx-auto max-w-[1344px] px-5 pb-8 sm:px-8">
        <div className="grid items-stretch gap-5 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
          {PAID_PLAN_KEYS.map((key) => {
            const plan = PLANS[key];
            const active = key === fit;
            const price = pricing.plans[key][annual ? 'annual' : 'monthly'];
            return (
              <div
                key={key}
                className={cn('flex flex-col gap-[18px] rounded-3xl border-2 p-7 transition-[background,transform] duration-200', active ? '-translate-y-1.5 border-brand bg-ink text-[#E8F2EC] shadow-[0_30px_60px_-30px_rgba(11,43,34,0.6)]' : 'border-line-3 bg-white text-ink')}
              >
                <div className="flex min-h-[30px] items-center justify-between">
                  <h3 className="font-display text-[26px] font-bold">{t(`plan.${key}`)}</h3>
                  {active && <span className="rounded-full bg-brand px-2.5 py-1.5 text-xs font-bold text-ink">{t('pricing.yourFit')}</span>}
                </div>
                <p className={cn('text-[15px] leading-[1.45]', active ? 'text-[#B5C9BD]' : 'text-muted-foreground')}>{t(`plan.${key}Who`)}</p>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-display text-[44px] font-extrabold tracking-[-0.03em]">{formatFCFA(price, locale)}</span>
                  <span className={cn('text-[15px]', active ? 'text-[#B5C9BD]' : 'text-muted-foreground')}>{annual ? t('pricing.perYear', { currency: label }) : t('pricing.perMonth', { currency: label })}</span>
                </div>
                <Link
                  href={`/register?plan=${key}${annual ? '&interval=annual' : ''}`}
                  className={cn('rounded-xl px-[18px] py-[15px] text-center text-base font-bold no-underline', active ? 'bg-brand text-ink hover:bg-brand-2' : 'border border-line-2 bg-canvas text-ink hover:bg-mint/60')}
                >
                  {t('pricing.cta')}
                </Link>
                <ul className="flex list-none flex-col gap-2.5 p-0 text-[15px]">
                  {planFeatures(key, t, locale).map((f) => (
                    <li key={f.text} className="flex items-start gap-2.5">
                      <Check className="mt-0.5 h-[18px] w-[18px] shrink-0 text-brand" strokeWidth={2.6} aria-hidden />
                      <span>{f.text}{f.soon && <span className={cn('ml-2 rounded-full px-2 py-0.5 text-[11px] font-bold', active ? 'bg-ink-3 text-brand-3' : 'bg-muted text-muted-foreground')}>{t('pricing.soon')}</span>}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-center text-[13px] text-muted-foreground">{t('pricing.overage', { amount: `${new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: pricing.overagePer100 < 10 ? 2 : 0 }).format(pricing.overagePer100)} ${label}` })}</p>
        <RateNote pricing={pricing} />
      </section>
    </>
  );
}

/**
 * Why the numbers are what they are, said plainly: converted from FCFA at today's rate, paid by international card, and — when the rate
 * source was down — shown in FCFA instead. ExchangeRate-API's open endpoint requires attribution wherever its rates are shown.
 */
function RateNote({ pricing }: { pricing: PricingData }) {
  const t = useT();
  const locale = useLocale();
  const converted = !isCfa(pricing.currency);
  if (!converted && !pricing.fallback) return null;
  const date = pricing.quote.asOf ? new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(pricing.quote.asOf)) : '';
  return (
    <div className="mx-auto mt-3 max-w-[720px] text-center text-[13px] leading-relaxed text-muted-foreground" data-testid="rate-note">
      {converted && pricing.quote.source === 'peg' ? (
        // the euro is the CFA franc's fixed peg: no live rate is involved, so nothing to attribute
        <>
          <p>{t('pricing.pegRate')}</p>
          <p>{t('pricing.card')}</p>
        </>
      ) : converted ? (
        <>
          <p>{t('pricing.rate', { currency: pricing.currency, rate: new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', { maximumSignificantDigits: 4 }).format(pricing.quote.rate), date: date || '—' })}</p>
          <p>{t('pricing.card')}{' '}<a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer" className="underline">{t('pricing.ratesBy')}</a></p>
        </>
      ) : (
        <p>{t('pricing.rateDown', { currency: pricing.requestedCurrency })}</p>
      )}
    </div>
  );
}
