'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FilePlus2, MessageSquareText } from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';
import { Smartphone } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useWhatsAppGate } from '@/components/whatsapp-gate';
import { PageHeader } from '@/components/page-header';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n/client';
import { surveyTemplates } from '@/lib/templates';
import { cn } from '@/lib/utils';

export default function NewSurveyPage() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const templates = surveyTemplates(locale);
  const { connected } = useWhatsAppGate();

  async function create(id: string, body: object) {
    setBusy(id);
    try {
      const s = await api<{ id: string }>('/surveys', { body: { language: locale, ...body } });
      router.push(`/surveys/${s.id}`);
    } catch (err) {
      toast.error(errorMessage(err, t));
      setBusy(null);
    }
  }
  const idOf = () => Math.random().toString(36).slice(2, 8);

  return (
    <>
      <PageHeader title={t('new.title')} sub={t('new.sub')} />
      {!connected ? (
        <Card className="flex flex-wrap items-center gap-4 border-2 border-brand bg-mint/40 p-6" data-testid="new-needs-wa">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand text-ink"><Smartphone className="h-6 w-6" aria-hidden /></span>
          <div className="min-w-0 flex-1 basis-64"><p className="font-display text-xl font-bold">{t('wa.req.title')}</p><p className="text-sm text-body">{t('wa.req.text')}</p></div>
          <Link href="/onboarding" className={buttonVariants({ variant: 'brand', size: 'lg' })}>{t('wa.req.cta')}</Link>
        </Card>
      ) : (
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
        <button type="button" disabled={!!busy} onClick={() => create('blank', { title: t('new.untitled'), questions: [] })} className={cn('text-left', busy && busy !== 'blank' && 'opacity-60')}>
          <Card className="flex h-full flex-col gap-3 border-dashed border-line-2 p-6 shadow-none transition-colors hover:bg-white">
            <FilePlus2 className="h-7 w-7 text-leaf" aria-hidden />
            <span className="font-display text-xl font-bold">{t('new.blank')}</span>
            <span className="text-sm text-muted-foreground">{t('new.blankText')}</span>
          </Card>
        </button>
        {templates.map((tpl) => (
          <button
            key={tpl.id} type="button" disabled={!!busy} onClick={() => create(tpl.id, {
              title: tpl.title,
              questions: tpl.questions.map((q) => ({ text: q.text, type: q.type, required: q.required, options: q.options ? q.options.map((label) => ({ id: `o${idOf()}${idOf()}`, label })) : null })),
            })}
            className={cn('text-left', busy && busy !== tpl.id && 'opacity-60')}
          >
            <Card className="flex h-full flex-col gap-3 p-6 transition-shadow hover:shadow-float">
              <MessageSquareText className="h-7 w-7 text-leaf" aria-hidden />
              <span className="font-display text-xl font-bold">{tpl.title}</span>
              <span className="text-sm text-muted-foreground">{tpl.description}</span>
              <span className="mt-auto text-xs font-bold text-leaf">{t('surveys.questionsN', { n: tpl.questions.length })}</span>
            </Card>
          </button>
        ))}
      </div>
      )}
    </>
  );
}
