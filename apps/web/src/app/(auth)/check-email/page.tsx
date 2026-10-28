'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Captcha } from '@/components/captcha';
import { DemoMailbox } from '@/components/demo-mailbox';
import { api, errorMessage } from '@/lib/api';
import { useAuthConfig } from '@/lib/auth-config';
import { useT } from '@/lib/i18n/client';

function CheckEmail() {
  const t = useT();
  const params = useSearchParams();
  const config = useAuthConfig();
  const email = params.get('email') ?? '';
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaRound, setCaptchaRound] = useState(0);

  async function resend() {
    setBusy(true); setMessage(null);
    try {
      await api('/auth/verify-email/resend', { body: { email, ...(captchaToken ? { captchaToken } : {}) } });
      setMessage(t('ce.resent'));
    } catch (err) { setMessage(errorMessage(err, t)); }
    finally { setBusy(false); setCaptchaToken(null); setCaptchaRound((n) => n + 1); }
  }

  return (
    <Card className="w-full max-w-md p-8 text-center">
      <MailCheck className="mx-auto h-10 w-10 text-leaf" aria-hidden />
      <h1 className="mt-3 text-3xl font-extrabold tracking-[-0.03em]">{t('ce.title')}</h1>
      <p className="mt-2 text-muted-foreground">{t('ce.text', { email })}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('ce.spam')}</p>
      {config?.emailMode === 'demo' && <div className="text-left"><DemoMailbox email={email} kind="verify_email" match="/verify-email?token=" /></div>}
      {config?.captcha && <div className="mt-4 flex justify-center"><Captcha siteKey={config.captcha.siteKey} onToken={setCaptchaToken} resetKey={captchaRound} /></div>}
      <Button variant="outline" className="mt-5" loading={busy} disabled={!email || (!!config?.captcha && !captchaToken)} onClick={resend}>{t('ce.resend')}</Button>
      {message && <p role="status" className="mt-3 text-sm font-medium text-ink">{message}</p>}
      <p className="mt-6 text-sm"><Link href="/register" className="font-semibold text-leaf hover:underline">{t('ce.wrong')}</Link></p>
    </Card>
  );
}

export default function CheckEmailPage() { return <Suspense><CheckEmail /></Suspense>; }
