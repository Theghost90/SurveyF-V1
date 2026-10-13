'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import { WhatsAppConnect } from '@/components/settings/whatsapp-connect';
import { useAccount } from '@/lib/account';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { COUNTRY_CONFIG } from '@surveyflow/shared';

function Profile() {
  const t = useT();
  const { account, mutate } = useAccount();
  const [form, setForm] = useState({ name: '', businessName: '', phone: '', country: 'CM', preferredPSP: 'auto' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (account) setForm({ name: account.user.name, businessName: account.user.businessName, phone: account.user.phone, country: account.user.country, preferredPSP: (account.user as any).preferredPSP ?? 'auto' }); }, [account?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!account) return <Skeleton className="h-64" />;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await api('/auth/me', { method: 'PATCH', body: { ...form, preferredPSP: form.preferredPSP === 'auto' ? null : form.preferredPSP } });
      await mutate();
      toast.success(t('common.saved'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_phone') setErrors({ phone: errorMessage(err, t) });
      else toast.error(errorMessage(err, t));
    } finally { setBusy(false); }
  }
  return (
    <Card>
      <CardHeader><CardTitle>{t('s.profile')}</CardTitle><CardDescription>{account.user.email}</CardDescription></CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Field label={t('register.business')} htmlFor="p-biz"><Input id="p-biz" value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} required /></Field>
          <Field label={t('register.name')} htmlFor="p-name"><Input id="p-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
          <Field label={t('register.phone')} htmlFor="p-phone" error={errors.phone}><Input id="p-phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required aria-invalid={!!errors.phone} /></Field>
          <Field label={t('s.country')} htmlFor="p-country">
            <Select value={form.country} onValueChange={(v) => setForm({ ...form, country: v })}>
              <SelectTrigger id="p-country"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(COUNTRY_CONFIG).map(([code, c]) => <SelectItem key={code} value={code}>{c.name} ({c.currency})</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label={t('s.psp')} htmlFor="p-psp" hint={t('s.pspHint')} className="sm:col-span-2">
            <Select value={form.preferredPSP} onValueChange={(v) => setForm({ ...form, preferredPSP: v })}>
              <SelectTrigger id="p-psp"><SelectValue /></SelectTrigger>
              <SelectContent>{['auto', 'campay', 'notchpay', 'payunit', 'cinetpay', 'flutterwave'].map((p) => <SelectItem key={p} value={p}>{p === 'auto' ? t('s.pspAuto') : p}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <div className="sm:col-span-2"><Button type="submit" loading={busy}>{t('common.save')}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function Integrations() {
  const t = useT();
  const { data, mutate } = useSWR<{ configured: boolean; connected: boolean; email: string | null }>('/integrations/google');
  const [busy, setBusy] = useState(false);
  if (!data) return <Skeleton className="h-32" />;
  async function connect() {
    setBusy(true);
    try { const { url } = await api<{ url: string }>('/integrations/google/auth-url'); sessionStorage.setItem('sf_google_return', '/settings?tab=integrations'); window.location.href = url; }
    catch (err) { toast.error(errorMessage(err, t)); setBusy(false); }
  }
  async function disconnect() {
    setBusy(true);
    try { await api('/integrations/google', { method: 'DELETE' }); await mutate(); } catch (err) { toast.error(errorMessage(err, t)); } finally { setBusy(false); }
  }
  return (
    <Card>
      <CardHeader><CardTitle>Google Sheets</CardTitle><CardDescription>{t('x.sheetsText')}</CardDescription></CardHeader>
      <CardContent>
        {!data.configured ? <p className="rounded-xl bg-canvas p-4 text-sm text-muted-foreground">{t('x.sheetsNotConfigured')}</p>
          : data.connected ? <div className="flex flex-wrap items-center gap-3"><span className="text-sm">{t('x.connectedAs', { email: data.email ?? '' })}</span><Button variant="outline" size="sm" loading={busy} onClick={disconnect}>{t('s.disconnect')}</Button></div>
          : <Button loading={busy} onClick={connect}>{t('x.connect')}</Button>}
      </CardContent>
    </Card>
  );
}

function SettingsTabs() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const tab = params.get('tab') ?? 'profile';
  return (
    <>
      <PageHeader title={t('app.nav.settings')} />
      <Tabs value={tab} onValueChange={(v) => router.replace(`/settings?tab=${v}`)}>
        <TabsList><TabsTrigger value="profile">{t('s.profile')}</TabsTrigger><TabsTrigger value="whatsapp">WhatsApp</TabsTrigger><TabsTrigger value="integrations">{t('s.integrations')}</TabsTrigger></TabsList>
        <TabsContent value="profile"><Profile /></TabsContent>
        <TabsContent value="whatsapp"><Card><CardHeader><CardTitle>{t('w.title')}</CardTitle></CardHeader><CardContent><WhatsAppConnect /></CardContent></Card></TabsContent>
        <TabsContent value="integrations"><Integrations /></TabsContent>
      </Tabs>
    </>
  );
}

export default function SettingsPage() {
  return <Suspense><SettingsTabs /></Suspense>;
}
