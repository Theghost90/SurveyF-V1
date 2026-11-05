'use client';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Copy, Link2, MessageCircle, RefreshCw } from 'lucide-react';
import { shareDeepLink, shareMessage } from '@surveyflow/shared';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { dateShort } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';

interface Join {
  title: string; lang: string; enabled: boolean; code: string | null; expiresAt: string | null; max: number | null; countries: string[]; gifts: boolean; giftMax: number | null;
  joined: number; completed: number; giftsGiven: number; link: string | null; qr: string | null; live: boolean;
}

/**
 * The join link of a survey (WA-05, WA-06): a WhatsApp link and a QR code that open the owner's own number with the join words typed. Off until switched on; ends by itself;
 * the owner sets how many people, from which countries, and whether people who join this way may win the gift (off by default).
 */
export function JoinLinkCard({ surveyId, hasGift }: { surveyId: string; hasGift: boolean }) {
  const t = useT();
  const locale = useLocale();
  const { data, mutate } = useSWR<Join>(`/surveys/${surveyId}/join`);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState('30');
  const [max, setMax] = useState('');
  const [countries, setCountries] = useState('');
  const [giftMax, setGiftMax] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!data) return;
    setMax(data.max?.toString() ?? '');
    setCountries(data.countries.join(', '));
    setGiftMax(data.giftMax?.toString() ?? '');
  }, [data?.max, data?.countries?.join(','), data?.giftMax]); // eslint-disable-line react-hooks/exhaustive-deps

  async function put(body: Record<string, unknown>, ok?: string) {
    setBusy(true);
    try {
      const next = await api<Join>(`/surveys/${surveyId}/join`, { method: 'PUT', body });
      await mutate(next, { revalidate: false });
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }
  const limits = () => ({
    expiresInDays: days.trim() ? Math.max(1, Math.min(365, Number(days) || 30)) : null,
    max: max.trim() ? Math.max(1, Number(max) || 1) : null,
    countries: countries.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
    ...(hasGift ? { giftMax: giftMax.trim() ? Math.max(1, Number(giftMax) || 1) : null } : {}),
  });

  if (!data) return null;
  return (
    <Card data-testid="join-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg"><Link2 className="h-5 w-5 text-leaf" aria-hidden />{t('jn.title')}</CardTitle>
        <CardDescription>{t('jn.sub')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!data.live && <p className="rounded-xl bg-canvas px-4 py-3 text-sm text-body" role="status">{t('jn.publishFirst')}</p>}
        {!data.enabled ? (
          <div><Button data-testid="join-on" disabled={busy || !data.live} onClick={() => put({ enabled: true })}>{t('jn.off')}</Button></div>
        ) : (
          <>
            {data.link ? (
              <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
                {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL made by the API: there is nothing for the image optimiser to do */}
                {data.qr && <img src={data.qr} alt={t('jn.qr')} width={160} height={160} className="rounded-xl border border-line bg-white p-1" data-testid="join-qr" />}
                <div className="flex min-w-0 flex-col gap-2">
                  <label className="text-sm font-semibold" htmlFor="join-link">{t('jn.link')}</label>
                  <div className="flex gap-2">
                    <Input id="join-link" readOnly value={data.link} data-testid="join-link" onFocus={(e) => e.currentTarget.select()} />
                    <Button type="button" variant="outline" onClick={async () => { await navigator.clipboard?.writeText(data.link!).catch(() => undefined); setCopied(true); setTimeout(() => setCopied(false), 1500); }}><Copy className="h-4 w-4" aria-hidden />{copied ? t('jn.copied') : t('jn.copy')}</Button>
                  </div>
                  {(() => {
                    // WA-14: the easiest way to hand the survey out, from the owner's phone: WhatsApp's own picker with the message filled in, or the same text to paste.
                    const msg = shareMessage(data.lang === 'en' ? 'en' : 'fr', data.title, data.link!);
                    return (
                      <div className="flex flex-wrap gap-2" data-testid="share-kit">
                        <a href={shareDeepLink(msg)} target="_blank" rel="noopener noreferrer" data-testid="share-wa" className="inline-flex h-10 items-center gap-2 rounded-xl bg-leaf px-4 text-sm font-semibold text-white hover:opacity-90"><MessageCircle className="h-4 w-4" aria-hidden />{t('jn.share')}</a>
                        <Button type="button" variant="outline" data-testid="share-copy" onClick={async () => { await navigator.clipboard?.writeText(msg).catch(() => undefined); toast.success(t('jn.copied')); }}><Copy className="h-4 w-4" aria-hidden />{t('jn.copyMsg')}</Button>
                      </div>
                    );
                  })()}
                  <p className="text-xs text-muted-foreground">{t('jn.shareHint')}</p>
                  <p className="text-sm text-muted-foreground">{data.expiresAt ? t('jn.expires', { date: dateShort(data.expiresAt, locale) }) : t('jn.never')} · {t('jn.stats', { joined: data.joined, completed: data.completed })}</p>
                </div>
              </div>
            ) : <p className="rounded-xl bg-amber-soft p-3 text-sm text-amber-ink" role="status">{t('jn.noNumber')}</p>}

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm font-semibold">{t('jn.days')}<Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} data-testid="join-days" /></label>
              <label className="flex flex-col gap-1 text-sm font-semibold">{t('jn.max')}<Input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} data-testid="join-max" /></label>
              <label className="flex flex-col gap-1 text-sm font-semibold">{t('jn.countries')}<Input value={countries} onChange={(e) => setCountries(e.target.value)} data-testid="join-countries" /></label>
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">{t('jn.maxHint')} {t('jn.countriesHint')}</p>

            <div className="flex flex-col gap-2 rounded-xl border border-line p-4">
              <label className="flex items-center gap-3 text-sm font-semibold">
                <Checkbox checked={data.gifts} disabled={busy || !hasGift} onCheckedChange={(v) => put({ gifts: !!v })} data-testid="join-gifts" />{t('jn.gifts')}
              </label>
              <p className="text-xs text-muted-foreground">{hasGift ? t('jn.giftsOff') : t('jn.noGiftOnSurvey')}</p>
              {hasGift && data.gifts && (
                <label className="flex flex-col gap-1 text-sm font-semibold">{t('jn.giftMax')}<Input inputMode="numeric" value={giftMax} onChange={(e) => setGiftMax(e.target.value)} className="max-w-[10rem]" data-testid="join-giftmax" />
                  <span className="text-xs font-normal text-muted-foreground">{t('jn.giftsGiven', { n: data.giftsGiven })}</span></label>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => put(limits(), t('jn.saved'))} data-testid="join-save">{t('jn.save')}</Button>
              <Button variant="outline" disabled={busy} onClick={() => put({ rotate: true })} data-testid="join-rotate"><RefreshCw className="h-4 w-4" aria-hidden />{t('jn.rotate')}</Button>
              <Button variant="outline" disabled={busy} onClick={() => put({ enabled: false })} data-testid="join-off">{t('jn.turnOff')}</Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('jn.rotateHint')}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
