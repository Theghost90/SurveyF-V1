'use client';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAccount } from '@/lib/account';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n/client';

/** Landing page after a PSP checkout. It never trusts the redirect: it asks the API, which re-verifies with the PSP. */
function Return() {
  const t = useT();
  const ref = useSearchParams().get('ref');
  const { mutate } = useAccount();
  const [status, setStatus] = useState<'pending' | 'success' | 'failed'>('pending');

  useEffect(() => {
    if (!ref) { setStatus('failed'); return; }
    let stop = false;
    (async () => {
      for (let i = 0; i < 40 && !stop; i++) {
        try {
          const tx = await api<{ status: string }>(`/payments/${ref}`);
          if (tx.status === 'success') { setStatus('success'); void mutate(); return; }
          if (tx.status === 'failed' || tx.status === 'expired') { setStatus('failed'); return; }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!stop) setStatus('failed');
    })();
    return () => { stop = true; };
  }, [ref, mutate]);

  return (
    <Card className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 p-10 text-center" role="status">
      {status === 'pending' && <><Loader2 className="h-10 w-10 animate-spin text-leaf" aria-hidden /><h1 className="text-2xl font-extrabold">{t('bill.verifying')}</h1><p className="text-muted-foreground">{t('bill.verifyingHelp')}</p></>}
      {status === 'success' && <><CheckCircle2 className="h-12 w-12 text-leaf" aria-hidden /><h1 className="text-2xl font-extrabold">{t('bill.paid')}</h1><p className="text-muted-foreground">{t('bill.paidHelp')}</p><Link href="/dashboard" className={buttonVariants({})}>{t('app.nav.dashboard')}</Link></>}
      {status === 'failed' && <><XCircle className="h-12 w-12 text-destructive" aria-hidden /><h1 className="text-2xl font-extrabold">{t('bill.notPaid')}</h1><p className="text-muted-foreground">{t('bill.payFailed')}</p><Link href="/billing" className={buttonVariants({})}>{t('common.retry')}</Link></>}
    </Card>
  );
}
export default function Page() { return <Suspense><Return /></Suspense>; }
