'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { TWO_FACTOR_REQUIRED_EVENT, api, errorMessage, setStepUpHandler } from '@/lib/api';
import { useT } from '@/lib/i18n/client';

type Method = 'totp' | 'password' | 'email_code';
interface Pending { method: Method; resolve: (ok: boolean) => void }

/**
 * "Confirm it is you". Any call the API answers with `step_up_required` (a large download, deleting many contacts) lands here: the owner proves who they are
 * with whatever they have (authenticator code, else password, else a code e-mailed to them) and the call is repeated. Also the notice that a plan requires
 * two-step verification before such calls.
 */
export function StepUpHost() {
  const t = useT();
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [needTwoFactor, setNeedTwoFactor] = useState(false);
  const current = useRef<Pending | null>(null);
  current.current = pending;

  useEffect(() => {
    setStepUpHandler((methods) => new Promise<boolean>((resolve) => {
      current.current?.resolve(false);
      setSecret(''); setError(null); setSent(false);
      setPending({ method: (methods[0] as Method) ?? 'password', resolve });
    }));
    const onTwoFactor = () => setNeedTwoFactor(true);
    window.addEventListener(TWO_FACTOR_REQUIRED_EVENT, onTwoFactor);
    return () => { setStepUpHandler(null); window.removeEventListener(TWO_FACTOR_REQUIRED_EVENT, onTwoFactor); };
  }, []);

  const close = (ok: boolean) => { pending?.resolve(ok); setPending(null); setSecret(''); };

  async function sendCode() {
    setBusy(true); setError(null);
    try { await api('/auth/step-up/email-code', { method: 'POST' }); setSent(true); toast.success(t('su.sent')); }
    catch (err) { setError(errorMessage(err, t)); }
    finally { setBusy(false); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setBusy(true); setError(null);
    try {
      await api('/auth/step-up', { body: { method: pending.method, secret: secret.trim() } });
      close(true);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally { setBusy(false); }
  }

  return (
    <>
      <Dialog open={!!pending} onOpenChange={(o) => { if (!o) close(false); }}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('su.title')}</DialogTitle>
            <DialogDescription>{t('su.why')}</DialogDescription>
          </DialogHeader>
          {pending && (
            <form onSubmit={submit} className="grid gap-4" noValidate>
              <p className="text-sm">{pending.method === 'totp' ? t('su.totp') : pending.method === 'password' ? t('su.password') : t('su.email')}</p>
              {pending.method === 'email_code' && !sent ? (
                <Button type="button" loading={busy} onClick={sendCode}>{t('su.send')}</Button>
              ) : (
                <Field label={pending.method === 'password' ? t('su.passwordLabel') : t('su.code')} htmlFor="su-secret" error={error}>
                  <Input
                    id="su-secret" autoFocus required value={secret} onChange={(e) => setSecret(e.target.value)} aria-invalid={!!error}
                    type={pending.method === 'password' ? 'password' : 'text'} autoComplete={pending.method === 'password' ? 'current-password' : 'one-time-code'}
                    inputMode={pending.method === 'password' ? undefined : 'numeric'}
                  />
                </Field>
              )}
              {error && pending.method === 'email_code' && !sent && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => close(false)}>{t('common.cancel')}</Button>
                {(pending.method !== 'email_code' || sent) && <Button type="submit" loading={busy} disabled={!secret.trim()}>{t('su.confirm')}</Button>}
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={needTwoFactor} onOpenChange={setNeedTwoFactor}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('tf.title')}</DialogTitle>
            <DialogDescription>{t('tf.text')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNeedTwoFactor(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => { setNeedTwoFactor(false); router.push('/settings?tab=security'); }}>{t('tf.go')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
