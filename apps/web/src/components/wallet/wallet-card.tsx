'use client';
import Link from 'next/link';
import { useState } from 'react';
import { AlertTriangle, Lock, Plus, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useWhatsAppGate } from '@/components/whatsapp-gate';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { currencyLabel } from '@surveyflow/shared';
import { dateTime, money, num } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import { TopupDialog } from './topup-dialog';
import { useWallet } from './use-wallet';

/** Billing-page wallet: balance, what is committed, why it moved. The owner — not SurveyFlow — funds participant gifts. */
export function WalletCard({ canUse, phone }: { canUse: boolean; phone: string }) {
  const t = useT();
  const locale = useLocale();
  const { wallet } = useWallet();
  const gate = useWhatsAppGate();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);

  return (
    <Card id="wallet" className="mb-8 scroll-mt-24">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Wallet className="h-5 w-5 text-leaf" aria-hidden />{t('w.title')}</CardTitle>
          <CardDescription className="max-w-2xl">{t('w.sub')}</CardDescription>
        </div>
        {canUse && wallet && <Button variant="brand" disabled={wallet.fxUnavailable} onClick={() => gate.require() && setOpen(true)}><Plus className="h-4 w-4" aria-hidden />{t('w.topup')}</Button>}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {!wallet ? <Skeleton className="h-24" /> : (
          <>
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <div>
                <p className="text-sm font-semibold text-body">{t('w.balance')}</p>
                <p className="font-display text-4xl font-extrabold tabular-nums tracking-tight" data-testid="wallet-balance">
                  {num(wallet.balance, locale)}<span className="ml-1.5 text-base font-semibold text-muted-foreground">{currencyLabel(wallet.currency)}</span>
                </p>
              </div>
              <div className="flex flex-wrap gap-2 pb-1.5">
                {wallet.inFlight.count > 0 && <Badge variant="neutral">{t('w.inFlight', { n: wallet.inFlight.count, amount: money(wallet.inFlight.amount, wallet.currency, locale) })}</Badge>}
                {wallet.unfunded.count > 0 && <Badge variant="warn">{t('w.unfunded', { n: wallet.unfunded.count, amount: money(wallet.unfunded.amount, wallet.currency, locale) })}</Badge>}
                {wallet.needsCheck.count > 0 && <Badge variant="danger">{t('w.needsCheck', { n: wallet.needsCheck.count, amount: money(wallet.needsCheck.amount, wallet.currency, locale) })}</Badge>}
              </div>
            </div>

            {wallet.fxUnavailable && <p role="status" className="rounded-xl bg-amber-soft px-4 py-3 text-sm text-amber-ink">{t('w.fxDown', { currency: currencyLabel(wallet.currency) })}</p>}
            {!canUse ? (
              <p className="flex items-center gap-2 rounded-xl bg-amber-soft px-4 py-3 text-sm text-amber-ink"><Lock className="h-4 w-4 shrink-0" aria-hidden />{t('w.locked')}</p>
            ) : (
              <p className="text-sm text-muted-foreground">{t('w.fee', { pct: wallet.feePercent })}</p>
            )}
            {wallet.needsCheck.count > 0 && (
              <p role="note" className="flex items-start gap-2 rounded-xl bg-amber-soft px-4 py-3 text-sm text-amber-ink"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{t('w.needsCheckHelp')}</p>
            )}

            <div>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wider text-muted-foreground">{t('w.history')}</h3>
              {wallet.entries.length === 0 ? (
                <p className="rounded-xl bg-canvas px-4 py-5 text-center text-sm text-muted-foreground">{t('w.noHistory')}</p>
              ) : (
                <>
                  <Table>
                    <THead><tr><TH>{t('w.col.date')}</TH><TH>{t('w.col.what')}</TH><TH className="text-right">{t('w.col.amount')}</TH><TH className="hidden text-right sm:table-cell">{t('w.col.balance')}</TH></tr></THead>
                    <TBody>
                      {(all ? wallet.entries : wallet.entries.slice(0, 6)).map((e) => (
                        <TR key={e.id}>
                          <TD className="whitespace-nowrap">{dateTime(e.at, locale)}</TD>
                          <TD><span className="font-semibold">{t(`w.kind.${e.kind}`)}</span>{e.note && <span className="ml-2 text-muted-foreground">{e.note}</span>}</TD>
                          <TD className={cn('whitespace-nowrap text-right font-semibold tabular-nums', e.delta > 0 ? 'text-leaf' : 'text-body')}>{e.delta > 0 ? '+' : '−'}{num(Math.abs(e.delta), locale)}</TD>
                          <TD className="hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell">{num(e.balanceAfter, locale)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                  {wallet.entries.length > 6 && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll((v) => !v)}>{all ? '−' : `+${wallet.entries.length - 6}`}</Button>}
                </>
              )}
            </div>
            {!canUse && <Link href="#plans" className="text-sm font-bold underline">{t('common.upgrade')}</Link>}
          </>
        )}
      </CardContent>
      {wallet && <TopupDialog open={open} onClose={() => setOpen(false)} wallet={wallet} defaultPhone={phone} />}
    </Card>
  );
}
