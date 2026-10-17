'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ArrowLeft, BarChart3, Copy, Languages, Lock, PauseCircle, PlayCircle, Plus, Rocket, Save, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { SurveyStatusBadge } from '@/components/status-badge';
import { COUNTRY_CONFIG, localDateString } from '@surveyflow/shared';
import { useWallet } from '@/components/wallet/use-wallet';
import { useAccount } from '@/lib/account';
import { useOwnerCountry } from '@/lib/geo-context';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import { GiftSettings } from './gift-settings';
import { QuestionCard } from './question-card';
import { ReminderSettings } from './reminder-settings';
import { SendPanel } from './send-panel';
import { fromApi, newQuestion, toPayload, validateDraft, type SurveyDraft } from './types';
import { WhatsAppPreview } from './whatsapp-preview';
import { useRouter } from 'next/navigation';

export function SurveyBuilder({ id }: { id: string }) {
  const t = useT();
  const router = useRouter();
  const { account, mutate: refreshAccount } = useAccount();
  const { country } = useOwnerCountry();
  // The owner's calendar: deadlines are "end of this local day", so every date <-> instant conversion uses their UTC offset.
  const offsetMin = COUNTRY_CONFIG[country]!.utcOffsetMinutes;
  const zone = `UTC${offsetMin >= 0 ? '+' : '−'}${Math.abs(offsetMin) / 60}`;
  const today = localDateString(new Date(), offsetMin);
  const { data: survey, mutate } = useSWR<any>(`/surveys/${id}`, { revalidateOnFocus: false });
  const [draft, setDraft] = useState<SurveyDraft | null>(null);
  const [saved, setSaved] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'publish' | 'status'>(null);
  const [step, setStep] = useState(1);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    // Wait for the account: the deadline date is read in the owner's time zone, which is only known once it has loaded.
    if (survey && account && !loaded.current) {
      const d = fromApi(survey, offsetMin);
      setDraft(d);
      setSaved(JSON.stringify(toPayload(d, offsetMin)));
      loaded.current = true;
    }
  }, [survey, account]); // eslint-disable-line react-hooks/exhaustive-deps

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const { wallet } = useWallet();
  const errors = useMemo(() => (draft ? validateDraft(draft, t, today, wallet?.limits ?? null, wallet?.currency) : null), [draft, t, today, wallet?.limits, wallet?.currency]);
  const dirty = !!draft && JSON.stringify(toPayload(draft, offsetMin)) !== saved;
  const locked = !!survey && survey.status !== 'draft';

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const update = useCallback((patch: Partial<SurveyDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d)), []);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft || !errors) return false;
    if (errors.count > 0) { setShowErrors(true); toast.error(t('b.err.fix', { n: errors.count })); return false; }
    setBusy('save');
    try {
      const res = await api(`/surveys/${id}`, { method: 'PUT', body: toPayload(draft, offsetMin) });
      setSaved(JSON.stringify(toPayload(fromApi(res, offsetMin), offsetMin)));
      await mutate(res, { revalidate: false });
      toast.success(t('common.saved'));
      return true;
    } catch (err) {
      toast.error(errorMessage(err, t));
      return false;
    } finally {
      setBusy(null);
    }
  }, [draft, errors, id, mutate, offsetMin, t]);

  async function publish() {
    if (!(await save())) return;
    setBusy('publish');
    try {
      const pub = await api<{ giftWarning?: { code: string } | null }>(`/surveys/${id}/publish`, { method: 'POST' });
      await mutate();
      void refreshAccount();
      // Publishing with an empty gift wallet is allowed, but never silently: nobody would get their gift.
      if (pub.giftWarning?.code === 'gift_wallet_empty') toast.warning(t('w.published.empty'), { duration: 12_000, action: { label: t('w.topup'), onClick: () => window.open('/billing#wallet', '_blank', 'noopener') } });
      else toast.success(t('b.published'));
      setTimeout(() => document.getElementById('send')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'plan_limit' || err.code === 'plan_feature' || err.code === 'subscription_suspended')) {
        toast.error(errorMessage(err, t), { action: { label: t('common.upgrade'), onClick: () => router.push('/billing') } });
      } else toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }

  async function changeStatus(action: 'pause' | 'resume' | 'close') {
    setBusy('status');
    try {
      await api(`/surveys/${id}/${action}`, { method: 'POST' });
      await mutate();
      void refreshAccount();
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }

  async function duplicate() {
    try {
      const copy = await api<{ id: string }>(`/surveys/${id}/duplicate`, { method: 'POST' });
      router.push(`/surveys/${copy.id}`);
    } catch (err) {
      toast.error(errorMessage(err, t));
    }
  }

  function onDragEnd(e: DragEndEvent) {
    if (!draft || !e.over || e.active.id === e.over.id) return;
    const from = draft.questions.findIndex((q) => q.key === e.active.id);
    const to = draft.questions.findIndex((q) => q.key === e.over!.id);
    update({ questions: arrayMove(draft.questions, from, to) });
  }

  if (!survey || !draft || !errors) return <div className="grid gap-4"><Skeleton className="h-16" /><Skeleton className="h-96" /></div>;
  const qErrors = showErrors ? errors.questions : {};
  const giftErrors = showErrors ? errors : { ...errors, gift: {} };

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link href="/surveys" className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden />{t('b.back')}</Link>
        <SurveyStatusBadge status={survey.status} />
        {dirty && <Badge variant="warn">{t('b.unsaved')}</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {survey.status !== 'draft' && <Link href={`/surveys/${id}/analytics`} className={buttonVariants({ variant: 'outline', size: 'sm' })}><BarChart3 className="h-4 w-4" aria-hidden />{t('b.analytics')}</Link>}
          <Button variant="outline" size="sm" onClick={duplicate}><Copy className="h-4 w-4" aria-hidden />{t('surveys.duplicate')}</Button>
          {survey.status === 'active' && <Button variant="outline" size="sm" loading={busy === 'status'} onClick={() => changeStatus('pause')}><PauseCircle className="h-4 w-4" aria-hidden />{t('b.pause')}</Button>}
          {survey.status === 'paused' && <Button variant="outline" size="sm" loading={busy === 'status'} onClick={() => changeStatus('resume')}><PlayCircle className="h-4 w-4" aria-hidden />{t('b.resume')}</Button>}
          {(survey.status === 'active' || survey.status === 'paused') && <Button variant="outline" size="sm" loading={busy === 'status'} onClick={() => changeStatus('close')}><XCircle className="h-4 w-4" aria-hidden />{t('b.close')}</Button>}
          <Button variant={survey.status === 'draft' ? 'outline' : 'default'} size="sm" onClick={save} loading={busy === 'save'} disabled={!dirty}><Save className="h-4 w-4" aria-hidden />{survey.status === 'draft' ? t('b.saveDraft') : t('common.save')}</Button>
          {survey.status === 'draft' && <Button size="sm" variant="brand" onClick={publish} loading={busy === 'publish'}><Rocket className="h-4 w-4" aria-hidden />{t('b.publish')}</Button>}
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_370px]">
        <div className="flex min-w-0 flex-col gap-6">
          <div>
            <label htmlFor="title" className="sr-only">{t('b.title')}</label>
            <Textarea id="title" rows={1} value={draft.title} onChange={(e) => update({ title: e.target.value.replace(/\n/g, ' ') })} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} maxLength={120} placeholder={t('b.title')} aria-invalid={showErrors && !!errors.title} className="min-h-0 resize-none rounded-2xl border-transparent bg-transparent px-0 py-1 font-display text-[clamp(24px,3vw,38px)] font-extrabold leading-tight tracking-[-0.03em] shadow-none [field-sizing:content] focus-visible:bg-white focus-visible:px-4" />
            {showErrors && errors.title && <p role="alert" className="text-sm font-medium text-destructive">{errors.title}</p>}
          </div>

          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
              <CardTitle>{t('b.questions')}</CardTitle>
              <Button size="sm" onClick={() => { const q = newQuestion('button'); update({ questions: [...draft.questions, q] }); setActiveKey(q.key); setStep(draft.questions.length + 1); }} disabled={locked || draft.questions.length >= 25}><Plus className="h-4 w-4" aria-hidden />{t('b.addQuestion')}</Button>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {locked && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl bg-canvas p-4 text-sm">
                  <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('b.locked')}</span>
                  <Button size="sm" variant="outline" onClick={duplicate}>{t('b.lockedCta')}</Button>
                </div>
              )}
              {draft.questions.length === 0 && <p className="rounded-xl bg-canvas p-6 text-center text-sm text-muted-foreground">{t('b.noQuestions')}</p>}
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={draft.questions.map((q) => q.key)} strategy={verticalListSortingStrategy}>
                  <ol className="flex list-none flex-col gap-3 p-0">
                    {draft.questions.map((q, i) => (
                      <QuestionCard
                        key={q.key} q={q} index={i} errors={qErrors[q.key]} locked={locked} active={q.key === (activeKey ?? draft.questions[0]?.key)}
                        onChange={(nq) => update({ questions: draft.questions.map((x) => (x.key === q.key ? nq : x)) })}
                        onRemove={() => update({ questions: draft.questions.filter((x) => x.key !== q.key) })}
                        onFocus={() => { setActiveKey(q.key); setStep(i + 1); }}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Languages className="h-5 w-5 text-leaf" aria-hidden />{t('b.language')}</CardTitle></CardHeader>
            <CardContent>
              <RadioGroup value={draft.language} onValueChange={(v) => update({ language: v as 'fr' | 'en' })} className="grid-cols-2 gap-2" aria-label={t('b.language')}>
                {(['fr', 'en'] as const).map((l) => (
                  <label key={l} className={cn('flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-[15px] font-medium', draft.language === l ? 'border-leaf bg-mint/40' : 'border-line')}>
                    <RadioGroupItem value={l} />{l === 'fr' ? 'Français' : 'English'}
                  </label>
                ))}
              </RadioGroup>
              <p className="mt-2 text-xs text-muted-foreground">{t('b.languageHint')}</p>
            </CardContent>
          </Card>

          <ReminderSettings draft={draft} onChange={setDraft} errors={showErrors ? errors : { ...errors, deadline: undefined }} zone={zone} today={today} />

          <GiftSettings draft={draft} onChange={setDraft} errors={giftErrors as never} canAutomate={!!account?.plan.features.giftAutomation} />

          <SendPanel surveyId={id} status={survey.status} language={draft.language} onPublish={publish} publishing={busy === 'publish'} dirty={dirty} />
        </div>

        <aside className="lg:sticky lg:top-24" aria-label={t('b.pv.title')}>
          <Card className="p-5">
            <h2 className="mb-3 font-display text-lg font-bold">{t('b.pv.title')}</h2>
            <WhatsAppPreview surveyId={survey.status === 'draft' ? undefined : id} draft={draft} businessName={account?.user.businessName ?? ''} step={Math.min(step, draft.questions.length + 1)} onStep={(n) => { setStep(n); if (n >= 1 && draft.questions[n - 1]) setActiveKey(draft.questions[n - 1]!.key); }} />
          </Card>
        </aside>
      </div>
    </>
  );
}
