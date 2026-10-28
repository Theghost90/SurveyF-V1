'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CheckCircle2, Link2, XCircle } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';

/** The page behind "link your Google account": nothing is linked until the owner presses the button (a mail scanner opening the link changes nothing). */
function LinkGoogle() {
  const t = useT();
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'bad'>(token ? 'idle' : 'bad');
  const [msg, setMsg] = useState<string | null>(null);

  async function confirm() {
    setState('busy');
    try { await api('/auth/google/link/confirm', { body: { token } }); setState('done'); }
    catch (err) { if (err instanceof ApiError && err.code === 'invalid_token') setState('bad'); else { setMsg(errorMessage(err, t)); setState('idle'); } }
  }

  if (state === 'done') {
    return (
      <Card className="w-full max-w-md p-8 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-leaf" aria-hidden />
        <h1 className="mt-3 text-3xl font-extrabold tracking-[-0.03em]">{t('lk.done')}</h1>
        <p className="mt-2 text-muted-foreground">{t('lk.doneText')}</p>
        <Link href="/login" className={buttonVariants({ size: 'lg', className: 'mt-6 h-12 w-full text-base' })}>{t('ve.signin')}</Link>
      </Card>
    );
  }
  if (state === 'bad') {
    return (
      <Card className="w-full max-w-md p-8">
        <XCircle className="h-10 w-10 text-destructive" aria-hidden />
        <p className="mt-3 text-lg font-semibold">{t('lk.bad')}</p>
        <Link href="/login" className={buttonVariants({ className: 'mt-5' })}>{t('ve.signin')}</Link>
      </Card>
    );
  }
  return (
    <Card className="w-full max-w-md p-8 text-center">
      <Link2 className="mx-auto h-10 w-10 text-leaf" aria-hidden />
      <h1 className="mt-3 text-3xl font-extrabold tracking-[-0.03em]">{t('lk.title')}</h1>
      <p className="mt-2 text-muted-foreground">{t('lk.text')}</p>
      <Button size="lg" className="mt-6 h-12 w-full text-base" loading={state === 'busy'} onClick={confirm}>{t('lk.button')}</Button>
      {msg && <p role="alert" className="mt-3 text-sm font-medium text-destructive">{msg}</p>}
    </Card>
  );
}

export default function LinkGooglePage() { return <Suspense><LinkGoogle /></Suspense>; }
