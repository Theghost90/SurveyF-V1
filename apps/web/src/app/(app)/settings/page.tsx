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
import { AnalyticsBotCard } from '@/components/settings/analytics-bot-card';
import { DataTab } from '@/components/settings/data-tab';
import { SecurityTab } from '@/components/settings/security-tab';
import { WhatsAppConnect } from '@/components/settings/whatsapp-connect';
import { useAccount } from '@/lib/account';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { CUSTOMER_SEGMENTS, countryWithCurrency, formatPhone, phoneExampleFor, supportedCountry } from '@surveyflow/shared';
import { useLocale } from '@/lib/i18n/client';

function Profile() {
  const t = useT();
  const locale = useLocale();
  const { account, mutate } = useAccount();
  const [form, setForm] = useState({ name: '', businessName: '', phone: '', segment: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (account) setForm({ name: account.user.name, businessName: account.user.businessName, phone: formatPhone(account.user.phone), segment: account.user.segment ?? '' }); }, [account?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!account) return <Skeleton className="h-64" />;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await api('/auth/me', { method: 'PATCH', body: { name: form.name, businessName: form.businessName, phone: form.phone, ...(form.segment ? { segment: form.segment } : {}) } });
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
          <Field label={t('register.phone')} htmlFor="p-phone" hint={t('register.phoneHint', { example: phoneExampleFor(account.user.country) })} error={errors.phone}>
            <Input id="p-phone" type="tel" value={form.phone} placeholder={phoneExampleFor(account.user.country)} onChange={(e) => setForm({ ...form, phone: e.target.value })} required aria-invalid={!!errors.phone} />
          </Field>
          {/* Read-only: the country follows where the owner is, and the currency is that country's official one. Nothing to choose. */}
          <Field label={t('s.currency')} htmlFor="p-currency" hint={t('s.currencyHint')}>
            <Input id="p-currency" value={countryWithCurrency(supportedCountry(account.user.country), locale)} readOnly aria-readonly="true" className="bg-canvas" />
          </Field>
          <Field label={t('s.segment')} htmlFor="p-segment" hint={t('s.segmentHint')} className="sm:col-span-2">
            <Select value={form.segment} onValueChange={(v) => setForm({ ...form, segment: v })}>
              <SelectTrigger id="p-segment"><SelectValue placeholder={t('s.segmentPick')} /></SelectTrigger>
              <SelectContent>{CUSTOMER_SEGMENTS.map((k) => <SelectItem key={k} value={k}>{t(`seg.${k}`)}</SelectItem>)}</SelectContent>
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
        <TabsList><TabsTrigger value="profile">{t('s.profile')}</TabsTrigger><TabsTrigger value="whatsapp">WhatsApp</TabsTrigger><TabsTrigger value="analytics">{t('ab.tab')}</TabsTrigger><TabsTrigger value="integrations">{t('s.integrations')}</TabsTrigger><TabsTrigger value="security">{t('s.security')}</TabsTrigger><TabsTrigger value="data">{t('dt.tab')}</TabsTrigger></TabsList>
        <TabsContent value="profile"><Profile /></TabsContent>
        <TabsContent value="whatsapp"><Card><CardHeader><CardTitle>{t('w.title')}</CardTitle></CardHeader><CardContent><WhatsAppConnect /></CardContent></Card></TabsContent>
        <TabsContent value="analytics"><AnalyticsBotCard /></TabsContent>
        <TabsContent value="integrations"><Integrations /></TabsContent>
        <TabsContent value="security"><SecurityTab /></TabsContent>
        <TabsContent value="data"><DataTab /></TabsContent>
      </Tabs>
    </>
  );
}

export default function SettingsPage() {
  return <Suspense><SettingsTabs /></Suspense>;
}
