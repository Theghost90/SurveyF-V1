'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { safeRelativePath } from '@surveyflow/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Captcha } from '@/components/captcha';
import { Field, Input } from '@/components/ui/input';
import { useAuthConfig } from '@/lib/auth-config';
import { useT } from '@/lib/i18n/client';

type Step = 'password' | 'totp' | 'recovery';

function LoginForm() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const config = useAuthConfig();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<Step>('password');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaRound, setCaptchaRound] = useState(0);
  const [wait, setWait] = useState(0);
  // Only a path on this site: never an open redirect (`/\evil.example` is one, to a browser; see safeRelativePath).
  const next = safeRelativePath(params.get('callbackUrl'));
  const notice = params.get('google') === 'link' ? t('lg.linkSent') : params.get('reset') ? t('lg.reset') : params.get('verified') ? t('lg.verified') : params.get('expired') ? t('lg.expired') : params.get('error') ? t('lg.googleFailed') : null;

  useEffect(() => {
    if (wait <= 0) return;
    const id = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearInterval(id);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await signIn('credentials', {
      email, password, redirect: false,
      ...(step === 'totp' ? { totp: code.trim() } : {}), ...(step === 'recovery' ? { recoveryCode: code.trim() } : {}),
      ...(captchaToken ? { captchaToken } : {}),
    });
    if (res?.ok && !res.error) {
      router.push(next);
      router.refresh();
      return;
    }
    const err = res?.error ?? '';
    if (captchaToken) { setCaptchaToken(null); setCaptchaRound((n) => n + 1); } // a token works once
    if (err === 'totp_required') { setStep('totp'); setCode(''); }
    else if (err === 'invalid_code') setError(t('lg.codeWrong'));
    else if (err === 'captcha_required' || err === 'captcha_failed') { setNeedCaptcha(true); setError(t(err === 'captcha_failed' ? 'lg.captchaFailed' : 'lg.captchaNeeded')); }
    else if (err.startsWith('login_delayed:')) { setWait(Number(err.split(':')[1]) || 2); setError(null); if (config?.captcha) setNeedCaptcha(true); }
    else if (err === 'server_error' || err === 'network') setError(t('lg.serverError'));
    else setError(t('login.error'));
    setBusy(false);
  }

  const second = step !== 'password';
  return (
    <Card className="w-full max-w-md p-8">
      <h1 className="text-3xl font-extrabold tracking-[-0.03em]">{second ? t('lg.totpTitle') : t('login.title')}</h1>
      <p className="mt-1.5 text-muted-foreground">{second ? (step === 'totp' ? t('lg.totpHelp') : t('lg.recoveryHelp')) : t('login.sub')}</p>
      {notice && !second && <p role="status" className="mt-4 rounded-xl bg-mint/60 px-4 py-3 text-sm font-medium text-ink">{notice}</p>}

      {!second && config?.googleSignIn && (
        <>
          <Button type="button" variant="outline" size="lg" className="mt-6 h-12 w-full text-base" onClick={() => void signIn('google', { callbackUrl: next })}>{t('login.google')}</Button>
          <div className="my-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><span className="h-px flex-1 bg-line" />{t('login.or')}<span className="h-px flex-1 bg-line" /></div>
        </>
      )}

      <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
        {!second ? (
          <>
            <Field label={t('login.email')} htmlFor="email">
              <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error} />
            </Field>
            <Field label={t('login.password')} htmlFor="password" error={error}>
              <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} />
            </Field>
            <div className="-mt-2 text-right text-sm"><Link href="/forgot-password" className="font-semibold text-leaf hover:underline">{t('lg.forgot')}</Link></div>
          </>
        ) : (
          <>
            <Field label={step === 'totp' ? t('lg.totpLabel') : t('lg.recoveryLabel')} htmlFor="code" error={error}>
              <Input
                id="code" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={!!error}
                autoComplete="one-time-code" inputMode={step === 'totp' ? 'numeric' : 'text'} placeholder={step === 'totp' ? '123456' : 'XXXX-XXXX-XXXX-XXXX'}
              />
            </Field>
            <button type="button" className="-mt-2 text-left text-sm font-semibold text-leaf hover:underline" onClick={() => { setStep(step === 'totp' ? 'recovery' : 'totp'); setCode(''); setError(null); }}>
              {step === 'totp' ? t('lg.useRecovery') : t('lg.useApp')}
            </button>
          </>
        )}
        {needCaptcha && config?.captcha && <Captcha siteKey={config.captcha.siteKey} onToken={setCaptchaToken} resetKey={captchaRound} />}
        {wait > 0 && <p role="status" className="text-sm font-medium text-destructive">{t('lg.delayed', { s: wait })}</p>}
        <Button type="submit" size="lg" loading={busy} disabled={wait > 0 || (needCaptcha && !!config?.captcha && !captchaToken)} className="mt-1 h-12 text-base">{second ? t('lg.continue') : t('login.submit')}</Button>
        {second && <Button type="button" variant="ghost" onClick={() => { setStep('password'); setError(null); setCode(''); }}>{t('common.back')}</Button>}
      </form>
      {!second && (
        <p className="mt-6 text-center text-sm text-muted-foreground">
          {t('login.noAccount')} <Link href="/register" className="font-semibold text-leaf hover:underline">{t('login.create')}</Link>
        </p>
      )}
    </Card>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
