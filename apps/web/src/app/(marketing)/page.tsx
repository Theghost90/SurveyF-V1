import Link from 'next/link';
import { ArrowRight, Gift, Percent, Smartphone, Ticket, Wallet } from 'lucide-react';
import { formatPrice } from '@surveyflow/shared';
import { MarketingHeader } from '@/components/marketing/header';
import { HeroPhone } from '@/components/marketing/hero-phone';
import { buttonVariants } from '@/components/ui/button';
import { getPricing } from '@/lib/pricing';
import { getT } from '@/lib/i18n/server';
import { cn } from '@/lib/utils';

export default async function HomePage() {
  const { t, locale } = await getT();
  const pricing = await getPricing();
  const salesWa = process.env.NEXT_PUBLIC_SALES_WHATSAPP; // e.g. 237600000000 — set per deployment, never hard-coded
  const steps = [
    ['steps.ask', 'steps.askText'],
    ['steps.hear', 'steps.hearText'],
    ['steps.know', 'steps.knowText'],
    ['steps.act', 'steps.actText'],
  ] as const;
  const gifts = [
    [Smartphone, 'gifts.airtime', 'gifts.airtimeText'],
    [Wallet, 'gifts.momo', 'gifts.momoText'],
    [Percent, 'gifts.discount', 'gifts.discountText'],
    [Ticket, 'gifts.draw', 'gifts.drawText'],
  ] as const;

  return (
    <>
      <MarketingHeader />

      {/* Hero A */}
      <section className="mx-auto flex max-w-[1344px] flex-wrap items-center gap-14 px-5 pb-10 pt-12 sm:px-8">
        <div className="flex min-w-0 flex-1 basis-[520px] flex-col gap-7">
          <div className="inline-flex items-center gap-2 self-start rounded-full border border-line bg-white py-2 pl-2.5 pr-3.5 text-sm font-semibold text-leaf">
            <span className="h-2 w-2 rounded-full bg-brand" aria-hidden />
            {t('hero.badge')}
          </div>
          <h1 className="text-balance text-[clamp(44px,5.6vw,80px)] font-extrabold leading-[0.98] tracking-[-0.035em]">
            {t('hero.title1')} <span className="text-leaf">{t('hero.title2')}</span>
          </h1>
          <p className="max-w-[560px] text-xl leading-[1.55] text-body">{t('hero.sub')}</p>
          <div className="flex flex-wrap gap-3.5">
            <Link href="/register" className={buttonVariants({ variant: 'brand', size: 'lg', className: 'px-[26px] text-[17px] font-bold' })}>
              {t('hero.cta')}
              <ArrowRight className="h-[18px] w-[18px]" strokeWidth={2.2} aria-hidden />
            </Link>
            <Link href="/#how" className={buttonVariants({ variant: 'outline', size: 'lg', className: 'px-6' })}>
              {t('hero.cta2')}
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">{t('hero.note', { price: formatPrice(pricing.plans.starter.monthly, pricing.currency as never, locale) })}</p>
        </div>
        <HeroPhone />
      </section>

      {/* Ask → Hear → Know → Act */}
      <section id="how" aria-label={t('steps.label')} className="mx-auto max-w-[1344px] scroll-mt-6 px-5 pb-14 pt-2 sm:px-8">
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))]">
          {steps.map(([title, text], i) => {
            const last = i === steps.length - 1;
            return (
              <div key={title} className={cn('flex flex-col gap-2 rounded-[18px] p-[22px]', last ? 'bg-ink' : 'bg-white')}>
                <span className={cn('font-display text-[28px] font-extrabold', last ? 'text-brand' : 'text-leaf')}>{t(title)}</span>
                <span className={cn('text-[15px] leading-[1.5]', last ? 'text-[#D5E3DA]' : 'text-body')}>{t(text)}</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Gifts */}
      <section id="gifts" className="scroll-mt-6 bg-white">
        <div className="mx-auto max-w-[1344px] px-5 py-16 sm:px-8">
          <div className="grid items-start gap-10 lg:grid-cols-[1fr_1.4fr]">
            <div className="flex flex-col gap-4">
              <Gift className="h-9 w-9 text-leaf" aria-hidden />
              <h2 className="text-balance text-[clamp(30px,3.6vw,48px)] font-extrabold leading-[1.02] tracking-[-0.03em]">{t('gifts.title')}</h2>
              <p className="text-lg leading-relaxed text-body">{t('gifts.sub')}</p>
              <p className="text-sm text-muted-foreground">{t('gifts.note')}</p>
            </div>
            <ul className="grid list-none gap-4 p-0 sm:grid-cols-2">
              {gifts.map(([Icon, title, text]) => (
                <li key={title} className="flex flex-col gap-2 rounded-[18px] bg-canvas p-6">
                  <Icon className="h-6 w-6 text-leaf" aria-hidden />
                  <span className="font-display text-xl font-bold">{t(title)}</span>
                  <span className="text-[15px] leading-relaxed text-body">{t(text)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Agencies & NGOs */}
      <section id="agencies" className="mx-auto max-w-[1344px] scroll-mt-6 px-5 py-16 sm:px-8">
        <div className="flex flex-col items-start gap-4 rounded-3xl bg-amber-soft p-8 sm:p-10">
          <h2 className="max-w-3xl text-balance text-[clamp(26px,3vw,38px)] font-bold leading-tight tracking-[-0.02em]">{t('agencies.title')}</h2>
          <p className="max-w-2xl text-base leading-relaxed text-[#5A4A2E]">{t('agencies.text')}</p>
          <Link
            href={salesWa ? `https://wa.me/${salesWa.replace(/\D/g, '')}` : '/register'}
            className={buttonVariants({ size: 'lg', className: 'h-12 text-base' })}
            {...(salesWa ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {salesWa ? t('agencies.cta') : t('agencies.ctaFallback')}
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-[1344px] px-5 pb-20 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-6 rounded-3xl bg-ink p-8 text-white sm:p-10">
          <div>
            <h2 className="text-[clamp(28px,3.4vw,44px)] font-extrabold leading-tight tracking-[-0.03em]">{t('cta.title')}</h2>
            <p className="mt-2 text-lg text-[#B5C9BD]">{t('cta.text')}</p>
          </div>
          <Link href="/register" className={buttonVariants({ variant: 'brand', size: 'lg', className: 'font-bold' })}>
            {t('hero.cta')} <ArrowRight className="h-[18px] w-[18px]" aria-hidden />
          </Link>
        </div>
      </section>
    </>
  );
}
