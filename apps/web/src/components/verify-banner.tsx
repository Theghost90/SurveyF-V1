'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MailWarning } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { useAuthConfig } from '@/lib/auth-config';
import { useT } from '@/lib/i18n/client';

/** Until the address is confirmed the account is inert (no sending, paying or connecting): say so, and make the next step one click. */
export function VerifyBanner({ email }: { email: string }) {
  const t = useT();
  const router = useRouter();
  const config = useAuthConfig();
  const [busy, setBusy] = useState(false);
  async function resend() {
    setBusy(true);
    try {
      await api('/auth/verification/resend', { method: 'POST' });
      toast.success(t('vb.sent'));
      // On a demo instance nothing is e-mailed: the page that shows the message is the next step.
      if (config?.emailMode === 'demo') router.push(`/check-email?email=${encodeURIComponent(email)}`);
    } catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(false); }
  }
  return (
    <div role="status" data-testid="verify-banner" className="border-b border-amber/40 bg-amber-soft text-sm text-amber-ink">
      <div className="mx-auto flex max-w-[1344px] flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 sm:px-8">
        <MailWarning className="h-4 w-4 shrink-0" aria-hidden />
        <span className="font-medium">{t('vb.text', { email })}</span>
        <Button size="sm" variant="dark" className="ml-auto h-8 rounded-lg px-3 text-[13px]" loading={busy} onClick={resend}>{t('vb.resend')}</Button>
      </div>
    </div>
  );
}
