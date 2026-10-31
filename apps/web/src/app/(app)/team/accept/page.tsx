'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Users } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { useAccount } from '@/lib/account';
import { api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { setWorkspace } from '@/lib/workspace';

function Accept() {
  const t = useT();
  const token = useSearchParams().get('token') ?? '';
  const { account } = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<{ workspaceId: string; businessName: string; role: 'viewer' | 'editor' } | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try { setJoined(await api('/team/accept', { method: 'POST', body: { token } })); }
    catch (err) { setError(errorMessage(err, t)); }
    finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader title={t('tm.acceptTitle')} />
      <Card className="max-w-xl">
        <CardHeader><CardTitle className="flex items-center gap-2"><Users className="h-5 w-5 text-leaf" aria-hidden />{joined ? t('tm.joined', { business: joined.businessName }) : t('tm.acceptHeading')}</CardTitle>
          <CardDescription>{joined ? t('tm.joinedText', { role: t(`tm.role.${joined.role}`) }) : t('tm.acceptText', { email: account?.user.email ?? '' })}</CardDescription></CardHeader>
        <CardContent className="grid gap-4">
          {!token && <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-900">{t('tm.noToken')}</p>}
          {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-900" data-testid="tm-accept-error">{error}</p>}
          {account && !account.user.twoFactorEnabled && !joined && <p className="rounded-xl bg-amber-soft p-4 text-sm text-amber-ink">{t('tm.need2fa')} <Link href="/settings?tab=security" className="font-bold underline">{t('tm.setup2fa')}</Link></p>}
          {joined ? (
            <div className="flex flex-wrap gap-3">
              <Button data-testid="tm-open" onClick={() => { setWorkspace(joined.workspaceId); window.location.assign('/dashboard'); }}>{t('tm.open')}</Button>
              <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>{t('tm.later')}</Link>
            </div>
          ) : <div><Button onClick={accept} loading={busy} disabled={!token} data-testid="tm-accept">{t('tm.accept')}</Button></div>}
        </CardContent>
      </Card>
    </>
  );
}

export default function AcceptPage() {
  return <Suspense><Accept /></Suspense>;
}
