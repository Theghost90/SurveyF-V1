import type { Metadata } from 'next';
import { MarketingHeader } from '@/components/marketing/header';
import { PricingClient } from '@/components/marketing/pricing-client';
import { getT } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Pricing' };

export default function PricingPage() {
  const { t } = getT();
  const included = ['pricing.inc1', 'pricing.inc2', 'pricing.inc3', 'pricing.inc4', 'pricing.inc5'] as const;
  return (
    <>
      <MarketingHeader current="pricing" />
      <section className="mx-auto flex max-w-[1344px] flex-col items-center gap-[18px] px-5 pb-6 pt-10 text-center sm:px-8">
        <h1 className="max-w-[900px] text-balance text-[clamp(40px,5vw,68px)] font-extrabold leading-none tracking-[-0.035em]">{t('pricing.title')}</h1>
        <p className="max-w-[620px] text-[19px] leading-[1.55] text-body">{t('pricing.sub')}</p>
      </section>
      <PricingClient />
      <section aria-label={t('pricing.includes')} className="mx-auto max-w-[1344px] px-5 pb-14 pt-2 sm:px-8">
        <div className="flex flex-wrap items-center gap-x-10 gap-y-5 rounded-3xl bg-ink px-6 py-7 text-[#E8F2EC] sm:px-8">
          <span className="flex-[1_1_220px] font-display text-[22px] font-bold">{t('pricing.includes')}</span>
          <ul className="flex flex-[3_1_600px] list-none flex-wrap gap-2.5 p-0">
            {included.map((k) => (
              <li key={k} className="rounded-full border border-ink-line px-3.5 py-2 text-sm">{t(k)}</li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
