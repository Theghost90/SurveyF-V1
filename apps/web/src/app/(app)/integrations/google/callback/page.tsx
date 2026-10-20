'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';

function Callback() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // React strict mode double-invokes effects; an OAuth code is single-use
    ran.current = true;
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state || params.get('error')) { setError(params.get('error') ?? 'missing_code'); return; }
    api('/integrations/google/connect', { body: { code, state } })
      .then(() => {
        const back = sessionStorage.getItem('sf_google_return');
        sessionStorage.removeItem('sf_google_return');
        router.replace(back && back.startsWith('/') ? back : '/settings?tab=integrations');
      })
      .catch((err) => setError(errorMessage(err, t)));
  }, [params, router, t]);

  return (
    <Card className="mx-auto mt-16 max-w-md p-8 text-center">
      {error ? (<><p role="alert" className="mb-4 font-semibold text-destructive">{error}</p><Button onClick={() => router.replace('/settings?tab=integrations')}>{t('common.back')}</Button></>) : <p>{t('common.loading')}</p>}
    </Card>
  );
}
export default function Page() { return <Suspense><Callback /></Suspense>; }
