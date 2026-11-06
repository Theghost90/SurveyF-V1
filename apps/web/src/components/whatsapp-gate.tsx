'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAccount } from '@/lib/account';
import { WHATSAPP_REQUIRED_EVENT } from '@/lib/api';
import { useT } from '@/lib/i18n/client';

/**
 * Creating surveys, adding contacts, sending and topping up all need the owner's WhatsApp Business number. When it is not connected
 * the answer is always the same one screen: what is missing, one button to connect it, and a way out.
 */
export function WhatsAppRequiredDialog() {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(WHATSAPP_REQUIRED_EVENT, on);
    return () => window.removeEventListener(WHATSAPP_REQUIRED_EVENT, on);
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent closeLabel={t('common.close')} data-testid="wa-required">
        <DialogHeader>
          <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-2xl bg-mint"><Smartphone className="h-6 w-6 text-leaf" aria-hidden /></div>
          <DialogTitle>{t('wa.req.title')}</DialogTitle>
          <DialogDescription>{t('wa.req.text')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t('wa.req.later')}</Button>
          <Button variant="brand" onClick={() => { setOpen(false); router.push('/onboarding'); }}>{t('wa.req.cta')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** `require()` is true when the number is connected; otherwise it opens the connect screen and returns false. */
export function useWhatsAppGate() {
  const { account } = useAccount();
  const connected = account?.onboarding.whatsappConnected ?? true; // unknown yet: let the server decide (it enforces the rule anyway)
  const require = useCallback(() => {
    if (connected) return true;
    window.dispatchEvent(new CustomEvent(WHATSAPP_REQUIRED_EVENT));
    return false;
  }, [connected]);
  return { connected, require };
}
