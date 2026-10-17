'use client';
import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Briefcase, Building2, Check, CheckCircle2, GraduationCap } from 'lucide-react';
import { CUSTOMER_SEGMENTS, type CustomerSegment } from '@surveyflow/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { WhatsAppConnect } from '@/components/settings/whatsapp-connect';
import { useAccount } from '@/lib/account';
import { api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const SEGMENT_ICONS = { business: Briefcase, institution: Building2, academic: GraduationCap } as const;

/**
 * Setup is two steps, both required: who the owner surveys for, and their WhatsApp Business number (every survey, contact and send needs it).
 * Contacts, the first survey and the plan are not here: they wait in "Getting started" on the dashboard, with no pressure.
 * Someone who arrived from a pricing button ("Activate Growth") goes straight to that plan's checkout when setup is done.
 */
function Wizard() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const { account, mutate } = useAccount();
  const [step, setStep] = useState(1);
  const [savingSeg, setSavingSeg] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const positioned = useRef(false);

  const ob = account?.onboarding;
  const segment = account?.user.segment ?? null;
  const segmentChosen = !!ob?.segmentChosen;
  const connected = !!ob?.whatsappConnected;
  const labels = [t('ob.s0'), t('ob.s1')];
  const done = [segmentChosen, connected];
  const wantedPlan = params.get('plan');

  // Someone coming back has already answered the first question: start where they left off.
  useEffect(() => {
    if (account && !positioned.current) { positioned.current = true; setStep(account.onboarding.segmentChosen ? 2 : 1); }
  }, [account]);

  async function chooseSegment(k: CustomerSegment) {
    setSavingSeg(true);
    try { await api('/auth/me', { method: 'PATCH', body: { segment: k } }); await mutate(); setStep(2); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setSavingSeg(false); }
  }

  async function finish() {
    setFinishing(true);
    try {
      await api('/auth/me', { method: 'PATCH', body: { onboardingDone: true } });
      await mutate();
      router.push(wantedPlan ? `/billing?plan=${encodeURIComponent(wantedPlan)}&interval=${params.get('interval') ?? 'monthly'}` : '/dashboard');
    } catch (err) { toast.error(errorMessage(err, t)); setFinishing(false); }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-[clamp(28px,3.4vw,42px)] font-extrabold tracking-[-0.03em]">{t('ob.title')}</h1>
      <p className="mb-7 mt-1 text-muted-foreground">{t('ob.sub')}</p>
      <ol className="mb-8 grid grid-cols-2 gap-2" aria-label={t('ob.title')}>
        {labels.map((l, i) => (
          <li key={l}>
            <button type="button" disabled={i > 0 && !segmentChosen} onClick={() => setStep(i + 1)} aria-current={step === i + 1 ? 'step' : undefined} className={cn('flex w-full flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50', step === i + 1 ? 'border-ink bg-ink text-white' : 'border-line bg-white hover:bg-canvas')}>
              <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold', done[i] ? 'bg-brand text-ink' : step === i + 1 ? 'bg-white/20' : 'bg-muted')}>{done[i] ? <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden /> : i + 1}</span>
              <span className="text-sm font-semibold leading-tight">{l}</span>
            </button>
          </li>
        ))}
      </ol>

      <Card className="p-6 sm:p-8">
        {step === 1 && (
          <>
            <h2 className="mb-1 text-2xl font-bold">{t('ob.segTitle')}</h2><p className="mb-5 text-muted-foreground">{t('ob.segText')}</p>
            <div role="radiogroup" aria-label={t('ob.segTitle')} className="grid gap-3 sm:grid-cols-3">
              {CUSTOMER_SEGMENTS.map((k) => {
                const Icon = SEGMENT_ICONS[k];
                const on = segment === k;
                return (
                  <button key={k} type="button" role="radio" aria-checked={on} disabled={savingSeg} onClick={() => void chooseSegment(k)} className={cn('flex flex-col items-start gap-2 rounded-2xl border-2 p-4 text-left transition-colors disabled:opacity-60', on ? 'border-brand bg-mint/40' : 'border-line bg-white hover:bg-canvas')}>
                    <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl', on ? 'bg-brand text-ink' : 'bg-muted text-body')}><Icon className="h-5 w-5" aria-hidden /></span>
                    <span className="font-display text-lg font-bold text-ink">{t(`seg.${k}`)}</span>
                    <span className="text-sm leading-snug text-body">{t(`seg.${k}Text`)}</span>
                  </button>
                );
              })}
            </div>
            {segmentChosen && <p role="status" className="mt-4 text-sm text-muted-foreground">{t('ob.segSaved')}</p>}
          </>
        )}
        {step === 2 && (
          <>
            <h2 className="mb-1 text-2xl font-bold">{t('ob.s1')}</h2>
            <p className="mb-5 text-muted-foreground">{t('ob.s1Text')}</p>
            <WhatsAppConnect compact onConnected={() => void mutate()} />
            {connected && (
              <p role="status" data-testid="ob-connected" className="mt-5 flex items-start gap-3 rounded-xl bg-mint/50 p-4 text-sm">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-leaf" aria-hidden />
                <span><b>{t('ob.connectedTitle')}.</b> {t('ob.connectedText')}</span>
              </p>
            )}
            {!connected && <p className="mt-5 text-sm text-muted-foreground">{t('ob.pending')}</p>}
          </>
        )}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <Button variant="ghost" disabled={step === 1} onClick={() => setStep(1)}>{t('common.back')}</Button>
          <div className="flex flex-wrap items-center gap-3">
            {step === 2 && !connected && <Link href="/dashboard" className="text-sm font-semibold text-muted-foreground underline">{t('ob.later')}</Link>}
            {step === 1 ? <Button disabled={!segmentChosen} onClick={() => setStep(2)}>{t('common.next')}</Button> : <Button variant="brand" disabled={!segmentChosen || !connected} loading={finishing} onClick={finish}>{t('ob.finish')}</Button>}
          </div>
        </div>
      </Card>
    </div>
  );
}
export default function OnboardingPage() { return <Suspense><Wizard /></Suspense>; }
