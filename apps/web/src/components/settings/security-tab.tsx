'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Copy, Download, KeyRound, Laptop, ShieldCheck, ShieldOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccount } from '@/lib/account';
import { ApiError, api, errorMessage } from '@/lib/api';
import { dateShort, dateTime } from '@/lib/format';
import type { TKey } from '@/lib/i18n';
import { useLocale, useT } from '@/lib/i18n/client';

interface Security { emailVerified: boolean; twoFactorEnabled: boolean; hasPassword: boolean; googleLinked: boolean; recoveryCodesLeft: number | null; passwordChangedAt: string | null; twoFactorRequired: boolean }
interface SessionRow { id: string; current: boolean; device: string; place: string | null; method: string; mfa: boolean; createdAt: string; lastUsedAt: string }
interface ActivityRow { id: string; at: string; action: string; place: string | null; meta: { rows?: number; kind?: string } | null }

export function SecurityTab() {
  const t = useT();
  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground">{t('sec.sub')}</p>
      <PasswordCard />
      <TwoFactorCard />
      <SessionsCard />
      <ActivityCard />
    </div>
  );
}

// ---- password ---------------------------------------------------------------------------------------------------------------------------

function PasswordCard() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { account } = useAccount();
  const { data, mutate } = useSWR<Security>('/auth/security');
  const [form, setForm] = useState({ current: '', next: '', repeat: '' });
  const [error, setError] = useState<{ field: 'current' | 'next' | 'repeat'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return <Skeleton className="h-56" />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.next !== form.repeat) return setError({ field: 'repeat', text: t('rp.mismatch') });
    setBusy(true); setError(null);
    try {
      await api('/auth/password/change', { body: { currentPassword: form.current, newPassword: form.next } });
      setForm({ current: '', next: '', repeat: '' });
      toast.success(t('sec.pw.done'));
      await mutate();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_credentials') setError({ field: 'current', text: t('sec.pw.wrongCurrent') });
      else setError({ field: 'next', text: errorMessage(err, t) });
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-leaf" aria-hidden />{t('sec.pw.title')}</CardTitle>
        {data.hasPassword && data.passwordChangedAt && <CardDescription>{t('sec.pw.last', { date: dateShort(data.passwordChangedAt, locale) })}</CardDescription>}
      </CardHeader>
      <CardContent>
        {data.hasPassword ? (
          <form onSubmit={submit} className="grid max-w-md gap-4" noValidate>
            <Field label={t('sec.pw.current')} htmlFor="pw-current" error={error?.field === 'current' ? error.text : null}>
              <Input id="pw-current" type="password" autoComplete="current-password" required value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} aria-invalid={error?.field === 'current'} />
            </Field>
            <Field label={t('sec.pw.new')} htmlFor="pw-new" hint={t('reg.rules')} error={error?.field === 'next' ? error.text : null}>
              <Input id="pw-new" type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} aria-invalid={error?.field === 'next'} />
            </Field>
            <Field label={t('sec.pw.repeat')} htmlFor="pw-repeat" error={error?.field === 'repeat' ? error.text : null}>
              <Input id="pw-repeat" type="password" autoComplete="new-password" required value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })} aria-invalid={error?.field === 'repeat'} />
            </Field>
            <div><Button type="submit" loading={busy} disabled={!form.current || form.next.length < 10}>{t('sec.pw.change')}</Button></div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="max-w-xl text-sm text-muted-foreground">{t('sec.pw.none')}</p>
            <Button variant="outline" onClick={() => router.push(`/forgot-password?email=${encodeURIComponent(account?.user.email ?? '')}`)}>{t('sec.pw.setByMail')}</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- two-step verification ----------------------------------------------------------------------------------------------------------------

/** Recovery codes: shown once, so the owner can copy them or keep them as a file. */
function RecoveryCodes({ codes }: { codes: string[] }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the codes stay on screen */ }
  }
  function save() {
    const url = URL.createObjectURL(new Blob([`SurveyFlow recovery codes\n\n${text}\n`], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'surveyflow-recovery-codes.txt' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }
  return (
    <div className="grid gap-3">
      <ul className="grid grid-cols-1 gap-1.5 rounded-xl bg-canvas p-4 font-mono text-sm sm:grid-cols-2" data-testid="recovery-codes">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={copy}><Copy className="h-4 w-4" aria-hidden />{copied ? t('sec.tf.copied') : t('sec.tf.copy')}</Button>
        <Button type="button" size="sm" variant="outline" onClick={save}><Download className="h-4 w-4" aria-hidden />.txt</Button>
      </div>
    </div>
  );
}

function EnableDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const t = useT();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSetup(null); setCode(''); setCodes(null); setSaved(false); setError(null);
    api<{ secret: string; qr: string }>('/auth/2fa/setup', { method: 'POST' }).then(setSetup).catch((err) => { toast.error(errorMessage(err, t)); onOpenChange(false); });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const r = await api<{ recoveryCodes: string[] }>('/auth/2fa/enable', { body: { code: code.trim() } }); setCodes(r.recoveryCodes); }
    catch (err) { setError(errorMessage(err, t)); }
    finally { setBusy(false); }
  }
  function finish() { onDone(); onOpenChange(false); toast.success(t('sec.tf.onDone')); }

  return (
    // Until the codes are saved the dialog cannot be dismissed by a stray click: they are never shown again.
    <Dialog open={open} onOpenChange={(o) => { if (!o && codes && !saved) return; onOpenChange(o); }}>
      <DialogContent closeLabel={t('common.close')} onInteractOutside={(e) => { if (codes && !saved) e.preventDefault(); }}>
        {!codes ? (
          <>
            <DialogHeader><DialogTitle>{t('sec.tf.title')}</DialogTitle><DialogDescription>{t('sec.tf.sub')}</DialogDescription></DialogHeader>
            {!setup ? <Skeleton className="h-48" /> : (
              <form onSubmit={verify} className="grid gap-4" noValidate>
                <p className="text-sm font-semibold">{t('sec.tf.step1')}</p>
                <div className="flex flex-wrap items-center gap-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={setup.qr} alt="QR code" width={160} height={160} className="rounded-xl border border-line bg-white p-1" />
                  <div className="min-w-0 text-sm"><p className="text-muted-foreground">{t('sec.tf.orKey')}</p><p className="mt-1 break-all font-mono font-semibold" data-testid="totp-secret">{setup.secret}</p></div>
                </div>
                <p className="text-sm font-semibold">{t('sec.tf.step2')}</p>
                <Field label={t('su.code')} htmlFor="tf-code" error={error}>
                  <Input id="tf-code" autoFocus required inputMode="numeric" autoComplete="one-time-code" maxLength={8} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={!!error} />
                </Field>
                <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button><Button type="submit" loading={busy} disabled={code.replace(/\s/g, '').length < 6}>{t('sec.tf.verify')}</Button></DialogFooter>
              </form>
            )}
          </>
        ) : (
          <>
            <DialogHeader><DialogTitle>{t('sec.tf.codesTitle')}</DialogTitle><DialogDescription>{t('sec.tf.codesText')}</DialogDescription></DialogHeader>
            <RecoveryCodes codes={codes} />
            <label className="flex items-center gap-2.5 text-sm font-semibold"><Checkbox checked={saved} onCheckedChange={(v) => setSaved(v === true)} />{t('sec.tf.saved')}</label>
            <DialogFooter><Button disabled={!saved} onClick={finish}>{t('sec.done')}</Button></DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CodeDialog({ open, onOpenChange, title, text, withPassword, submitLabel, destructive, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; text: string; withPassword: boolean; submitLabel: string; destructive?: boolean;
  onSubmit: (v: { code: string; password: string }) => Promise<void>;
}) {
  const t = useT();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setCode(''); setPassword(''); setError(null); } }, [open]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await onSubmit({ code: code.trim(), password }); }
    catch (err) { setError(err instanceof ApiError && (err.code === 'invalid_credentials') ? t('sec.pw.wrongCurrent') : errorMessage(err, t)); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{text}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          {withPassword && <Field label={t('su.passwordLabel')} htmlFor="cd-password"><Input id="cd-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>}
          <Field label={t('su.code')} htmlFor="cd-code" error={error}><Input id="cd-code" autoFocus required autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={!!error} /></Field>
          <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button><Button type="submit" variant={destructive ? 'destructive' : 'default'} loading={busy} disabled={!code.trim() || (withPassword && !password)}>{submitLabel}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TwoFactorCard() {
  const t = useT();
  const { data, mutate } = useSWR<Security>('/auth/security');
  const [enable, setEnable] = useState(false);
  const [disable, setDisable] = useState(false);
  const [regen, setRegen] = useState(false);
  const [fresh, setFresh] = useState<string[] | null>(null);
  if (!data) return <Skeleton className="h-40" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {data.twoFactorEnabled ? <ShieldCheck className="h-5 w-5 text-leaf" aria-hidden /> : <ShieldOff className="h-5 w-5 text-muted-foreground" aria-hidden />}
          {t('sec.tf.title')}
          <Badge variant={data.twoFactorEnabled ? 'brand' : 'neutral'} data-testid="tf-status">{data.twoFactorEnabled ? t('sec.tf.on') : t('sec.tf.off')}</Badge>
        </CardTitle>
        <CardDescription>{t('sec.tf.sub')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {data.twoFactorRequired && <p role="status" className="rounded-xl bg-amber-soft px-4 py-3 text-sm font-medium text-amber-ink">{t('sec.tf.required')}</p>}
        {data.twoFactorEnabled ? (
          <>
            <p className={`text-sm ${(data.recoveryCodesLeft ?? 0) <= 2 ? 'font-semibold text-amber-ink' : 'text-muted-foreground'}`}>
              {(data.recoveryCodesLeft ?? 0) <= 2 ? t('sec.tf.leftLow', { n: data.recoveryCodesLeft ?? 0 }) : t('sec.tf.left', { n: data.recoveryCodesLeft ?? 0 })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setRegen(true)}>{t('sec.tf.newCodes')}</Button>
              <Button variant="outline" onClick={() => setDisable(true)}>{t('sec.tf.disable')}</Button>
            </div>
          </>
        ) : (
          <div><Button onClick={() => setEnable(true)} data-testid="tf-enable">{t('sec.tf.enable')}</Button></div>
        )}
      </CardContent>

      <EnableDialog open={enable} onOpenChange={setEnable} onDone={() => void mutate()} />
      <CodeDialog
        open={disable} onOpenChange={setDisable} title={t('sec.tf.offTitle')} text={t('sec.tf.offText')} withPassword={data.hasPassword} submitLabel={t('sec.tf.disable')} destructive
        onSubmit={async ({ code, password }) => { await api('/auth/2fa/disable', { body: { code, ...(data.hasPassword ? { password } : {}) } }); setDisable(false); toast.success(t('sec.tf.offDone')); await mutate(); }}
      />
      <CodeDialog
        open={regen} onOpenChange={setRegen} title={t('sec.tf.newCodes')} text={t('sec.tf.newCodesText')} withPassword={false} submitLabel={t('sec.tf.newCodes')}
        onSubmit={async ({ code }) => { const r = await api<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { body: { code } }); setRegen(false); setFresh(r.recoveryCodes); await mutate(); }}
      />
      <Dialog open={!!fresh} onOpenChange={(o) => { if (!o) setFresh(null); }}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader><DialogTitle>{t('sec.tf.codesTitle')}</DialogTitle><DialogDescription>{t('sec.tf.codesText')}</DialogDescription></DialogHeader>
          {fresh && <RecoveryCodes codes={fresh} />}
          <DialogFooter><Button onClick={() => setFresh(null)}>{t('sec.done')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---- sessions ---------------------------------------------------------------------------------------------------------------------------

function ago(d: string, locale: string): string {
  const mins = Math.round((new Date(d).getTime() - Date.now()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale === 'fr' ? 'fr' : 'en', { numeric: 'auto' });
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
  if (Math.abs(mins) < 60 * 24) return rtf.format(Math.round(mins / 60), 'hour');
  return rtf.format(Math.round(mins / 1440), 'day');
}

function SessionsCard() {
  const t = useT();
  const locale = useLocale();
  const { data, mutate } = useSWR<{ items: SessionRow[] }>('/auth/sessions');
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return <Skeleton className="h-40" />;

  async function end(id: string) {
    setBusy(id);
    try { await api(`/auth/sessions/${id}`, { method: 'DELETE' }); await mutate(); } catch (err) { toast.error(errorMessage(err, t)); } finally { setBusy(null); }
  }
  async function endMany(scope: 'others' | 'all') {
    setBusy(scope);
    try {
      const r = await api<{ revoked: number }>('/auth/sessions/revoke-all', { body: { scope } });
      if (scope === 'all') { window.location.href = '/login'; return; }
      toast.success(t('sec.ses.done', { n: r.revoked }));
      await mutate();
    } catch (err) { toast.error(errorMessage(err, t)); } finally { setBusy(null); }
  }
  const others = data.items.filter((s) => !s.current).length;

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Laptop className="h-5 w-5 text-leaf" aria-hidden />{t('sec.ses.title')}</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        <ul className="divide-y divide-line rounded-xl border border-line" data-testid="sessions">
          {data.items.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-semibold">{s.device}{s.current && <Badge variant="brand">{t('sec.ses.this')}</Badge>}{s.mfa && <ShieldCheck className="h-4 w-4 text-leaf" aria-label={t('sec.tf.title')} />}</p>
                <p className="text-xs text-muted-foreground">{[s.place, t(`sec.ses.method.${s.method === 'google' ? 'google' : 'password'}`), t('sec.ses.active', { when: ago(s.lastUsedAt, locale) }), dateTime(s.createdAt, locale)].filter(Boolean).join(' · ')}</p>
              </div>
              {!s.current && <Button size="sm" variant="outline" loading={busy === s.id} onClick={() => end(s.id)}>{t('sec.ses.signOut')}</Button>}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          {others > 0 && <Button variant="outline" loading={busy === 'others'} onClick={() => endMany('others')}>{t('sec.ses.others')}</Button>}
          <Button variant="outline" loading={busy === 'all'} onClick={() => endMany('all')} title={t('sec.ses.allText')}>{t('sec.ses.all')}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---- recent activity --------------------------------------------------------------------------------------------------------------------

function ActivityCard() {
  const t = useT();
  const locale = useLocale();
  const { data } = useSWR<{ items: ActivityRow[] }>('/auth/activity');
  if (!data) return <Skeleton className="h-40" />;
  const label = (a: ActivityRow) => {
    const key = `sec.act.${a.action}` as TKey;
    const base = t(key) !== key ? t(key) : a.action;
    return typeof a.meta?.rows === 'number' ? `${base} · ${t('sec.act.rows', { n: a.meta.rows })}` : base;
  };
  return (
    <Card>
      <CardHeader><CardTitle>{t('sec.act.title')}</CardTitle></CardHeader>
      <CardContent>
        {data.items.length === 0 ? <p className="text-sm text-muted-foreground">{t('sec.act.none')}</p> : (
          <ul className="divide-y divide-line rounded-xl border border-line" data-testid="activity">
            {data.items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2.5 text-sm">
                <span className="font-medium">{label(a)}</span>
                <span className="text-xs text-muted-foreground">{[a.place, dateTime(a.at, locale)].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
