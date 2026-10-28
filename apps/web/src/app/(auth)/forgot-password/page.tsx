'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Captcha } from '@/components/captcha';
import { DemoMailbox } from '@/components/demo-mailbox';
import { Field, Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { useAuthConfig } from '@/lib/auth-config';
import { useT } from '@/lib/i18n/client';

function Forgot() {
  const t = useT();
  const config = useAuthConfig();
  const [email, setEmail] = useState(useSearchParams().get('email') ?? '');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api('/auth/password/forgot', { body: { email: email.trim(), ...(captchaToken ? { captchaToken } : {}) } });
      setSentTo(email.trim().toLowerCase());
    } catch (err) { setError(errorMessage(err, t)); setCaptchaToken(null); setRound((n) => n + 1); }
    finally { setBusy(false); }
  }

  return (
    <Card className="w-full max-w-md p-8">
      <h1 className="text-3xl font-extrabold tracking-[-0.03em]">{t('fp.title')}</h1>
      {sentTo ? (
        <>
          <p className="mt-3 text-muted-foreground" role="status">{t('fp.done', { email: sentTo })}</p>
          {config?.emailMode === 'demo' && <DemoMailbox email={sentTo} kind="reset_password" match="/reset-password?token=" />}
        </>
      ) : (
        <>
          <p className="mt-1.5 text-muted-foreground">{t('fp.sub')}</p>
          <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
            <Field label={t('login.email')} htmlFor="email" error={error}><Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error} /></Field>
            {config?.captcha && <Captcha siteKey={config.captcha.siteKey} onToken={setCaptchaToken} resetKey={round} />}
            <Button type="submit" size="lg" loading={busy} disabled={!email.includes('@') || (!!config?.captcha && !captchaToken)} className="h-12 text-base">{t('fp.send')}</Button>
          </form>
        </>
      )}
      <p className="mt-6 text-center text-sm"><Link href="/login" className="font-semibold text-leaf hover:underline">{t('fp.back')}</Link></p>
    </Card>
  );
}

export default function ForgotPasswordPage() { return <Suspense><Forgot /></Suspense>; }
