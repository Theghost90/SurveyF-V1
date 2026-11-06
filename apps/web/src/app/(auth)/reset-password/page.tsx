'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';

function Reset() {
  const t = useT();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<'form' | 'done' | 'bad'>(token ? 'form' : 'bad');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== repeat) return setError(t('rp.mismatch'));
    setBusy(true); setError(null);
    try { await api('/auth/password/reset', { body: { token, password } }); setState('done'); }
    catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_token') setState('bad');
      else setError(errorMessage(err, t)); // a weak password does not use up the link: the owner can try another
    } finally { setBusy(false); }
  }

  if (state === 'done') {
    return (
      <Card className="w-full max-w-md p-8 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-leaf" aria-hidden />
        <h1 className="mt-3 text-3xl font-extrabold tracking-[-0.03em]">{t('rp.done')}</h1>
        <p className="mt-2 text-muted-foreground">{t('rp.doneText')}</p>
        <Link href="/login?reset=1" className={buttonVariants({ size: 'lg', className: 'mt-6 h-12 w-full text-base' })}>{t('ve.signin')}</Link>
      </Card>
    );
  }
  if (state === 'bad') {
    return (
      <Card className="w-full max-w-md p-8">
        <XCircle className="h-10 w-10 text-destructive" aria-hidden />
        <p className="mt-3 text-lg font-semibold">{t('rp.bad')}</p>
        <Link href="/forgot-password" className={buttonVariants({ className: 'mt-5' })}>{t('rp.askNew')}</Link>
      </Card>
    );
  }
  return (
    <Card className="w-full max-w-md p-8">
      <h1 className="text-3xl font-extrabold tracking-[-0.03em]">{t('rp.title')}</h1>
      <p className="mt-1.5 text-muted-foreground">{t('rp.sub')}</p>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
        <Field label={t('rp.new')} htmlFor="password" hint={t('reg.rules')} error={error}>
          <Input id="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} />
        </Field>
        <Field label={t('rp.repeat')} htmlFor="repeat"><Input id="repeat" type="password" required autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} /></Field>
        <Button type="submit" size="lg" loading={busy} disabled={password.length < 10} className="h-12 text-base">{t('rp.submit')}</Button>
      </form>
    </Card>
  );
}

export default function ResetPasswordPage() { return <Suspense><Reset /></Suspense>; }
