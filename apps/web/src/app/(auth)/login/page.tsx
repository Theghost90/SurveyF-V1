'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { useT } from '@/lib/i18n/client';

function LoginForm() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const callbackUrl = params.get('callbackUrl');
  // Only same-site relative paths: never an open redirect.
  const next = callbackUrl && callbackUrl.startsWith('/') && !callbackUrl.startsWith('//') ? callbackUrl : '/dashboard';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await signIn('credentials', { email, password, redirect: false });
    if (res?.error || !res?.ok) {
      setError(t('login.error'));
      setBusy(false);
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <Card className="w-full max-w-md p-8">
      <h1 className="text-3xl font-extrabold tracking-[-0.03em]">{t('login.title')}</h1>
      <p className="mt-1.5 text-muted-foreground">{t('login.sub')}</p>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
        <Field label={t('login.email')} htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error} />
        </Field>
        <Field label={t('login.password')} htmlFor="password" error={error}>
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} />
        </Field>
        <Button type="submit" size="lg" loading={busy} className="mt-1 h-12 text-base">{t('login.submit')}</Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        {t('login.noAccount')} <Link href="/register" className="font-semibold text-leaf hover:underline">{t('login.create')}</Link>
      </p>
    </Card>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
