'use client';
import { useState } from 'react';
import { mutate as globalMutate } from 'swr';
import { CreditCard, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { api, errorMessage } from '@/lib/api';
import { useOwnerCountry } from '@/lib/geo-context';
import { currencyLabel, formatPhone } from '@surveyflow/shared';
import { money, num } from '@/lib/format';
import { failKey, watchPayment } from '@/lib/pay-poll';
import { StillPending } from '@/components/billing/payment-states';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import type { WalletData } from './use-wallet';

/**
 * Wallet top-up checkout. Same payment layer as plans: the server fixes the currency and validates the amount, and the
 * balance is credited only after the PSP confirms the money (the return page asks the API, never trusts the redirect).
 */
export function TopupDialog({ open, onClose, wallet, defaultPhone }: { open: boolean; onClose: () => void; wallet: WalletData; defaultPhone: string }) {
  const t = useT();
  const locale = useLocale();
  // The dialog is only opened while the wallet has limits (exchange rate available); the fallback keeps types simple.
  const { topupMin: min, topupMax: max, presets } = wallet.limits ?? { topupMin: 0, topupMax: 0, presets: [] as number[] };
  const label = currencyLabel(wallet.currency);
  const [amount, setAmount] = useState(String(presets[1] ?? presets[0] ?? ''));
  const [method, setMethod] = useState<'mobile_money' | 'card'>(wallet.methods[0] ?? 'card');
  const { example } = useOwnerCountry();
  const [phone, setPhone] = useState(formatPhone(defaultPhone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState<{ id: string; reference: string } | null>(null);

  const n = Number(amount);
  const valid = Number.isInteger(n) && n >= min && n <= max;

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const tx = await api<{ id: string; reference: string; checkoutUrl: string | null }>('/wallet/topup', { method: 'POST', body: { amount: n, method, phone: method === 'mobile_money' ? phone : undefined } });
      if (tx.checkoutUrl) { window.location.href = tx.checkoutUrl; return; }
      setPending(true);
      watch(tx.id, tx.reference);
    } catch (err) {
      setError(errorMessage(err, t));
      setBusy(false);
      void globalMutate('/payments'); // an unconfirmed start leaves a pending payment: show it under "Payments in progress" now
    }
  }
  function watch(id: string, reference: string) {
    watchPayment(id, {
      done: (s) => {
        if (s.status === 'success') { window.location.href = `/billing/return?ref=${id}`; return; }
        setPending(false); setWaiting(null); setBusy(false);
        setError(s.status === 'review' ? t('bill.reviewHelp', { ref: reference }) : s.status === 'expired' ? t('bill.expiredHelp') : t(failKey(s.failCode)));
      },
      // Not decided yet is not "failed": the customer may approve in a minute, or already did.
      timeout: () => { setPending(false); setWaiting({ id, reference }); setBusy(false); },
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader>
          <DialogTitle>{t('w.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('w.dialogSub', { currency: label })}</DialogDescription>
        </DialogHeader>
        {waiting ? (
          <StillPending reference={waiting.reference} onClose={onClose} onCheckAgain={() => { const w = waiting; setWaiting(null); setPending(true); watch(w.id, w.reference); }} />
        ) : pending ? (
          <div role="status" className="flex flex-col items-center gap-3 py-6 text-center">
            <Smartphone className="h-10 w-10 text-leaf" aria-hidden />
            <p className="font-display text-xl font-bold">{t('bill.approve')}</p>
            <p className="text-sm text-muted-foreground">{t('bill.approveHelp', { phone })}</p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t('w.amount', { currency: label })}>
              {presets.map((p) => (
                <button key={p} type="button" aria-pressed={n === p} onClick={() => setAmount(String(p))} className={cn('min-h-[40px] rounded-full border px-4 text-sm font-semibold tabular-nums', n === p ? 'border-leaf bg-mint text-ink' : 'border-line-2 text-body hover:bg-canvas')}>
                  {num(p, locale)}
                </button>
              ))}
            </div>
            <Field label={t('w.amount', { currency: label })} htmlFor="topup-amount" hint={t('w.amountHint', { min: money(min, wallet.currency, locale), max: money(max, wallet.currency, locale) })} error={amount && !valid ? t('w.amountHint', { min: money(min, wallet.currency, locale), max: money(max, wallet.currency, locale) }) : undefined}>
              <Input id="topup-amount" type="number" inputMode="numeric" min={min} max={max} step={Math.max(1, Math.round(min / 4))} value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!amount && !valid} />
            </Field>
            <RadioGroup value={method} onValueChange={(v) => setMethod(v as typeof method)} aria-label={t('bill.method')}>
              {wallet.methods.includes('mobile_money') && <label className={cn('flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3.5 font-medium', method === 'mobile_money' ? 'border-leaf bg-mint/40' : 'border-line')}><RadioGroupItem value="mobile_money" /><Smartphone className="h-5 w-5 text-leaf" aria-hidden />{t('bill.momo')}</label>}
              <label className={cn('flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3.5 font-medium', method === 'card' ? 'border-leaf bg-mint/40' : 'border-line')}><RadioGroupItem value="card" /><CreditCard className="h-5 w-5 text-leaf" aria-hidden />{t('bill.card')}</label>
            </RadioGroup>
            {method === 'mobile_money' && <Field label={t('bill.momoPhone')} htmlFor="topup-phone" hint={t('bill.momoHint')}><Input id="topup-phone" type="tel" placeholder={example} value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" /></Field>}
            {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
              <Button size="lg" variant="brand" loading={busy} disabled={!valid} onClick={pay}>{t('w.pay', { amount: valid ? money(n, wallet.currency, locale) : '…' })}</Button>
            </DialogFooter>
            <p className="text-xs text-muted-foreground">{t('w.refundNote')}</p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
