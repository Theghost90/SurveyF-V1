'use client';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSWRConfig } from 'swr';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAccount } from '@/lib/account';
import { failKey, watchPayment, type PayState } from '@/lib/pay-poll';
import { useT } from '@/lib/i18n/client';

/** Landing page after a PSP checkout. It never trusts the redirect: it asks the API, which re-verifies with the PSP. */
function Return() {
  const t = useT();
  const ref = useSearchParams().get('ref');
  const { mutate } = useAccount();
  const { mutate: mutateGlobal } = useSWRConfig();
  const [status, setStatus] = useState<'pending' | 'success' | 'failed'>('pending');
  const [wallet, setWallet] = useState(false);
  const [failCode, setFailCode] = useState<PayState['failCode']>(null);

  useEffect(() => {
    if (!ref) { setStatus('failed'); return; }
    return watchPayment(ref, {
      done: (tx) => {
        if (tx.status === 'success') { setWallet(tx.purpose === 'gift_topup'); setStatus('success'); void mutate(); void mutateGlobal('/wallet'); return; }
        setFailCode(tx.failCode); setStatus('failed');
      },
      timeout: () => setStatus('failed'),
    });
  }, [ref, mutate, mutateGlobal]);

  return (
    <Card className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 p-10 text-center" role="status">
      {status === 'pending' && <><Loader2 className="h-10 w-10 animate-spin text-leaf" aria-hidden /><h1 className="text-2xl font-extrabold">{t('bill.verifying')}</h1><p className="text-muted-foreground">{t('bill.verifyingHelp')}</p></>}
      {status === 'success' && <><CheckCircle2 className="h-12 w-12 text-leaf" aria-hidden /><h1 className="text-2xl font-extrabold">{wallet ? t('w.paid') : t('bill.paid')}</h1><p className="text-muted-foreground">{wallet ? t('w.paidHelp') : t('bill.paidHelp')}</p><Link href={wallet ? '/billing#wallet' : '/dashboard'} className={buttonVariants({})}>{wallet ? t('w.title') : t('app.nav.dashboard')}</Link></>}
      {status === 'failed' && <><XCircle className="h-12 w-12 text-destructive" aria-hidden /><h1 className="text-2xl font-extrabold">{t('bill.notPaid')}</h1><p className="text-muted-foreground">{t(failKey(failCode))}</p><Link href="/billing" className={buttonVariants({})}>{t('common.retry')}</Link></>}
    </Card>
  );
}
export default function Page() { return <Suspense><Return /></Suspense>; }
