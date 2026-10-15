'use client';
import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { Briefcase, Building2, Check, GraduationCap, Plus, Upload } from 'lucide-react';
import { CUSTOMER_SEGMENTS, PAID_PLAN_KEYS, formatPrice, planPrice, type CustomerSegment } from '@surveyflow/shared';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AddContactDialog, ImportDialog } from '@/components/contacts/contact-dialogs';
import { WhatsAppConnect } from '@/components/settings/whatsapp-connect';
import { useAccount } from '@/lib/account';
import { api, errorMessage } from '@/lib/api';
import { useOwnerCountry } from '@/lib/geo-context';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const SEGMENT_ICONS = { business: Briefcase, institution: Building2, academic: GraduationCap } as const;

/**
 * Spec §5.1 post-signup onboarding: connect WhatsApp → import contacts → create survey → choose plan, preceded by ONE required
 * question: which customer segment the owner belongs to (it decides which extra tools we offer). Everything after it can be skipped.
 */
function Wizard() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const { account, mutate } = useAccount();
  const { data: contacts, mutate: refreshContacts } = useSWR<{ total: number }>('/contacts?pageSize=1');
  const { currency } = useOwnerCountry();
  const [step, setStep] = useState(1);
  const [savingSeg, setSavingSeg] = useState(false);
  const positioned = useRef(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const wanted = params.get('plan');

  const ob = account?.onboarding;
  const segment = account?.user.segment ?? null;
  const segmentChosen = !!ob?.segmentChosen;
  const labels = [t('ob.s0'), t('ob.s1'), t('ob.s2'), t('ob.s3'), t('ob.s4')];
  const done = [segmentChosen, !!ob?.whatsappConnected, (contacts?.total ?? 0) > 0, !!ob?.hasSurvey, !!ob?.paidPlan];

  // Someone coming back to finish setup has already answered the first question: start where they left off.
  useEffect(() => {
    if (account && !positioned.current) { positioned.current = true; setStep(account.onboarding.segmentChosen ? 2 : 1); }
  }, [account]);

  async function chooseSegment(k: CustomerSegment) {
    setSavingSeg(true);
    try { await api('/auth/me', { method: 'PATCH', body: { segment: k } }); await mutate(); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setSavingSeg(false); }
  }

  async function finish() {
    try { await api('/auth/me', { method: 'PATCH', body: { onboardingDone: true } }); await mutate(); router.push('/dashboard'); }
    catch (err) { toast.error(errorMessage(err, t)); }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-[clamp(28px,3.4vw,42px)] font-extrabold tracking-[-0.03em]">{t('ob.title')}</h1>
      <p className="mb-7 mt-1 text-muted-foreground">{t('ob.sub')}</p>
      <ol className="mb-8 grid grid-cols-5 gap-2" aria-label={t('ob.title')}>
        {labels.map((l, i) => (
          <li key={l}>
            <button type="button" disabled={i > 0 && !segmentChosen} onClick={() => setStep(i + 1)} aria-current={step === i + 1 ? 'step' : undefined} className={cn('flex w-full flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50', step === i + 1 ? 'border-ink bg-ink text-white' : 'border-line bg-white hover:bg-canvas')}>
              <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold', done[i] ? 'bg-brand text-ink' : step === i + 1 ? 'bg-white/20' : 'bg-muted')}>{done[i] ? <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden /> : i + 1}</span>
              <span className="text-xs font-semibold leading-tight sm:text-sm">{l}</span>
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
        {step === 2 && (<><h2 className="mb-1 text-2xl font-bold">{t('ob.s1')}</h2><p className="mb-5 text-muted-foreground">{t('ob.s1Text')}</p><WhatsAppConnect compact onConnected={() => void mutate()} /></>)}
        {step === 3 && (
          <>
            <h2 className="mb-1 text-2xl font-bold">{t('ob.s2')}</h2><p className="mb-5 text-muted-foreground">{t('ob.s2Text')}</p>
            <p className="mb-4 rounded-xl bg-mint/50 p-3 text-sm font-semibold">{t('c.total', { n: contacts?.total ?? 0 })}</p>
            <div className="flex flex-wrap gap-3"><Button onClick={() => setImportOpen(true)}><Upload className="h-4 w-4" aria-hidden />{t('c.import')}</Button><Button variant="outline" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" aria-hidden />{t('c.add')}</Button></div>
            <AddContactDialog open={addOpen} onOpenChange={setAddOpen} onDone={() => void refreshContacts().then(() => mutate())} />
            <ImportDialog open={importOpen} onOpenChange={setImportOpen} onDone={() => void refreshContacts().then(() => mutate())} />
          </>
        )}
        {step === 4 && (<><h2 className="mb-1 text-2xl font-bold">{t('ob.s3')}</h2><p className="mb-5 text-muted-foreground">{t('ob.s3Text')}</p><Link href="/surveys/new" className={buttonVariants({})}>{ob?.hasSurvey ? t('ob.newAnother') : t('ob.pickTemplate')}</Link></>)}
        {step === 5 && (
          <>
            <h2 className="mb-1 text-2xl font-bold">{t('ob.s4')}</h2><p className="mb-5 text-muted-foreground">{t('ob.s4Text')}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {PAID_PLAN_KEYS.map((k) => (
                <Link key={k} href={`/billing?plan=${k}&interval=${params.get('interval') ?? 'monthly'}`} className={cn('flex flex-col gap-1 rounded-2xl border-2 p-4 no-underline', wanted === k ? 'border-brand bg-mint/40' : 'border-line hover:bg-canvas')}>
                  <span className="font-display text-xl font-bold text-ink">{t(`plan.${k}`)}</span>
                  <span className="text-sm text-body">{formatPrice(planPrice(k, currency), currency, locale)} / {t('bill.month')}</span>
                </Link>
              ))}
            </div>
            <p className="mt-4 text-sm text-muted-foreground">{t('ob.trialNote')}</p>
          </>
        )}
        <div className="mt-8 flex items-center justify-between border-t border-line pt-5">
          <Button variant="ghost" disabled={step === 1} onClick={() => setStep(step - 1)}>{t('common.back')}</Button>
          {step < 5 ? <Button disabled={step === 1 && !segmentChosen} onClick={() => setStep(step + 1)}>{step === 1 || done[step - 1] ? t('common.next') : t('common.skip')}</Button> : <Button variant="brand" disabled={!segmentChosen} onClick={finish}>{t('ob.finish')}</Button>}
        </div>
      </Card>
    </div>
  );
}
export default function OnboardingPage() { return <Suspense><Wizard /></Suspense>; }
