'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n/client';

function RegisterForm() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const [form, setForm] = useState({ businessName: '', name: '', email: '', phone: '+237 ', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError(null);
    try {
      await api('/auth/register', { body: { ...form, locale } });
      const res = await signIn('credentials', { email: form.email, password: form.password, redirect: false });
      if (res?.error) throw new Error('signin');
      // The pricing page's chosen plan travels to the billing step of onboarding.
      const plan = params.get('plan');
      router.push(plan ? `/onboarding?plan=${encodeURIComponent(plan)}&interval=${params.get('interval') ?? 'monthly'}` : '/onboarding');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        setErrors(Object.fromEntries(err.issues.map((i) => [i.path, i.message])));
      } else if (err instanceof ApiError && err.code === 'invalid_phone') {
        setErrors({ phone: errorMessage(err, t) });
      } else if (err instanceof ApiError && err.code === 'email_taken') {
        setErrors({ email: errorMessage(err, t) });
      } else {
        setFormError(errorMessage(err, t));
      }
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-lg p-8">
      <h1 className="text-3xl font-extrabold tracking-[-0.03em]">{t('register.title')}</h1>
      <p className="mt-1.5 text-muted-foreground">{t('register.sub')}</p>
      <form onSubmit={submit} className="mt-6 grid gap-4 sm:grid-cols-2" noValidate>
        <Field label={t('register.business')} htmlFor="businessName" error={errors.businessName} className="sm:col-span-2">
          <Input id="businessName" required autoComplete="organization" value={form.businessName} onChange={set('businessName')} aria-invalid={!!errors.businessName} />
        </Field>
        <Field label={t('register.name')} htmlFor="name" error={errors.name}>
          <Input id="name" required autoComplete="name" value={form.name} onChange={set('name')} aria-invalid={!!errors.name} />
        </Field>
        <Field label={t('register.phone')} htmlFor="phone" hint={t('register.phoneHint')} error={errors.phone}>
          <Input id="phone" type="tel" required autoComplete="tel" inputMode="tel" value={form.phone} onChange={set('phone')} aria-invalid={!!errors.phone} />
        </Field>
        <Field label={t('register.email')} htmlFor="email" error={errors.email} className="sm:col-span-2">
          <Input id="email" type="email" required autoComplete="email" value={form.email} onChange={set('email')} aria-invalid={!!errors.email} />
        </Field>
        <Field label={t('register.password')} htmlFor="password" hint={t('register.passwordHint')} error={errors.password} className="sm:col-span-2">
          <Input id="password" type="password" required minLength={8} autoComplete="new-password" value={form.password} onChange={set('password')} aria-invalid={!!errors.password} />
        </Field>
        {formError && <p role="alert" className="text-sm font-medium text-destructive sm:col-span-2">{formError}</p>}
        <Button type="submit" size="lg" loading={busy} className="h-12 text-base sm:col-span-2">{t('register.submit')}</Button>
        <p className="text-xs text-muted-foreground sm:col-span-2">{t('register.accept')}</p>
      </form>
      <p className="mt-5 text-center text-sm text-muted-foreground">
        {t('register.have')} <Link href="/login" className="font-semibold text-leaf hover:underline">{t('register.signin')}</Link>
      </p>
    </Card>
  );
}

export default function RegisterPage() {
  return <Suspense><RegisterForm /></Suspense>;
}
