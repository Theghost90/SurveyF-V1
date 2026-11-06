'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CheckCircle2, MailCheck, XCircle } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Captcha } from '@/components/captcha';
import { Field, Input } from '@/components/ui/input';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuthConfig } from '@/lib/auth-config';
import { useT } from '@/lib/i18n/client';

/**
 * The page behind the link in the confirmation e-mail. It never confirms on load: some mail systems open every link to scan it, and that must not confirm an
 * address (or use up a link). The owner presses the button.
 */
function VerifyEmail() {
  const t = useT();
  const token = useSearchParams().get('token') ?? '';
  const config = useAuthConfig();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'bad'>('idle');
  const [after, setAfter] = useState<string>('/onboarding');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  async function confirm() {
    setState('busy');
    try {
      const r = await api<{ plan: string | null; interval: string | null }>('/auth/verify-email', { body: { token, ...(config?.confirmNeedsPassword ? { password } : {}) } });
      setAfter(r.plan ? `/onboarding?plan=${encodeURIComponent(r.plan)}&interval=${encodeURIComponent(r.interval ?? 'monthly')}` : '/onboarding');
      setState('done');
    } catch (err) {
      setState(err instanceof ApiError && err.code === 'invalid_token' ? 'bad' : 'idle');
      if (!(err instanceof ApiError && err.code === 'invalid_token')) setMsg(errorMessage(err, t));
    }
  }
  async function resend() {
    setMsg(null);
    try { await api('/auth/verify-email/resend', { body: { email, ...(captchaToken ? { captchaToken } : {}) } }); setMsg(t('ce.resent')); }
    catch (err) { setMsg(errorMessage(err, t)); }
    finally { setCaptchaToken(null); setRound((n) => n + 1); }
  }

  if (state === 'done') {
    return (
      <Card className="w-full max-w-md p-8 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-leaf" aria-hidden />
        <h1 className="mt-3 text-3xl font-extrabold tracking-[-0.03em]">{t('ve.done')}</h1>
        <p className="mt-2 text-muted-foreground">{t('ve.doneText')}</p>
        <Link href={`/login?verified=1&callbackUrl=${encodeURIComponent(after)}`} className={buttonVariants({ size: 'lg', className: 'mt-6 h-12 w-full text-base' })}>{t('ve.signin')}</Link>
      </Card>
    );
  }
  if (state === 'bad' || !token) {
    return (
      <Card className="w-full max-w-md p-8">
        <XCircle className="h-10 w-10 text-destructive" aria-hidden />
        <h1 className="mt-3 text-2xl font-extrabold tracking-[-0.03em]">{t('ve.bad')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('ve.badHelp')}</p>
        <div className="mt-4 grid gap-3">
          <Field label={t('ve.email')} htmlFor="ve-email"><Input id="ve-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {config?.captcha && <Captcha siteKey={config.captcha.siteKey} onToken={setCaptchaToken} resetKey={round} />}
          <Button onClick={resend} disabled={!email.includes('@') || (!!config?.captcha && !captchaToken)}>{t('ve.resend')}</Button>
          {msg && <p role="status" className="text-sm font-medium">{msg}</p>}
          <Link href="/login" className="text-center text-sm font-semibold text-leaf hover:underline">{t('ve.signin')}</Link>
        </div>
      </Card>
    );
  }
  const needsPassword = !!config?.confirmNeedsPassword;
  return (
    <Card className="w-full max-w-md p-8 text-center">
      <MailCheck className="mx-auto h-10 w-10 text-leaf" aria-hidden />
      <h1 className="mt-3 text-3xl font-extrabold tracking-[-0.03em]">{t('ve.title')}</h1>
      <p className="mt-2 text-muted-foreground">{t(needsPassword ? 've.textPassword' : 've.text')}</p>
      {needsPassword && (
        <form className="mt-5 text-left" onSubmit={(e) => { e.preventDefault(); if (password && state !== 'busy') void confirm(); }}>
          <Field label={t('ve.password')} htmlFor="ve-password" hint={t('ve.passwordHelp')}>
            <Input id="ve-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="confirm-password" />
          </Field>
        </form>
      )}
      <Button size="lg" className="mt-6 h-12 w-full text-base" loading={state === 'busy'} disabled={!config || (needsPassword && !password)} onClick={confirm} data-testid="confirm-email">{t('ve.button')}</Button>
      {msg && <p role="alert" className="mt-3 text-sm font-medium text-destructive">{msg}</p>}
    </Card>
  );
}

export default function VerifyEmailPage() { return <Suspense><VerifyEmail /></Suspense>; }
