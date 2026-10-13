'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';

/** Demo PSP checkout (PSP_MOCK=true). No money moves; it exercises the real verification + activation path. */
function MockCheckout() {
  const t = useT();
  const router = useRouter();
  const ref = useSearchParams().get('ref');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function finish(outcome: 'success' | 'failed') {
    setBusy(outcome);
    try { await api(`/payments/mock/${ref}`, { body: { outcome } }); router.replace(`/billing/return?ref=${ref}`); }
    catch (err) { setError(errorMessage(err, t)); setBusy(null); }
  }
  return (
    <Card className="mx-auto mt-10 flex max-w-md flex-col gap-4 p-8">
      <div className="flex items-center gap-2 text-amber-ink"><FlaskConical className="h-5 w-5" aria-hidden /><span className="text-sm font-bold uppercase tracking-wider">{t('common.demoOnly')}</span></div>
      <h1 className="text-2xl font-extrabold">{t('bill.mockTitle')}</h1>
      <p className="text-muted-foreground">{t('bill.mockText')}</p>
      <code className="rounded-lg bg-canvas px-3 py-2 text-xs">{ref}</code>
      {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
      <div className="flex gap-3"><Button variant="brand" className="flex-1" loading={busy === 'success'} onClick={() => finish('success')}>{t('bill.mockPay')}</Button><Button variant="outline" className="flex-1" loading={busy === 'failed'} onClick={() => finish('failed')}>{t('bill.mockFail')}</Button></div>
    </Card>
  );
}
export default function Page() { return <Suspense><MockCheckout /></Suspense>; }
